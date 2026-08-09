import {
  ATTACHMENTS,
  BY_SLOT,
  SLOT_ORDER,
  SLOT_LABELS,
  canMount,
  defaultLoadout,
  resolveStats,
  statDelta,
} from '../arsenal/attachments.js';
import { ARSENAL_DEFS, ARSENAL_ORDER, SLOTS, weaponsInSlot } from '../arsenal/defs.js';
import {
  PACK,
  availability,
  carryPositionFor,
  defaultKit,
  validateKit,
  withWeapon,
  withoutWeapon,
} from '../arsenal/rules.js';
import { el, setText, setStyle, setClass, clamp, clamp01, damp, ease } from '../ui/util.js';
import { installGunsmithStyles, removeGunsmithStyles } from './style.js';

/**
 * SHELL / gunsmith board — "доска с оружием".
 *
 * Three columns: the rack (what you carry), the gun itself on a turntable, and
 * the slot being worked on. Every number in the right-hand column comes from
 * `statDelta`/`resolveStats` — the same functions the ballistics path uses — so
 * the board cannot drift from what the weapon actually does. There is no second
 * table of "display stats" to forget to update.
 *
 * Incompatible parts are shown and explained rather than hidden: a player who
 * cannot find the PSO on an M416 assumes the game is broken, whereas one who
 * reads "нужен боковой кронштейн" has learnt a rule about the weapon.
 *
 * Ownership: this class owns DOM only. The 3D gun belongs to BenchPreview, and
 * the decision to actually equip the loadout belongs to whoever passed onApply.
 */

const SLOT_KEYS = ['1', '2', '3', '4', '5'];

/** Format a stat for the delta column: metres, seconds, degrees or a count. */
function fmt(stat, v) {
  switch (stat) {
    case 'adsTime':
    case 'reloadTac':
      return `${v.toFixed(2)} с`;
    case 'muzzleVelocity':
      return `${Math.round(v)} м/с`;
    case 'weight':
      return `${v.toFixed(2)} кг`;
    case 'magSize':
      return String(Math.round(v));
    case 'damage':
      return String(Math.round(v));
    default:
      return v.toFixed(3);
  }
}

export class GunsmithScreen {
  /**
   * @param {HTMLElement} parent
   * @param {object} o
   * @param {import('./preview.js').BenchPreview} o.preview
   * @param {(weaponId: string, loadout: object) => void} [o.onApply]
   * @param {() => void} [o.onClose]
   */
  constructor(parent, o) {
    installGunsmithStyles();
    this.preview = o.preview;
    this.onApply = o.onApply ?? null;
    this.onCloseCb = o.onClose ?? null;

    this.root = el('div', 'fa-gs', parent);
    this.open = false;
    this.shown = 0;
    this.weaponId = ARSENAL_ORDER[0];
    this.slot = 'optic';
    /** weaponId -> loadout, so each gun remembers its own build. */
    this.loadouts = new Map();
    /** What the player is taking into the match. See arsenal/rules.js. */
    this.kit = defaultKit();
    /** Set by the owner so a carry change can reach the arsenal. */
    this.onKit = o.onKit ?? null;
    this._rectAge = 1;
    this._rect = null;

    this.#buildHead();
    this.#buildBody();
    this.#buildFoot();

    this._onKey = (e) => this.#onKey(e);
    this._onResize = () => {
      this._rect = null;
    };

    setStyle(this.root, 'display', 'none');
  }

  /* ----------------------------------------------------------------- build */

