import { el, setText, setStyle, clamp, damp, ease } from './util.js';

const PRESETS = ['low', 'medium', 'high', 'ultra'];

/** Player-facing labels. The ids above stay English because config.setQuality
 *  and the ?q= query parameter speak them; only the caption is translated. */
const PRESET_LABEL = { low: 'НИЗКОЕ', medium: 'СРЕДНЕЕ', high: 'ВЫСОКОЕ', ultra: 'МАКСИМУМ' };

/**
 * Pause / settings menu.
 *
 * Wired straight into `ctx.config`: the quality segments call
 * `config.setQuality`, the sliders write `config.sensitivity` and `config.fov`
 * (and push the FOV into the live camera), and every change is announced on the
 * event bus so render/player can react without importing this module.
 *
 * Events emitted: `ui:pause` {paused}, `ui:quality` {quality},
 * `ui:sensitivity` {value}, `ui:fov` {value}, `ui:setting` {key, value}.
 */
export class PauseMenu {
  constructor(parent, ctx) {
    this.ctx = ctx;
    this.root = el('div', 'ow-menu', parent);
    const inner = el('div', 'ow-menu-inner', this.root);

    el('h1', null, inner, 'ПАУЗА');
    el('div', 'sub', inner, 'FPS ARENA — ТАКТИЧЕСКИЕ ОПЕРАЦИИ');
    el('div', 'rule', inner);

    this.rows = el('div', null, inner);

    // ---- quality preset --------------------------------------------------
    this.qBtns = [];
    const qRow = this._row('Качество графики');
    const seg = el('div', 'ow-seg', qRow);
    for (const p of PRESETS) {
      const b = el('button', null, seg, PRESET_LABEL[p] ?? p);
      b.type = 'button';
      b.addEventListener('click', () => this.setQuality(p));
      this.qBtns.push(b);
    }

    // ---- sensitivity -----------------------------------------------------
    this.sens = this._slider('Чувствительность мыши', 0.2, 3.0, 0.01, (v) => {
      this.ctx.config.sensitivity = 0.0022 * v;
      this.ctx.events.emit('ui:sensitivity', { value: this.ctx.config.sensitivity, multiplier: v });
      return v.toFixed(2);
    });

    // ---- field of view ---------------------------------------------------
    this.fov = this._slider('Поле зрения', 65, 120, 1, (v) => {
      this.ctx.config.fov = v;
      const cam = this.ctx.camera;
      if (cam) {
        cam.fov = v;
        cam.updateProjectionMatrix();
      }
      this.ctx.events.emit('ui:fov', { value: v });
      return String(v | 0);
    });

    // ---- invert look -----------------------------------------------------
    const invRow = this._row('Инверсия мыши');
    const invSeg = el('div', 'ow-seg', invRow);
    this.invBtns = [];
    for (const [label, val] of [
      ['ВЫКЛ', false],
      ['ВКЛ', true],
    ]) {
      const b = el('button', null, invSeg, label);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.ctx.config.invertY = val;
        this.ctx.events.emit('ui:setting', { key: 'invertY', value: val });
        this.syncFromConfig();
      });
      this.invBtns.push([b, val]);
    }

    // ---- buttons ---------------------------------------------------------
    const btns = el('div', 'ow-btns', inner);
    this.resumeBtn = el('button', 'ow-btn primary', btns, 'ПРОДОЛЖИТЬ');
    this.resumeBtn.type = 'button';
    this.resumeBtn.addEventListener('click', () => this.close());
    const reset = el('button', 'ow-btn', btns, 'СБРОС');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      this.sens.set(1);
      this.fov.set(80);
      this.ctx.config.invertY = false;
      this.setQuality('ultra');
    });
    el('div', 'hint', inner, '1 2 3 — ОРУЖИЕ · M — АРСЕНАЛ · F — ВЕРСТАК · N — ФОНАРЬ · J — ЛАЗЕР · '
      + 'B — РЕЖИМ ОГНЯ · R — ПЕРЕЗАРЯДКА · SHIFT — БЕГ · ESC — ПРОДОЛЖИТЬ');

    this.open = false;
    this.shown = 0;
    setStyle(this.root, 'display', 'none');
    setStyle(this.root, 'cursor', 'default');
    this.syncFromConfig();
  }

  _row(name) {
    const r = el('div', 'ow-row', this.rows);
    el('div', 'name', r, name.toUpperCase());
    return r;
  }

  _slider(name, min, max, step, apply) {
    const row = this._row(name);
    const wrap = el('div', 'ow-slider', row);
    el('div', 'track', wrap);
    const fill = el('div', 'fill', wrap);
    const knob = el('div', 'knob', wrap);
    const input = el('input', null, wrap);
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const val = el('div', 'val', row, '');

    const paint = (v) => {
      const t = (v - min) / (max - min);
      setStyle(fill, 'width', (t * 100).toFixed(2) + '%');
      setStyle(knob, 'left', (t * 100).toFixed(2) + '%');
      setText(val, apply(v) ?? String(v));
    };
    input.addEventListener('input', () => paint(parseFloat(input.value)));
    const api = {
      set: (v) => {
        const c = clamp(v, min, max);
        input.value = String(c);
        paint(c);
      },
    };
    return api;
  }

  setQuality(name) {
    try {
      this.ctx.config.setQuality(name);
      this.ctx.events.emit('ui:quality', { quality: name });
    } catch (err) {
      console.warn('[ui] quality switch failed', err);
    }
    this.syncFromConfig();
  }

  syncFromConfig() {
    const cfg = this.ctx.config;
    for (let i = 0; i < this.qBtns.length; i++)
      this.qBtns[i].classList.toggle('on', PRESETS[i] === cfg.quality);
    for (const [b, v] of this.invBtns) b.classList.toggle('on', !!cfg.invertY === v);
    this.sens?.set((cfg.sensitivity ?? 0.0022) / 0.0022);
    this.fov?.set(cfg.fov ?? 80);
  }

  toggle() {
    this.open ? this.close() : this.show();
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.syncFromConfig();
    setStyle(this.root, 'display', '');
    document.exitPointerLock?.();
    // Owner-keyed freeze, not a private save/restore of the shared scale: the
    // gunsmith board freezes the same clock and the two can overlap.
    this.ctx.time?.freeze('pause-menu');
    this.ctx.peek('player')?.setControlEnabled?.(false);
    this.ctx.events.emit('ui:pause', { paused: true });
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.ctx.time?.thaw('pause-menu');
    this.ctx.peek('player')?.setControlEnabled?.(true);
    /**
     * This request is often refused: Chrome blocks a pointer lock that arrives
     * too soon after the user left the lock with Escape, and Escape is how this
     * menu gets dismissed. The refusal is silent.
     *
     * So the "we lost the lock, the player must want to pause" watchdog in
     * ui/index.js has to be disarmed here, at the moment of resuming, and left
     * disarmed until the lock is genuinely held again — otherwise it saw the
     * not-yet-granted lock as fresh intent to pause and reopened this menu one
     * frame later, refreezing the match the player had just resumed.
     *
     * Disarming here rather than on an open->closed edge sampled in lateUpdate
     * matters: show() and close() can both land between two frames (the resume
     * button does exactly that), and a sampled edge misses that entirely.
     * Re-arming on the lock itself rather than after a timeout also avoids
     * merely postponing the bounce.
     */
    this.ctx.peek('ui')?.disarmPointerLockWatchdog?.();
    this.ctx.input?.requestPointerLock?.();
    this.ctx.events.emit('ui:pause', { paused: false });
  }

  /** Driven with unscaled time so the fade still runs while the game is frozen. */
  update(rawDt) {
    this.shown = damp(this.shown, this.open ? 1 : 0, 14, rawDt);
    if (this.shown < 0.004) {
      setStyle(this.root, 'display', 'none');
      setStyle(this.root, 'pointer-events', 'none');
      return;
    }
    setStyle(this.root, 'display', '');
    setStyle(this.root, 'pointer-events', this.open ? 'auto' : 'none');
    setStyle(this.root, 'opacity', ease.outQuad(this.shown).toFixed(3));
  }

  dispose() {
    this.root.remove();
  }
}
