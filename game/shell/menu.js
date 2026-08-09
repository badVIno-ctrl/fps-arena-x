/**
 * The screen the player lands on.
 *
 * This is deliberately plain DOM and its own CSS: it has to paint before three,
 * the engine or a single texture exist, otherwise the first thing a visitor sees
 * on a cold Render dyno is forty seconds of black. Nothing here imports the
 * engine, so it costs nothing at boot.
 *
 * The layout follows the original FPS Arena menu: an eyebrow line, a heavy
 * masthead, then three mode cards where the bot match is featured and the two
 * online modes stack beside it.
 *
 * The font stacks below are duplicated from ui/util.js rather than imported, and
 * that is on purpose. verify-shell.mjs asserts this file has ZERO imports, which
 * is what mechanically guarantees the paragraph above stays true — an import here
 * is one `export * from` away from dragging three into the first paint. Two
 * strings are a cheap price for a guarantee a comment cannot give you. The
 * `--font-*` variables come from next/font in app/layout.tsx.
 */

const FONT_STACK =
  'var(--font-body),"Avenir Next Condensed","Roboto Condensed","Arial Narrow",' +
  'system-ui,-apple-system,sans-serif';
const FONT_DISPLAY =
  'var(--font-display),"DIN Condensed","Avenir Next Condensed","Oswald",' +
  '"Arial Narrow",Impact,system-ui,sans-serif';

const MODES = [
  {
    id: 'bots',
    tag: 'РЕЖИМ 01 · ПОЛИГОН',
    name: 'ИГРА С БОТАМИ',
    note: 'Гарнизон из шестидесяти бойцов. Захват флага или зачистка.',
    chips: ['60 БОТОВ', '3 СЛОЖНОСТИ', 'CTF', 'DEATHMATCH'],
    cta: 'НАСТРОИТЬ И В БОЙ',
    accent: 'var(--solo)',
    featured: true,
  },
  {
    id: 'duel',
    tag: 'РЕЖИМ 02 · ДУЭЛЬ',
    name: 'ОНЛАЙН 1×1',
    note: 'Формат до 5 побед в раундах.',
    chips: ['ПОИСК СОПЕРНИКА'],
    cta: 'НАЙТИ СОПЕРНИКА',
    accent: 'var(--duel)',
    featured: false,
  },
  {
    id: 'squad',
    tag: 'РЕЖИМ 03 · ОТРЯД',
    name: 'КОМАНДЫ 10×10',
    note: 'Автобаланс, килл-лимит и таймер матча.',
    chips: ['ДО 50 УБИЙСТВ', '10 МИНУТ'],
    cta: 'В ЛОББИ',
    accent: 'var(--squad)',
    featured: false,
  },
];

const QUALITY = [
  { id: 'auto', label: 'АВТО' },
  { id: 'low', label: 'НИЗКОЕ' },
  { id: 'medium', label: 'СРЕДНЕЕ' },
  { id: 'ultra', label: 'ВЫСОКОЕ' },
];

const SUBMODES = [
  { id: 'ctf', label: 'ЗАХВАТ ФЛАГА' },
  { id: 'dm', label: 'ЗАЧИСТКА' },
];

const DIFFICULTIES = [
  { id: 'easy', label: 'ЛЕГКО' },
  { id: 'normal', label: 'НОРМА' },
  { id: 'hard', label: 'СЛОЖНО' },
];

