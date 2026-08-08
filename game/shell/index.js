import * as THREE from 'three';
import { BenchPreview } from './preview.js';
import { GunsmithScreen } from './screen.js';
import { WeaponBench } from './bench.js';
import { ARSENAL_DEFS, ARSENAL_ORDER } from '../arsenal/defs.js';
import { defaultLoadout } from '../arsenal/attachments.js';

/**
 * ===========================================================================
 * SHELL subsystem — menus, the gunsmith board, match screens
 * ===========================================================================
 *
 * Step 4 scope: the armoury bench in the world plus the gunsmith board it
 * opens. Later steps hang the mode-select screen and the scoreboard off the
 * same subsystem.
 *
 * PUBLIC API — `const shell = ctx.get('shell')`
 *   shell.openGunsmith(weaponId?)   open the board (pauses the match)
 *   shell.closeGunsmith()
 *   shell.loadoutFor(weaponId)      the player's current build for one weapon
 *   shell.loadouts()                every build, for the net layer to send
 *
 * Events emitted: `shell:gunsmith` {open}, `shell:loadout` {weaponId, loadout}.
 */

/** Where the bench stands. Overridable from config once maps are data-driven. */
const BENCH_POSITION = [6.2, 0, -4.4];
const BENCH_ROTATION = -0.42;

/** Must match `--bg` in shell/style.js: the canvas now paints the board's base. */
const BOARD_BG = 0x0b0e13;

/**
 * Fallback materials for the standalone harness.
 *
 * In game the preview borrows the weapon material bank, so the gun on the board
 * is shaded by exactly the same materials as the gun in the player's hands. With
 * no `weapons` subsystem present (unit harness, model preview tool) we still
 * need *something*, and a plain grey would hide every modelling error the board
 * exists to show.
 */
const FALLBACK = {
  alu: [0x8d949c, 0.42, 0.9],
  alu_fine: [0x9aa1a9, 0.34, 0.92],
  steel: [0x6e757d, 0.36, 0.95],
  steel_bright: [0xb9c0c8, 0.22, 0.98],
  steel_soot: [0x30343a, 0.62, 0.78],
  cavity: [0x0a0c0f, 0.95, 0.0],
  polymer: [0x2b2f33, 0.72, 0.06],
  polymer_tan: [0x8a7a5c, 0.74, 0.05],
  rubber: [0x1d1f22, 0.9, 0.02],
  brass: [0xb08d3f, 0.34, 0.95],
  glass: [0x223044, 0.08, 0.4],
  optic_tube: [0x3a3f45, 0.4, 0.88],
};

export class ShellSystem {
  static id = 'shell';
  static deps = ['render', 'ui'];

  /**
   * The loadout table is built HERE, not in init(), and that placement is a bug
   * fix rather than a style choice.
   *
   * `arsenal` and `shell` point at each other on purpose: the board edits rigs
   * that arsenal owns, and arsenal wants the saved build for each weapon. Making
   * that a declared dependency in either direction would be a cycle the registry
   * cannot sort, so both sides reach across with `ctx.peek()` instead — a lookup
   * that deliberately returns a system whether or not it has been initialised.
   *
   * Which means `arsenal.init()` can legitimately run first and call
   * `shell.loadoutFor(id)` on a shell that has not initialised yet. When this
   * map only existed after init(), that call threw
   * `Cannot read properties of undefined (reading 'get')`, aborting engine.init()
   * — the whole subsystem never came up and the board never appeared.
   *
   * These are plain data defaults with no renderer or DOM involved, so there is
   * nothing to gain by deferring them, and correctness to gain by not.
   */
  constructor() {
    /** weaponId -> loadout the player has committed to. */
    this._loadouts = new Map();
    for (const id of ARSENAL_ORDER) this._loadouts.set(id, defaultLoadout(ARSENAL_DEFS[id]));
    this._fallbacks = new Map();
    this._ownedMaterials = [];
  }

