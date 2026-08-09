import { ARSENAL_DEFS, ARSENAL_ORDER } from './defs.js';
import { buildArsenalModel } from './models/build.js';
import { HardwareRig } from './hardware/rig.js';
import { defaultLoadout } from './attachments.js';
import { buildRecoilPattern } from '../weapons/defs.js';
import { Rng } from '../core/rng.js';

/**
 * ARSENAL - the bridge between the kit and the match.
 *
 * Everything under src/arsenal/ was, until this file existed, a kit nobody
 * called: nine finished weapons, five attachment slots and a workbench that
 * could all be previewed and none of which the player could ever hold. The
 * weapon subsystem built its own three guns in init() and that was that.
 *
 * This subsystem closes the loop, and it does it by REGISTERING rather than
 * replacing:
 *
 *   1. each arsenal model goes through the same `viewmodel.addWeapon` the base
 *      guns go through, so the animation clips, the support-hand fit, the shell
 *      port and the sight axis are solved by the code that already solves them;
 *   2. each weapon gets a HardwareRig parented to its own viewmodel group, so
 *      optics, cans, torches and lasers hang off that gun and hide with it;
 *   3. the three base guns then leave the roster - with nine real weapons in the
 *      same slots, keeping them would only make Tab cycle through twelve.
 *
 * The board talks to us over the event bus (`shell:loadout`), never by reaching
 * in, and `weapons.applyLoadout` is installed here so the shell's optional call
 * finds a home.
 */

/** Built by the base weapon system; superseded by the arsenal. */
const BASE_IDS = ['rifle', 'smg', 'pistol'];

/** Digit 1 / 2 / 3, by arsenal slot. */
const DIGIT_SLOTS = ['rifle', 'special', 'pistol'];

/** What the player spawns with before touching the board. */
const START = { rifle: 'akm', special: 'mp5', pistol: 'glock18' };

/**
 * Raw key this system owns directly. The light and laser used to live here too,
 * but they are player-facing verbs and now go through ACTIONS in core/input so a
 * controls screen and rebinding can see them.
 */
const KEY_BOARD = 'KeyM';

export class ArsenalSystem {
  static id = 'arsenal';
  static deps = ['weapons', 'ui'];

  constructor() {
    /** weaponId -> HardwareRig */
    this.rigs = new Map();
    /** what digits 1..3 draw, in DIGIT_SLOTS order */
    this.slotIds = [START.rifle, START.special, START.pistol];
    this._off = [];
    this.stats = { weapons: 0, tris: 0 };
  }