const CSS = `
.fa-menu {
  position: fixed; inset: 0; z-index: 40;
  --bg: #0b0e13; --panel: #131922; --line: #1e2733;
  --ink: #eef2f7; --muted: #93a1b4;
  --solo: #f5a524; --duel: #ff5145; --squad: #2dd4bf;
  background: var(--bg); color: var(--ink);
  font: 400 15px/1.55 ${FONT_STACK};
  overflow-y: auto; cursor: default;
}
/* A 46px grid and a grain wash: without them a flat dark panel reads as an
   unstyled page rather than a deliberate one. Both are painted, never animated. */
.fa-menu::before {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background-image:
    linear-gradient(to right, rgba(255,255,255,.028) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(255,255,255,.028) 1px, transparent 1px);
  background-size: 46px 46px;
  mask-image: radial-gradient(120% 90% at 50% 0%, #000 35%, transparent 100%);
}
.fa-menu::after {
  content: ""; position: absolute; inset: 0; pointer-events: none; opacity: .5;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/></filter><rect width='140' height='140' filter='url(%23n)' opacity='.22'/></svg>");
}
.fa-wrap { position: relative; z-index: 1; max-width: 1160px; margin: 0 auto; padding: 56px 28px 40px; }
.fa-top { display: flex; align-items: baseline; justify-content: space-between; gap: 18px; flex-wrap: wrap; }
.fa-eyebrow { font-size: 11px; letter-spacing: .32em; color: var(--muted); }

/* Relay status.
 *
 * This exists because of a specific failure the free tier produces: the service
 * stops after 15 idle minutes, so the first visitor of the morning waits out a
 * container pull with no idea whether anything is happening. The heartbeat in
 * game/net/heartbeat.js already knows the answer, so the menu says it out loud
 * instead of letting the player guess from a dead "НАЙТИ СОПЕРНИКА" button.
 *
 * The dot pulses only while waking — a permanent animation on a resting state is
 * noise, and a status that is always moving stops meaning anything. */
.fa-status {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 11px; letter-spacing: .18em; color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.fa-status i {
  width: 7px; height: 7px; border-radius: 50%;
  background: currentColor; color: var(--muted);
  box-shadow: 0 0 0 3px color-mix(in oklab, currentColor 18%, transparent);
}
.fa-status[data-state="warm"] { color: var(--squad); }
.fa-status[data-state="down"] { color: var(--duel); }
.fa-status[data-state="waking"] { color: var(--solo); }
/* Deliberately still.
 *
 * The obvious move here is a pulsing dot, and verify-shell.mjs forbids it: this
 * screen holds a completely static backdrop so that nothing competes with the
 * only thing that should move, which is the loading bar after a commit. A status
 * seen once per session, already carrying its own sentence, gains nothing from a
 * loop — so the transient state is drawn as a hollow ring instead of an animated
 * one, and the difference is legible at a glance without moving a pixel. */
.fa-status[data-state="waking"] i { background: transparent; box-shadow: inset 0 0 0 2px currentColor; }
.fa-status[data-state="unknown"] i { opacity: .55; }
.fa-mast {
  font-family: ${FONT_DISPLAY};
  font-size: clamp(40px, 8vw, 86px); line-height: .92; font-weight: 400;
  letter-spacing: .01em; margin: 14px 0 4px; text-transform: uppercase;
}
.fa-mast b { font-weight: 700; }
.fa-sub { color: var(--muted); max-width: 46ch; }
.fa-rule { height: 1px; background: var(--line); margin: 26px 0 22px; }
.fa-cards { display: grid; grid-template-columns: 1.32fr 1fr; gap: 16px; align-items: stretch; }
.fa-stack { display: grid; grid-template-rows: 1fr 1fr; gap: 16px; }
.fa-card {
  position: relative; text-align: left; display: flex; flex-direction: column; gap: 10px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
  padding: 22px; color: inherit; font: inherit; cursor: pointer;
  transition: border-color .18s ease, transform .18s ease, background .18s ease;
}
.fa-card:hover, .fa-card:focus-visible { border-color: var(--accent); transform: translateY(-2px); outline: none; }
.fa-card[aria-pressed="true"] { border-color: var(--accent); background: #161d28; }
.fa-card .fa-tag { font-size: 10px; letter-spacing: .26em; color: var(--accent); }
.fa-card h2 { font-size: 15px; letter-spacing: .04em; font-weight: 700; }
.fa-featured h2 { font-size: clamp(26px, 3.4vw, 40px); letter-spacing: -.01em; }
.fa-card p { color: var(--muted); font-size: 13px; }
.fa-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; }
.fa-chip { font-size: 10px; letter-spacing: .16em; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 4px 9px; }
.fa-go { margin-top: 14px; font-size: 12px; letter-spacing: .18em; color: var(--accent); }
.fa-opts { margin-top: 22px; display: grid; gap: 14px; }
.fa-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.fa-label { font-size: 10px; letter-spacing: .26em; color: var(--muted); min-width: 92px; }
.fa-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.fa-seg button {
  background: transparent; border: 0; color: var(--muted); font: inherit; font-size: 11px;
  letter-spacing: .16em; padding: 8px 14px; cursor: pointer;
}
.fa-seg button[aria-pressed="true"] { background: #1b2430; color: var(--ink); }
.fa-nick {
  background: #0e131b; border: 1px solid var(--line); border-radius: 10px; color: var(--ink);
  font: inherit; font-size: 13px; padding: 8px 12px; width: 220px;
}
.fa-nick:focus { outline: none; border-color: var(--solo); }
.fa-start {
  margin-top: 8px; align-self: start; background: var(--ink); color: #0b0e13; border: 0;
  border-radius: 11px; font: inherit; font-weight: 700; font-size: 13px; letter-spacing: .18em;
  padding: 14px 26px; cursor: pointer;
}
.fa-start:disabled { opacity: .45; cursor: progress; }
.fa-foot { margin-top: 26px; color: var(--muted); font-size: 12px; }
.fa-note { color: var(--duel); font-size: 12px; min-height: 18px; }
.fa-bar {
  display: none; margin-top: 16px; width: 100%; max-width: 320px; height: 3px;
  background: rgba(255,255,255,.12); border-radius: 2px; overflow: hidden;
}
.fa-bar > i { display: block; height: 100%; width: 0%; background: var(--ink); transition: width .18s linear; }
.fa-step {
  display: none; margin-top: 8px; color: var(--muted); font-size: 11px;
  letter-spacing: .14em; min-height: 14px;
}
@media (max-width: 860px) {
  .fa-cards { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .fa-card { transition: none; }
  .fa-card:hover { transform: none; }
}
`;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/** A row of mutually exclusive buttons. Returns the element; read state via get(). */
function segmented(items, initial, onPick) {
  const box = el('div', 'fa-seg');
  let value = initial;
  const buttons = new Map();
  for (const item of items) {
    const b = el('button', null, item.label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(item.id === value));
    b.addEventListener('click', () => {
      value = item.id;
      for (const [id, node] of buttons) node.setAttribute('aria-pressed', String(id === value));
      onPick?.(value);
    });
    buttons.set(item.id, b);
    box.append(b);
  }
  box.get = () => value;
  return box;
}