  #buildHead() {
    const head = el('div', 'head', this.root);
    const left = el('div', null, head);
    el('div', 'eyebrow', left, 'ВЕРСТАК · ОРУЖЕЙНАЯ');
    el('h2', null, left, 'ДОСКА ОРУЖИЯ');
    this.headHint = el('div', 'hint', head, 'ТЯНИ МЫШЬЮ — ОСМОТРЕТЬ СТВОЛ');
  }

  #buildBody() {
    const body = el('div', 'body', this.root);

    /**
     * ---- column 1: the rack, and WHAT YOU ARE TAKING ----------------------
     *
     * The rack used to be a list of nine weapons where clicking one selected it
     * for inspection — and that was the whole interaction, because the player
     * carried all nine regardless. Now the rack has two jobs, and they have to
     * stay visibly separate or the board becomes a guessing game:
     *
     *   the NAME    selects the weapon to look at and work on
     *   the CHECK   adds it to the kit, or takes it out
     *
     * Above the list is the pack meter. It is not decoration: the whole point of
     * a carry limit is that the player can see it filling before they hit it, and
     * a limit discovered only by refusal is indistinguishable from a bug.
     */
    const rack = el('div', 'col', body);
    el('div', 'col-title', rack, 'СНАРЯЖЕНИЕ');
    this.packBox = el('div', 'pack', rack);
    const massRow = el('div', 'pack-row', this.packBox);
    el('div', 'pack-lbl', massRow, 'МАССА');
    this.packMassVal = el('div', 'pack-val', massRow, '');
    this.packMassBar = el('i', null, el('div', 'pack-bar', this.packBox));
    const volRow = el('div', 'pack-row', this.packBox);
    el('div', 'pack-lbl', volRow, 'ОБЪЁМ');
    this.packVolVal = el('div', 'pack-val', volRow, '');
    this.packVolBar = el('i', null, el('div', 'pack-bar', this.packBox));
    this.packWhy = el('div', 'pack-why', this.packBox, '');

    el('div', 'col-title', rack, 'СТВОЛЫ');
    const rackScroll = el('div', 'scroll', rack);
    this.rackButtons = new Map();
    this.rackChecks = new Map();
    for (const slot of SLOTS) {
      const list = weaponsInSlot(slot);
      if (!list.length) continue;
      el('div', 'col-title', rackScroll, slot === 'pistol' ? 'ПИСТОЛЕТ' : slot === 'rifle' ? 'ОСНОВНОЕ' : 'ОСОБОЕ');
      // weaponsInSlot() returns IDS, not defs — look each one up.
      for (const id of list) {
        const def = ARSENAL_DEFS[id];
        if (!def) continue;
        const row = el('div', 'rack-row', rackScroll);
        // The take/leave control. A checkbox rather than a second click on the
        // name, because "look at" and "carry" are different intentions and one
        // control for two intentions is how a player ends up carrying a shotgun
        // they only wanted to read the stats of.
        const take = el('button', 'rack-take', row);
        take.type = 'button';
        take.title = 'Взять с собой';
        take.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleCarry(id);
        });
        this.rackChecks.set(id, take);

        const b = el('button', 'rack-item', row);
        b.type = 'button';
        el('span', null, b, def.label ?? id);
        el('span', 'kl', b, def.rpm ? `${def.rpm}` : '');
        b.addEventListener('click', () => this.selectWeapon(id));
        this.rackButtons.set(id, b);
      }
    }

    // ---- column 2: the gun -------------------------------------------------
    const stage = el('div', 'col', body);
    this.stage = el('div', 'stage', stage);
    this.warn = el('div', 'warn', this.stage, '');
    const plate = el('div', 'plate', this.stage);
    this.stageName = el('div', 'name', plate, '');
    this.stageSub = el('div', 'sub', plate, '');
    // The drag hint lives in the header (headHint) and nowhere else. A second
    // copy used to sit bottom-right of the stage, absolutely positioned at the
    // same `bottom` as the plate; in a 304px-wide panel the stats line ran
    // straight underneath it and rendered as "3.60LMB — ВРАЩЕНИЕ". Two absolute
    // boxes on one baseline cannot push each other apart, so the duplicate is
    // gone rather than relocated into the next collision.

    // Drag to inspect. Pointer events only while the board is open, and the
    // pointer id is tracked so a drag that leaves the panel still works.
    this.stage.addEventListener('pointerdown', (e) => {
      this.stage.setPointerCapture?.(e.pointerId);
      this.preview.beginDrag();
      this._lastX = e.clientX;
      this._lastY = e.clientY;
    });
    this.stage.addEventListener('pointermove', (e) => {
      if (!this.preview.dragging) return;
      this.preview.drag(e.clientX - this._lastX, e.clientY - this._lastY);
      this._lastX = e.clientX;
      this._lastY = e.clientY;
    });
    const stop = () => this.preview.endDrag();
    this.stage.addEventListener('pointerup', stop);
    this.stage.addEventListener('pointercancel', stop);
    this.stage.addEventListener('pointerleave', stop);

    // ---- column 3: slots + parts + stats -----------------------------------
    const right = el('div', 'col', body);
    el('div', 'col-title', right, 'МОДУЛИ');
    const tabs = el('div', 'slot-tabs', right);
    this.slotTabs = new Map();
    SLOT_ORDER.forEach((slot, i) => {
      const t = el('button', 'slot-tab', tabs, `${SLOT_KEYS[i]} ${SLOT_LABELS[slot]}`);
      t.type = 'button';
      t.addEventListener('click', () => this.selectSlot(slot));
      this.slotTabs.set(slot, t);
    });
    this.attList = el('div', 'scroll', right);
    el('div', 'col-title', right, 'ИЗМЕНЕНИЯ');
    this.statList = el('div', null, right);
  }

  #buildFoot() {
    const foot = el('div', 'foot', this.root);
    const keys = el('div', 'keys', foot);
    el('div', null, keys, '').innerHTML = '<b>1–5</b> СЛОТ';
    el('div', null, keys, '').innerHTML = '<b>↑↓</b> СТВОЛ';
    el('div', null, keys, '').innerHTML = '<b>R</b> СБРОС';
    el('div', null, keys, '').innerHTML = '<b>ESC</b> ЗАКРЫТЬ';
    const acts = el('div', 'acts', foot);
    const reset = el('button', 'btn', acts, 'Сбросить');
    reset.type = 'button';
    reset.addEventListener('click', () => this.reset());
    this.applyBtn = el('button', 'btn primary', acts, 'В бой');
    this.applyBtn.type = 'button';
    this.applyBtn.addEventListener('click', () => this.apply());
  }

  /* ----------------------------------------------------------------- state */

  def() {
    return ARSENAL_DEFS[this.weaponId];
  }

  loadout() {
    let l = this.loadouts.get(this.weaponId);
    if (!l) {
      l = defaultLoadout(this.def());
      this.loadouts.set(this.weaponId, l);
    }
    return l;
  }

  selectWeapon(id) {
    if (!ARSENAL_DEFS[id]) return;
    this.weaponId = id;
    const def = this.def();
    this.preview.setWeapon(def);
    this.preview.setLoadout(this.loadout());
    // Land on a slot this weapon actually has.
    if (!this.#slotAvailable(this.slot)) {
      this.slot = SLOT_ORDER.find((s) => this.#slotAvailable(s)) ?? 'optic';
    }
    this.refresh();
  }

  selectSlot(slot) {
    this.slot = slot;
    this.refresh();
  }

  #slotAvailable(slot) {
    const mounts = this.def()?.mounts;
    return Array.isArray(mounts) ? mounts.includes(slot) : true;
  }

  /** Mount (or take off, when the same part is clicked again) one attachment. */
  toggle(attId) {
    const att = ATTACHMENTS[attId];
    if (!att) return;
    const loadout = { ...this.loadout() };
    const isOn = loadout[att.slot] === attId;

    if (isOn && att.detachable === false) return; // irons never come off
    if (isOn) {
      // Optics fall back to irons rather than leaving a bare rail with no sight.
      loadout[att.slot] = att.slot === 'optic' ? 'iron' : null;
    } else {
      if (!canMount(this.def(), attId).ok) return;
      loadout[att.slot] = attId;
    }
    this.loadouts.set(this.weaponId, loadout);
    this.preview.setLoadout(loadout);
    this.refresh();
  }

  /**
   * Take a weapon, or leave it behind.
   *
   * `withWeapon` returns a NEW kit and reports what it had to displace, so a
   * second rifle is a SWAP rather than a refusal — that is what a player means
   * when they click one. A refusal that cannot be acted on is a dead end, and the
   * reason is shown next to the meter instead of being swallowed.
   */
  toggleCarry(id) {
    const carried = this.kit.weapons.includes(id);
    const r = carried ? withoutWeapon(this.kit, id) : withWeapon(this.kit, id);
    if (!r.ok) {
      this._kitWhy = r.reason;
      this.refresh();
      return false;
    }
    this._kitWhy = r.displaces
      ? `${ARSENAL_DEFS[r.displaces].label} \u2192 на стойку: ремень один.`
      : '';
    this.kit = r.kit;
    // Look at what you just picked up: taking a weapon is a statement of intent
    // about which gun you are working on.
    if (!carried) this.selectWeapon(id);
    else this.refresh();
    this.onKit?.({ ...this.kit, weapons: [...this.kit.weapons] });
    return true;
  }

  reset() {
    const l = defaultLoadout(this.def());
    this.loadouts.set(this.weaponId, l);
    this.preview.setLoadout(l);
    this.refresh();
  }

  apply() {
    /**
     * Committing sends BOTH: the build on the weapon in view, and the kit.
     *
     * Sending only the loadout was correct while the player carried everything.
     * Now the kit is the more important of the two — it decides what goes into
     * the match at all — and it has to be validated once more here, because the
     * board's own state can be edited into an illegal shape (mount a suppressor
     * on everything and the mass goes up after the kit was chosen).
     */
    const loadouts = {};
    for (const [id, l] of this.loadouts) loadouts[id] = l;
    const kit = { ...this.kit, loadouts };
    const v = validateKit(kit);
    if (!v.ok) {
      this._kitWhy = v.reason;
      this.refresh();
      return false;
    }
    this.onKit?.(kit);
    this.onApply?.(this.weaponId, { ...this.loadout() });
    this.close();
    return true;
  }

  /* ------------------------------------------------------------------ paint */

  /** Full repaint. Called on state change only — never from update(). */
  refresh() {
    const def = this.def();
    const loadout = this.loadout();
    const stats = resolveStats(def, loadout);

    for (const [id, b] of this.rackButtons) setClass(b, 'on', id === this.weaponId);
    this.#paintCarry();

    setText(this.stageName, def.label ?? def.id);
    setText(
      this.stageSub,
      `${Math.round(stats.damage)} УРОН · ${def.rpm} В/М · ${stats.magSize} ПАТР · ${stats.weight.toFixed(2)} КГ`
    );

    const issues = this.preview.issues();
    setText(this.warn, issues.length ? issues.join(' · ') : '');
    setStyle(this.warn, 'display', issues.length ? '' : 'none');

    for (const [slot, tab] of this.slotTabs) {
      const available = this.#slotAvailable(slot);
      setClass(tab, 'on', slot === this.slot);
      setClass(tab, 'filled', !!loadout[slot] && loadout[slot] !== 'iron');
      setStyle(tab, 'display', available ? '' : 'none');
    }

    this.#paintAttachments(def, loadout);
    this.#paintStats(def, loadout);
  }

  /**
   * The pack meter and the take/leave state of every weapon in the rack.
   *
   * `availability` answers, per weapon, whether it can be added and what it would
   * displace — so an unavailable weapon is shown with its REASON on the tooltip
   * rather than hidden. A player who cannot find where the second rifle went
   * assumes the game is broken; one who reads "ремень один" has learnt a rule.
   */
  #paintCarry() {
    // The attachments the player has actually chosen change the mass, so the
    // accounting is done against the live loadouts, not against factory builds.
    const loadouts = {};
    for (const [id, l] of this.loadouts) loadouts[id] = l;
    const kit = { ...this.kit, loadouts };
    const v = validateKit(kit);

    const massFrac = clamp01(v.kg / v.limitKg);
    const volFrac = clamp01(v.litres / v.limitLitres);
    setText(this.packMassVal, `${v.kg.toFixed(1)} / ${v.limitKg} кг`);
    setText(this.packVolVal, `${v.litres.toFixed(1)} / ${v.limitLitres} л`);
    setStyle(this.packMassBar, 'width', `${(massFrac * 100).toFixed(1)}%`);
    setStyle(this.packVolBar, 'width', `${(volFrac * 100).toFixed(1)}%`);
    setClass(this.packMassBar, 'over', massFrac > 0.999);
    setClass(this.packVolBar, 'over', volFrac > 0.999);
    setClass(this.packMassBar, 'tight', massFrac > 0.85 && massFrac <= 0.999);
    setClass(this.packVolBar, 'tight', volFrac > 0.85 && volFrac <= 0.999);

    const why = this._kitWhy || v.reason || '';
    setText(this.packWhy, why);
    setStyle(this.packWhy, 'display', why ? '' : 'none');
    setClass(this.packWhy, 'bad', !v.ok);

    for (const a of availability(kit)) {
      const take = this.rackChecks.get(a.id);
      if (!take) continue;
      setClass(take, 'on', a.carried);
      setClass(take, 'blocked', !a.carried && !a.ok);
      take.title = a.carried
        ? 'Оставить на стойке'
        : a.ok
          ? a.displaces
            ? `Взять вместо ${ARSENAL_DEFS[a.displaces].label}`
            : 'Взять с собой'
          : (a.reason ?? 'Не влезает');
    }
    // The carried weapons are also marked on the name, so the kit is legible
    // without hovering anything.
    for (const [id, b] of this.rackButtons) setClass(b, 'carried', this.kit.weapons.includes(id));
  }

  #paintAttachments(def, loadout) {
    this.attList.textContent = '';
    if (!this.#slotAvailable(this.slot)) {
      el('div', 'stat-empty', this.attList, 'У этого ствола нет такого крепления.');
      return;
    }
    for (const id of BY_SLOT[this.slot] ?? []) {
      const att = ATTACHMENTS[id];
      const check = canMount(def, id);
      const b = el('button', 'att', this.attList);
      b.type = 'button';
      el('span', null, b, att.label ?? id);
      const note = el('span', 'note', b, att.note ?? '');
      setClass(b, 'on', loadout[this.slot] === id);
      if (!check.ok) {
        setClass(b, 'locked', true);
        b.disabled = true;
        note.classList.add('why');
        setText(note, check.reason ?? 'Не встаёт на это оружие.');
      } else {
        b.addEventListener('click', () => this.toggle(id));
      }
    }
  }

  #paintStats(def, loadout) {
    this.statList.textContent = '';
    const rows = statDelta(def, loadout);
    if (!rows.length) {
      el('div', 'stat-empty', this.statList, 'Заводская комплектация — без изменений.');
      return;
    }
    for (const row of rows) {
      const wrap = el('div', 'stat', this.statList);
      el('div', 'sl', wrap, row.label);
      const v = el('div', `sv ${row.better ? 'up' : 'down'}`, wrap);
      const sign = row.to > row.from ? '+' : '−';
      const pct = Math.abs((row.to - row.from) / (row.from || 1)) * 100;
      setText(v, `${fmt(row.stat, row.to)}  ${sign}${pct.toFixed(0)}%`);
      const bar = el('div', 'bar', wrap);
      const fillEl = el('i', row.better ? 'up' : 'down', bar);
      setStyle(fillEl, 'width', `${clamp01(pct / 60) * 100}%`);
    }
  }

  /* ------------------------------------------------------------------ input */

  #onKey(e) {
    if (!this.open) return;
    const i = SLOT_KEYS.indexOf(e.key);
    if (i >= 0) {
      const slot = SLOT_ORDER[i];
      if (this.#slotAvailable(slot)) this.selectSlot(slot);
      e.preventDefault();
      return;
    }
    if (e.code === 'Escape') {
      this.close();
      e.preventDefault();
    } else if (e.code === 'KeyR') {
      this.reset();
    } else if (e.code === 'Enter') {
      this.apply();
    } else if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
      const order = ARSENAL_ORDER;
      const at = order.indexOf(this.weaponId);
      const step = e.code === 'ArrowDown' ? 1 : -1;
      this.selectWeapon(order[(at + step + order.length) % order.length]);
      e.preventDefault();
    }
  }

  /* ------------------------------------------------------------- open/close */

  show(weaponId = null) {
    if (this.open) return;
    this.open = true;
    setStyle(this.root, 'display', '');
    setStyle(this.root, 'pointer-events', 'auto');
    this._rect = null;
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('resize', this._onResize);
    this.selectWeapon(weaponId && ARSENAL_DEFS[weaponId] ? weaponId : this.weaponId);
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.preview.endDrag();
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('resize', this._onResize);
    setStyle(this.root, 'pointer-events', 'none');
    this.onCloseCb?.();
  }

  /** Viewport scale, matching the HUD's --k convention. */
  resize(vh) {
    setStyle(this.root, '--k', String(clamp(vh / 1080, 0.62, 2.2)));
    this._rect = null;
  }

  /**
   * Unscaled dt — the board runs with the game clock stopped.
   * The 3D panel rect is measured at most a few times a second, because
   * getBoundingClientRect() forces layout and this runs every frame.
   */
  update(rawDt) {
    this.shown = damp(this.shown, this.open ? 1 : 0, 15, rawDt);
    if (this.shown < 0.004) {
      setStyle(this.root, 'display', 'none');
      return;
    }
    setStyle(this.root, 'opacity', ease.outQuad(this.shown).toFixed(3));

    this._rectAge += rawDt;
    if (!this._rect || this._rectAge > 0.25) {
      this._rect = this.stage.getBoundingClientRect();
      this._rectAge = 0;
    }
    this.preview.update(rawDt);
  }

  /** Called from the render phase, after the world composite. */
  render() {
    if (this.shown < 0.004 || !this._rect) return;
    this.preview.render(this._rect);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('resize', this._onResize);
    this.root.remove();
    removeGunsmithStyles();
  }
}