  async init(ctx) {
    this.ctx = ctx;
    const wp = ctx.get('weapons');
    this.weapons = wp;

    const t0 = performance.now();
    const materialFor = (key) => wp.mats.get(key);
    const shell = ctx.peek('shell');
    let tris = 0;

    for (const id of ARSENAL_ORDER) {
      const def = { ...ARSENAL_DEFS[id] };
      // The base system derives this in its own loop; the viewmodel clips and the
      // rate limiter both read it, and a missing value fires once and stops.
      def.cycleTime = 60 / def.rpm;

      const model = buildArsenalModel(id);
      const entry = wp.viewmodel.addWeapon(model, def);
      tris += entry.tris;

      wp.states.set(id, {
        def,
        pattern: buildRecoilPattern(def, Rng),
        mag: def.magSize,
        chambered: true,
        reserve: def.reserve,
        mode: def.modes[0],
        modeIndex: 0,
      });

      const rig = new HardwareRig({ weaponId: id, root: entry.group, material: materialFor }).bind(def);
      rig.setLoadout(shell?.loadoutFor?.(id) ?? defaultLoadout(def));
      this.rigs.set(id, rig);
    }

    // Draw an arsenal weapon BEFORE the base ones leave the roster, so the switch
    // never passes through an id that no longer resolves.
    wp.setWeaponImmediate(this.slotIds[0]);
    for (const id of BASE_IDS) wp.states.delete(id);

    wp.slotIds = this.slotIds;
    wp.applyLoadout = (weaponId, loadout) => this.applyLoadout(weaponId, loadout);
    // The engine needs the mounted build's resolved numbers at fire time (how loud
    // the shot is, whether it is suppressed) but must not import arsenal - the
    // dependency only ever points this way. So hand it an accessor, same as
    // applyLoadout above. Without arsenal registered the engine just defaults to a
    // bare, full-volume shot.
    wp.resolvedStats = () => this.activeRig()?.stats() ?? null;
    // Same trick for the aiming eye position. rig.sightAxis() has always returned
    // the mounted optic's optical axis and nothing ever called it, so the ADS
    // solve kept using the weapon's iron-sight node - a mounted scope aimed at
    // iron height instead of through its own glass. Null means no optic, and the
    // viewmodel falls back to the irons.
    wp.sightPoint = () => this.activeRig()?.sightAxis() ?? null;
    /**
     * And the same for the reticle. The viewmodel's collimated dot used to be
     * driven by a scope welded into the weapon body, so it drew the same dot at
     * the same aperture whatever was on the rail — including when the rail was
     * empty. Now it asks the mounted unit.
     */
    wp.viewmodel.opticProvider = () => this.activeRig()?.opticGlass() ?? null;

    this._off.push(
      ctx.events.on('shell:loadout', (e) => this.applyLoadout(e?.weaponId, e?.loadout))
    );

    this.stats = { weapons: this.rigs.size, tris };
    console.info(
      '[arsenal] ' + this.rigs.size + ' weapons + hardware rigs \u00b7 ' +
        (tris / 1000).toFixed(1) + 'k tris \u00b7 built in ' +
        (performance.now() - t0).toFixed(0) + 'ms'
    );
  }

  /* ------------------------------------------------------------------ public */

  /** Mount a build and make that weapon the one its digit draws. */
  applyLoadout(weaponId, loadout) {
    const rig = this.rigs.get(weaponId);
    if (!rig || !loadout) return false;
    rig.setLoadout(loadout);
    // A new build can be a new barrel, and barrel length is what sets muzzle
    // velocity. The engine memoises that per weapon for the fire path, so the
    // memo has to be told the geometry moved — otherwise a swapped barrel would
    // look different and shoot identically.
    this.weapons?.resetBallisticsCache?.();
    const slot = ARSENAL_DEFS[weaponId]?.slot;
    const i = DIGIT_SLOTS.indexOf(slot);
    if (i >= 0) {
      this.slotIds[i] = weaponId;
      this.weapons.slotIds = this.slotIds;
    }
    return true;
  }

  /** The rig on the weapon currently in the player's hands, or null. */
  activeRig() {
    return this.rigs.get(this.weapons?.activeId) ?? null;
  }

  loadouts() {
    const out = {};
    for (const [id, rig] of this.rigs) out[id] = rig.loadout();
    return out;
  }

  /* ------------------------------------------------------------------- frame */

  update(dt, ctx) {
    const input = ctx.input;
    if (input?.pressed?.(KEY_BOARD)) ctx.peek('shell')?.openGunsmith?.();

    const rig = this.activeRig();
    if (!rig) return;
    // Ask by ACTION, not by raw key code. `pressed()` bypasses the ACTIONS map
    // entirely, which is why the declared `flashlight` binding sat dead while a
    // hardcoded KeyN did the real work - and why neither could ever appear in a
    // controls screen or be rebound. Everything else (reload, use, melee,
    // grenade) already goes through this layer; these two now match.
    if (input?.actionPressed?.('flashlight')) rig.toggleLight();
    if (input?.actionPressed?.('laser')) rig.toggleLaser();
    rig.update(dt, this.weapons?.adsProgress ?? 0);
  }

  dispose() {
    for (const off of this._off) off?.();
    this._off.length = 0;
    for (const rig of this.rigs.values()) rig.dispose();
    this.rigs.clear();
    if (this.weapons) {
      delete this.weapons.applyLoadout;
      delete this.weapons.slotIds;
      delete this.weapons.resolvedStats;
      delete this.weapons.sightPoint;
      if (this.weapons.viewmodel) this.weapons.viewmodel.opticProvider = null;
    }
  }
}