export class ModeMenu {
  constructor(o = {}) {
    this.mode = o.mode ?? 'bots';
    this.quality = o.quality ?? 'auto';
    this.submode = o.submode ?? 'ctf';
    this.difficulty = o.difficulty ?? 'normal';
    this.nickname = o.nickname ?? '';
    this.root = null;
    this._style = null;
    this._cards = new Map();

    /**
     * A promise from game/net/heartbeat.js `probe()`, or null when there is no
     * relay to ask (capture runs, local development, offline). The menu never
     * waits on it: bot mode does not need a server, so blocking the whole screen
     * on a request that may take 45 seconds would be the wrong trade.
     */
    this._probe = o.serverProbe ?? null;
    this.server = { state: 'unknown', players: null };
  }

  /**
   * Paints the menu and resolves once the player commits to a match.
   * Resolves with everything the engine and the relay need, and nothing else.
   */
  choose() {
    return new Promise((resolve) => {
      this._build(resolve);
    });
  }

  _build(resolve) {
    this._style = el('style');
    this._style.textContent = CSS;
    document.head.append(this._style);

    const root = el('div', 'fa-menu');
    const wrap = el('div', 'fa-wrap');

    const top = el('div', 'fa-top');
    top.append(el('div', 'fa-eyebrow', 'БРАУЗЕРНЫЙ ТАКТИЧЕСКИЙ ШУТЕР'));
    this._status = el('div', 'fa-status');
    this._status.append(el('i'));
    this._statusText = el('span', null, 'ПРОВЕРКА СВЯЗИ');
    this._status.append(this._statusText);
    this._status.dataset.state = 'unknown';
    top.append(this._status);
    wrap.append(top);
    this._watchServer();

    const mast = el('h1', 'fa-mast');
    mast.append('FPS ', el('b', null, 'ARENA'));
    wrap.append(mast);
    wrap.append(el('p', 'fa-sub', 'Девять стволов со съёмными прицелами, глушителями, лазером и фонарём. Одна карта, три способа её не пережить.'));
    wrap.append(el('div', 'fa-rule'));

    const cards = el('div', 'fa-cards');
    const stack = el('div', 'fa-stack');
    for (const def of MODES) {
      const card = this._card(def);
      if (def.featured) cards.append(card);
      else stack.append(card);
    }
    cards.append(stack);
    wrap.append(cards);

    const opts = el('div', 'fa-opts');

    const subRow = el('div', 'fa-row');
    subRow.append(el('span', 'fa-label', 'ЗАДАЧА'));
    this._sub = segmented(SUBMODES, this.submode, (v) => { this.submode = v; });
    subRow.append(this._sub);

    const diffRow = el('div', 'fa-row');
    diffRow.append(el('span', 'fa-label', 'СЛОЖНОСТЬ'));
    this._diff = segmented(DIFFICULTIES, this.difficulty, (v) => { this.difficulty = v; });
    diffRow.append(this._diff);

    const nickRow = el('div', 'fa-row');
    nickRow.append(el('span', 'fa-label', 'ПОЗЫВНОЙ'));
    this._nick = el('input', 'fa-nick');
    this._nick.type = 'text';
    this._nick.maxLength = 24;
    this._nick.placeholder = 'как вас увидят соперники';
    this._nick.value = this.nickname;
    nickRow.append(this._nick);

    const qRow = el('div', 'fa-row');
    qRow.append(el('span', 'fa-label', 'ГРАФИКА'));
    this._quality = segmented(QUALITY, this.quality, (v) => { this.quality = v; });
    qRow.append(this._quality);

    this._online = [subRow, diffRow, nickRow];
    opts.append(subRow, diffRow, nickRow, qRow);
    wrap.append(opts);

    this._note = el('p', 'fa-note');
    wrap.append(this._note);

    this._start = el('button', 'fa-start', 'НАЧАТЬ');
    this._start.type = 'button';
    this._start.addEventListener('click', () => this._commit(resolve));
    wrap.append(this._start);

    /**
     * Loading progress, hidden until the player commits.
     *
     * Boot takes a while on a cold cache — the arsenal alone is 400k triangles
     * and every shader has to be compiled before the first frame. Without this
     * the button just said "ЗАГРУЗКА…" and nothing moved for the whole wait,
     * which is indistinguishable from a hang.
     */
    this._bar = el('div', 'fa-bar');
    this._fill = el('i');
    this._bar.append(this._fill);
    this._step = el('p', 'fa-step');
    wrap.append(this._bar, this._step);

    wrap.append(el('p', 'fa-foot', 'Управление и арсенал — подсказка в игре. Верстак открывается на клавишу B.'));

    root.append(wrap);
    document.body.append(root);
    this.root = root;

    this._select(this.mode);
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target !== this._start) this._commit(resolve);
    });
  }

  /**
   * Resolve the relay probe into one honest line of text.
   *
   * Four states, and each one changes what the player should do:
   *   unknown  nothing has answered yet — the default, never alarming
   *   waking   reachable but cold; an online match will start slowly
   *   warm     reachable and up; player count is real, not decorative
   *   down     no relay — bot mode still works, and the note says so
   */
  _watchServer() {
    if (!this._probe) {
      this._setServer('unknown', 'ЛОКАЛЬНЫЙ ЗАПУСК');
      return;
    }
    this._setServer('waking', 'СЕРВЕР ОТВЕЧАЕТ…');
    this._probe.then(
      (res) => {
        if (!this._status) return; // dismissed while the probe was in flight
        if (!res || res.applicable === false) {
          this._setServer('unknown', 'ЛОКАЛЬНЫЙ ЗАПУСК');
          return;
        }
        if (!res.ok) {
          this._setServer('down', 'СЕРВЕР НЕДОСТУПЕН');
          return;
        }
        const players = res.body?.players_online;
        this.server.players = typeof players === 'number' ? players : null;
        if (res.coldStart) {
          // Worth saying: this visitor woke the instance, so the first online
          // match will feel slower than the next one.
          this._setServer('waking', 'СЕРВЕР ТОЛЬКО ЧТО ПРОСНУЛСЯ');
          return;
        }
        this._setServer(
          'warm',
          this.server.players === null
            ? 'СЕРВЕР В СЕТИ'
            : `В СЕТИ · ${this.server.players} ИГРОКОВ`,
        );
      },
      () => this._setServer('down', 'СЕРВЕР НЕДОСТУПЕН'),
    );
  }

  _setServer(state, text) {
    this.server.state = state;
    if (!this._status) return;
    this._status.dataset.state = state;
    this._statusText.textContent = text;
  }

  _card(def) {
    const card = el('button', `fa-card${def.featured ? ' fa-featured' : ''}`);
    card.type = 'button';
    card.style.setProperty('--accent', def.accent);
    card.setAttribute('aria-pressed', 'false');
    card.append(el('div', 'fa-tag', def.tag));
    card.append(el('h2', null, def.name));
    card.append(el('p', null, def.note));
    const chips = el('div', 'fa-chips');
    for (const c of def.chips) chips.append(el('span', 'fa-chip', c));
    card.append(chips);
    card.append(el('div', 'fa-go', `${def.cta} →`));
    card.addEventListener('click', () => this._select(def.id));
    card.addEventListener('dblclick', () => this._start?.click());
    this._cards.set(def.id, card);
    return card;
  }

  /** Picking a mode hides the options that mode has no use for. */
  _select(id) {
    this.mode = id;
    for (const [key, node] of this._cards) node.setAttribute('aria-pressed', String(key === id));
    const offline = id === 'bots';
    this._online[0].style.display = offline ? '' : 'none';
    this._online[1].style.display = offline ? '' : 'none';
    this._online[2].style.display = offline ? 'none' : '';
    this._note.textContent = '';
  }

  _commit(resolve) {
    const nickname = this._nick.value.trim().slice(0, 24);
    if (this.mode !== 'bots' && nickname.length < 2) {
      this._note.textContent = 'Для сетевой игры нужен позывной — минимум два символа.';
      this._nick.focus();
      return;
    }
    // A confirmed-dead relay means the online modes cannot work, and letting the
    // player commit anyway buys them a loading bar that never finishes. Bot mode
    // needs no server at all, hence the offer rather than a plain refusal.
    if (this.mode !== 'bots' && this.server.state === 'down') {
      this._note.textContent =
        'Сервер не отвечает — сетевые режимы недоступны. Игра с ботами работает без сервера.';
      return;
    }
    this._start.disabled = true;
    this._start.textContent = this.mode === 'bots' ? 'ЗАГРУЗКА…' : 'ПОДКЛЮЧЕНИЕ…';
    if (this._bar) this._bar.style.display = 'block';
    if (this._step) this._step.style.display = 'block';
    resolve({
      mode: this.mode,
      submode: this._sub.get(),
      difficulty: this._diff.get(),
      quality: this._quality.get(),
      nickname,
    });
  }

  /**
   * Report boot progress on the menu the player is already looking at.
   *
   * @param {number} frac  0..1
   * @param {string} [label] short Russian caption for the current step
   */
  progress(frac, label) {
    if (!this._fill) return;
    const pct = Math.max(0, Math.min(1, frac)) * 100;
    this._fill.style.width = `${pct.toFixed(1)}%`;
    if (label) this._step.textContent = label;
  }

  /** Called once the engine has a frame to show. */
  dismiss() {
    this.root?.remove();
    this._style?.remove();
    this.root = null;
    this._style = null;
    // The relay probe can outlive the menu by up to 45 seconds. Dropping the
    // reference is what makes `_setServer` a no-op instead of a write into
    // detached DOM.
    this._status = null;
    this._statusText = null;
  }
}