  async init(ctx) {
    this.ctx = ctx;

    const render = ctx.get('render');
    this.render = render;
    const weapons = ctx.peek('weapons');
    this.materialFor = (key) => weapons?.mats?.get(key) ?? this.#fallbackMaterial(key);

    this.preview = new BenchPreview({ renderer: render.renderer, material: this.materialFor });

    const host = document.getElementById('ui') ?? document.body;
    this.screen = new GunsmithScreen(host, {
      preview: this.preview,
      onApply: (weaponId, loadout) => this.#equip(weaponId, loadout),
      onClose: () => this.#resumeMatch(),
    });

    this.bench = new WeaponBench({
      scene: ctx.scene,
      position: BENCH_POSITION,
      rotationY: BENCH_ROTATION,
    });

    /**
     * THE RENDER HOOK.
     *
     * The engine calls `render()` on the render system only — no other subsystem
     * gets a render phase — and the preview must land AFTER the world composite
     * or the tonemap pass overwrites it. A post pass is the wrong tool: those are
     * required to write a full-screen result into a target, and this draws a real
     * perspective camera into one scissored rectangle.
     *
     * So the call is chained explicitly, and put back in dispose(). Reversible
     * and visible beats a hidden global.
     */
    this._originalRender = render.render.bind(render);
    /**
     * The board's DOM root is `position:fixed; inset:0` with an OPAQUE background,
     * and the canvas lives behind it - so the gun was being drawn correctly into
     * its scissored rectangle and then painted over by the overlay. `.stage` is
     * `background:transparent`, but a transparent child only reveals its parent's
     * background, never an element below the whole overlay. That is why the middle
     * of the board was empty.
     *
     * So the overlay is transparent now (see shell/style.js) and the base colour
     * comes from the canvas instead: while the board is up the world is skipped
     * entirely and the frame is cleared to the board's own `--bg`. The world is
     * frozen and completely hidden at that moment, so drawing it was wasted work
     * anyway - this makes the board cheaper, not just visible.
     *
     * The clear colour is saved and restored because the world pass does not set
     * its own every frame, and leaking this one would tint the sky on resume.
     */
    this._boardClear = new THREE.Color(BOARD_BG);
    this._prevClear = new THREE.Color();
    render.render = (c) => {
      if (this.screen.open) {
        const r = render.renderer;
        r.getClearColor(this._prevClear);
        const prevAlpha = r.getClearAlpha();
        r.setRenderTarget(null);
        r.setScissorTest(false);
        r.setClearColor(this._boardClear, 1);
        r.clear(true, true, false);
        r.setClearColor(this._prevClear, prevAlpha);
      } else {
        this._originalRender(c);
      }
      this.screen.render();
    };

    this.screen.resize(window.innerHeight || 1080);
    this._paused = false;
    this._last = performance.now();
  }