/**
 * The card shown when a match ends. It reads a Match snapshot, so it works the
 * same for a bot round, a duel and a squad match without knowing which is which.
 */
export class MatchResults {
  constructor(onAgain) {
    this.onAgain = onAgain;
    this.root = null;
  }

  show(snapshot) {
    this.hide();
    const root = el('div', 'fa-menu');
    root.style.background = 'rgba(11,14,19,.94)';
    const wrap = el('div', 'fa-wrap');
    const won = snapshot.winner === 0;
    const draw = snapshot.winner === null || snapshot.winner === undefined;

    wrap.append(el('div', 'fa-eyebrow', snapshot.label ?? 'МАТЧ ОКОНЧЕН'));
    const mast = el('h1', 'fa-mast', draw ? 'НИЧЬЯ' : won ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ');
    mast.style.color = draw ? 'var(--muted)' : won ? 'var(--squad)' : 'var(--duel)';
    wrap.append(mast);
    wrap.append(el('div', 'fa-rule'));

    const chips = el('div', 'fa-chips');
    for (const team of snapshot.teams ?? []) {
      chips.append(el('span', 'fa-chip', `${team.label}: ${team.score ?? team.kills ?? 0}`));
    }
    if (snapshot.mvp) chips.append(el('span', 'fa-chip', `MVP: ${snapshot.mvp.name ?? snapshot.mvp.id}`));
    wrap.append(chips);

    const again = el('button', 'fa-start', 'ЕЩЁ РАЗ');
    again.type = 'button';
    again.addEventListener('click', () => { this.hide(); this.onAgain?.(); });
    wrap.append(again);

    root.append(wrap);
    document.body.append(root);
    this.root = root;
  }

  hide() {
    this.root?.remove();
    this.root = null;
  }
}