  #fallbackMaterial(key) {
    let m = this._fallbacks.get(key);
    if (m) return m;
    const [color, roughness, metalness] = FALLBACK[key] ?? [0x808890, 0.5, 0.5];
    m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    if (key === 'glass') {
      m.transparent = true;
      m.opacity = 0.34;
    }
    this._fallbacks.set(key, m);
    this._ownedMaterials.push(m);
    return m;
  }

  /* ------------------------------------------------------------------ public */

  loadoutFor(weaponId) {
    return { ...(this._loadouts.get(weaponId) ?? {}) };
  }

  loadouts() {
    return Object.fromEntries([...this._loadouts].map(([k, v]) => [k, { ...v }]));
  }

  openGunsmith(weaponId = null) {
    if (this.screen.open) return;
    const ctx = this.ctx;
    const held = weaponId ?? this.#heldWeaponId();

    // Freeze the match, hand the mouse back, get the HUD out of the way.
    // Owner-keyed freeze, not a private save/restore of the shared scale: the
    // pause menu freezes the same clock and the two can overlap.
    ctx.time?.freeze('gunsmith');
    this._paused = true;
    document.exitPointerLock?.();
    const ui = ctx.peek('ui');
    /**
     * Losing the lock mid-match is normally intent to pause, so ui/index.js has a
     * watchdog that opens the pause menu when the lock goes away. This board drops
     * the lock DELIBERATELY, and the watchdog could not tell the difference: it
     * opened the pause menu over the board one frame later and froze the clock a
     * second time under its own key. `#resumeMatch` only thaws 'gunsmith', so that
     * second freeze was never lifted and pressing В БОЙ left the match stopped
     * forever - the "game won't load" symptom.
     *
     * The watchdog re-arms only once the lock is genuinely held again, which cannot
     * happen while the board is up, so one disarm here is enough.
     */
    ui?.disarmPointerLockWatchdog?.();
    // And stop a left click from silently re-grabbing the lock, which hid the
    // cursor the moment the player reached for a button.
    if (ctx.input) ctx.input.lockSuppressed = true;
    ctx.peek('player')?.setControlEnabled?.(false);
    ui?.clearPrompt?.();
    ui?.setHudVisible?.(false);

    this.screen.show(held);
    ctx.events?.emit?.('shell:gunsmith', { open: true });
  }

  closeGunsmith() {
    this.screen.close();
  }

  #resumeMatch() {
    const ctx = this.ctx;
    if (!this._paused) return;
    this._paused = false;
    ctx.time?.thaw('gunsmith');
    ctx.peek('player')?.setControlEnabled?.(true);
    ctx.peek('ui')?.setHudVisible?.(true);
    // Hand the mouse back before asking for the lock again, and disarm once more:
    // Chrome often refuses a lock requested this soon after leaving one, and an
    // un-granted lock reads to the watchdog as a fresh loss - the same bounce the
    // pause menu documents at ui/menu.js close().
    if (ctx.input) ctx.input.lockSuppressed = false;
    ctx.peek('ui')?.disarmPointerLockWatchdog?.();
    ctx.input?.requestPointerLock?.();
    ctx.events?.emit?.('shell:gunsmith', { open: false });
  }

  #heldWeaponId() {
    const held = this.ctx.peek('weapons')?.getHudState?.()?.id;
    return held && ARSENAL_DEFS[held] ? held : ARSENAL_ORDER[0];
  }

  /**
   * Commit a build. The weapon subsystem is told through the event bus rather
   * than reached into, so the shell keeps working when the arsenal is rebuilt.
   */
  #equip(weaponId, loadout) {
    this._loadouts.set(weaponId, { ...loadout });
    this.ctx.events?.emit?.('shell:loadout', { weaponId, loadout: { ...loadout } });
    const weapons = this.ctx.peek('weapons');
    weapons?.applyLoadout?.(weaponId, { ...loadout });
    weapons?.setWeapon?.(weaponId);
  }

  /* ------------------------------------------------------------------- frame */

  resize(w, h) {
    this.screen.resize(h || window.innerHeight || 1080);
  }

  update(dt, ctx) {
    // The board must keep animating with the game clock at zero, so its own
    // clock is unscaled wall time rather than the frame's dt.
    const now = performance.now();
    const rawDt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;

    if (!this.screen.open) {
      const player = ctx.peek('player');
      const pos = player?.getHudState?.()?.position ?? player?.position ?? null;
      const prox = this.bench.proximity(pos);
      const ui = ctx.peek('ui');
      if (prox.near) {
        ui?.setPrompt?.({
          key: 'F',
          text: 'ДОСКА ОРУЖИЯ',
          sub: 'Нас��роить обвес',
        });
        if (ctx.input?.pressed?.('KeyF')) this.openGunsmith();
      } else if (prox.left) {
        ui?.clearPrompt?.();
      }
    }

    this.screen.update(rawDt);
  }

  dispose() {
    // Put the render call back before anything else: a half-disposed screen must
    // never be reachable from the render phase.
    if (this._originalRender && this.render) {
      this.render.render = this._originalRender;
      this._originalRender = null;
    }
    this.screen?.dispose();
    this.preview?.dispose();
    this.bench?.dispose();
    for (const m of this._ownedMaterials) m.dispose();
    this._ownedMaterials.length = 0;
    this._fallbacks.clear();
    this._loadouts.clear();
  }
}
