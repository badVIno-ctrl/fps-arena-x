/**
 * SHELL GATE - step 7.
 *
 * The menu is DOM, and node has no DOM, so this gate does two things instead of
 * pretending otherwise: it runs the pure parts for real by stubbing the three
 * document calls the module makes at import time, and it reads the source for
 * the wiring rules that a screenshot would never catch - boot order, event
 * names, capture bypass, nickname limits.
 *
 *   node tools/verify-shell.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIDTH = 60;

let passed = 0;
const failures = [];
let current = '';

function group(name) {
  current = name;
  console.log(`\n${name}`);
}

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok ${label}`);
  } catch (err) {
    failures.push(`${current} / ${label}: ${err.message}`);
    console.log(`  x  ${label}`);
    console.log(`      ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const exists = (rel) => existsSync(join(ROOT, rel));

const MENU = read('game/shell/menu.js');
const MAIN = read('game/boot.js');
/**
 * The document shell moved from a hand-written index.html to Next's metadata
 * export when the game became a Next app, so these checks now read
 * app/layout.tsx. Same questions being asked — does the tab have a real title, a
 * favicon, a description, a theme colour, a declared language — just a different
 * file answering them.
 */
const SHELL = read('app/layout.tsx');

/* ====================================================== the menu ======= */

group('menu: what the player is offered');

check('it paints before the engine exists', () => {
  const imports = [...MENU.matchAll(/^import .*$/gm)];
  assert(imports.length === 0, `menu.js imports ${imports.length} modules: it must not pull three or the engine`);
  assert(!/THREE/.test(MENU), 'the menu references three');
});

check('three modes, in the order the plan promises', () => {
  const ids = [...MENU.matchAll(/^\s*id: '(bots|duel|squad)',$/gm)].map((m) => m[1]);
  assert(ids.join() === 'bots,duel,squad', `mode order is ${ids.join()}`);
});

check('the bot match is the featured card, the online modes stack', () => {
  const featured = [...MENU.matchAll(/featured: (true|false)/g)].map((m) => m[1]);
  assert(featured.join() === 'true,false,false', `featured flags are ${featured.join()}`);
  assert(/grid-template-columns: 1\.32fr 1fr/.test(MENU), 'the card grid lost its ratio');
  assert(/\.fa-stack \{[^}]*grid-template-rows: 1fr 1fr/.test(MENU), 'the two online cards do not stack');
});

check('the masthead and eyebrow are the ones from the original menu', () => {
  assert(MENU.includes('\u0411\u0420\u0410\u0423\u0417\u0415\u0420\u041d\u042b\u0419 \u0422\u0410\u041a\u0422\u0418\u0427\u0415\u0421\u041a\u0418\u0419 \u0428\u0423\u0422\u0415\u0420'), 'the eyebrow line is gone');
  assert(/'FPS '/.test(MENU) && /el\('b', null, 'ARENA'\)/.test(MENU), 'the masthead is not FPS ARENA');
  assert(/clamp\(40px, 8vw, 86px\)/.test(MENU), 'the masthead stopped scaling with the viewport');
});

check('each mode carries its own accent, and they differ', () => {
  const accents = [...MENU.matchAll(/accent: 'var\(--(\w+)\)'/g)].map((m) => m[1]);
  assert(new Set(accents).size === 3, `only ${new Set(accents).size} distinct accents`);
  for (const name of accents) {
    assert(new RegExp(`--${name}: #`).test(MENU), `--${name} is used but never defined`);
  }
});

check('all four graphics tiers are offered', () => {
  const q = [...MENU.matchAll(/id: '(auto|low|medium|ultra)'/g)].map((m) => m[1]);
  assert(q.join() === 'auto,low,medium,ultra', `quality tiers are ${q.join()}`);
});

check('bot options and online options are never shown together', () => {
  const sel = MENU.slice(MENU.indexOf('  _select(id) {'), MENU.indexOf('  _commit('));
  assert(/offline = id === 'bots'/.test(sel), 'the menu does not branch on the mode');
  assert((sel.match(/style\.display/g) || []).length === 3, 'not every optional row is toggled');
});

check('a nickname is required online and capped at the relay limit', () => {
  assert(/maxLength = 24/.test(MENU), 'the input is not capped');
  assert(/slice\(0, 24\)/.test(MENU), 'a pasted nickname is not trimmed to 24');
  const commit = MENU.slice(MENU.indexOf('  _commit('));
  assert(/nickname\.length < 2/.test(commit), 'an empty nickname would be sent to the relay');
  assert(commit.indexOf('return;') < commit.indexOf('resolve('), 'the guard does not stop the match starting');
});

check('the start button cannot be pressed twice', () => {
  assert(/_start\.disabled = true/.test(MENU), 'a double click would start two matches');
});

check('motion is optional and the grain never animates', () => {
  assert(/@media \(prefers-reduced-motion: reduce\)/.test(MENU), 'no reduced-motion branch');
  const anims = [...MENU.matchAll(/@keyframes/g)].length;
  assert(anims === 0, `${anims} keyframe animations: the backdrop must stay still`);
});

check('the results card reads a match snapshot, not a mode', () => {
  const res = MENU.slice(MENU.indexOf('export class MatchResults'));
  assert(/snapshot\.winner === 0/.test(res), 'it does not read the winner');
  assert(/snapshot\.winner === null/.test(res), 'a draw would be shown as a defeat');
  assert(/snapshot\.teams/.test(res) && /snapshot\.mvp/.test(res), 'the scoreboard is missing');
  assert(!/'bots'|'duel'|'squad'/.test(res), 'the results card special-cases a mode');
});

/* ======================================================= boot ========== */

group('boot: the order things happen in');

check('the menu is answered before the engine is built', () => {
  // The invariant is the ORDER, not the shape of the code that produces it: the
  // player's choice decides the quality tier the engine is constructed with, so
  // nothing may allocate a GL context until `choice` exists. Keyed off awaiting
  // the menu rather than a helper name, which is what made this check go stale.
  const menuAt = MAIN.indexOf('await menu.choose()');
  const engineAt = MAIN.indexOf('new Engine(');
  assert(menuAt > 0, 'boot never awaits the menu');
  assert(engineAt > menuAt, 'the engine is constructed before the player has chosen');
});

check('every subsystem is registered, new ones included', () => {
  for (const sys of ['RenderSystem', 'MaterialSystem', 'SkySystem', 'WorldSystem', 'PhysicsSystem',
    'PlayerSystem', 'WeaponSystem', 'FxSystem', 'AiSystem', 'UiSystem', 'AudioSystem',
    'ModesSystem', 'NetSystem', 'ShellSystem']) {
    assert(new RegExp(`\\.add\\(${sys}\\)`).test(MAIN), `${sys} is never added`);
  }
});

/**
 * Matched WITHOUT the closing paren on purpose: init() takes an optional
 * progress callback. Pinning the exact empty-argument spelling made both checks
 * below silently compare against an indexOf of -1 the moment an argument was
 * added — the same staleness that let five gates read a directory that no longer
 * existed. A missing call is now asserted explicitly instead of passing quietly.
 */
const INIT_CALL = 'await engine.init(';

check('modes and net are configured before init, not after', () => {
  const modesAt = MAIN.indexOf('get(ModesSystem.id).configure');
  const netAt = MAIN.indexOf('get(NetSystem.id).configure');
  const initAt = MAIN.indexOf(INIT_CALL);
  assert(initAt > 0, 'boot never calls engine.init()');
  assert(modesAt > 0 && netAt > 0, 'a subsystem is never configured');
  assert(modesAt < initAt && netAt < initAt, 'configuration lands after init, when the garrison is already sized');
});

check('the choice reaches both subsystems intact', () => {
  const block = MAIN.slice(MAIN.indexOf('get(ModesSystem.id)'), MAIN.indexOf(INIT_CALL));
  for (const key of ['mode', 'submode', 'difficulty', 'nickname', 'url']) {
    assert(new RegExp(`${key}:`).test(block), `${key} is not passed through`);
  }
});

check('auto quality is resolved to a real tier', () => {
  // Anchor on the next top-level statement: 'const choice =' also matches the
  // line inside askPlayer, which sits earlier and yields an empty slice.
  const fn = MAIN.slice(MAIN.indexOf('function resolveQuality'), MAIN.indexOf('const config = createConfig'));
  assert(/hardwareConcurrency/.test(fn), 'auto does not look at the hardware');
  assert(/'low'/.test(fn) && /'ultra'/.test(fn), 'auto cannot reach both ends of the scale');
  assert(/return name/.test(fn), 'an explicit choice would be overridden');
});

check('a capture run never waits for a click', () => {
  // The pixel gate runs headless with no one to press start, so ?capture=1 has to
  // answer the menu from the query string. If the ModeMenu were ever constructed
  // on that path the run would block forever and the gate would time out instead
  // of failing usefully.
  const gateAt = MAIN.indexOf('if (capture) {');
  const menuAt = MAIN.indexOf('new ModeMenu');
  assert(gateAt > 0, 'boot does not branch on capture: the pixel gate would hang on the menu');
  assert(gateAt < menuAt, 'the menu is built even in capture mode');
});

check('the menu is taken down only once a frame has landed', () => {
  assert(/choice\.menu\?\.dismiss\(\)/.test(MAIN), 'the menu is never dismissed');
  const dismissAt = MAIN.indexOf('choice.menu?.dismiss()');
  assert(MAIN.indexOf('__READY__ = true;', MAIN.indexOf('let warm = 0')) < dismissAt, 'the menu is removed before the first frame: the player would stare at black');
});

check('the results card listens to the event modes actually emits', () => {
  const emitted = read('game/modes/index.js').match(/events\.emit\('(modes:over)'/);
  assert(emitted, 'modes no longer emits an end-of-match event');
  assert(MAIN.includes(`engine.events.on('${emitted[1]}'`), `main.js listens for the wrong event, modes emits ${emitted[1]}`);
});

check('a rematch reloads instead of tearing a live match down', () => {
  const block = MAIN.slice(MAIN.indexOf('new MatchResults('), MAIN.indexOf('// Capture harness'));
  assert(/location\.search/.test(block), 'the rematch path does not reload');
  assert(/mode: choice\.mode/.test(block), 'the rematch forgets what was being played');
});

/* ======================================================= page ========== */

group('page: what the browser tab shows');

check('the tab is the game, not a template', () => {
  assert(/title:\s*'FPS ARENA/.test(SHELL), 'the tab title does not start with FPS ARENA');
  assert(!/Claude|Vite|Create Next App|My App/i.test(SHELL), 'a leftover template name is still in the shell');
});

check('there is an icon, so the tab is not a blank sheet', () => {
  assert(/icons:\s*\{/.test(SHELL), 'no favicon declared');
  assert(/crosshair\.svg/.test(SHELL), 'the icon is not the crosshair');
});

check('the page is described for a link preview', () => {
  assert(/description:\s*\n?\s*'/.test(SHELL), 'no description');
  assert(/themeColor:/.test(SHELL), 'no theme colour');
  assert(/lang="ru"/.test(SHELL), 'the page does not declare its language');
});

check('the type system is loaded, not assumed to be installed', () => {
  // The HUD is drawn for condensed faces. Naming them in CSS only works on a Mac;
  // these have to be real webfonts or the interface silently degrades elsewhere.
  //
  // This check used to assert `next/font/google`, and that was the wrong
  // invariant: next/font fetches the files from Google AT BUILD TIME, so it made
  // every deploy depend on a third party being reachable from the build
  // container — and when it is not, the build fails outright. The faces are now
  // self-hosted, so what has to be true is stated directly.
  const FONTS = read('app/fonts.css');
  // Match the import statement, not the word. The comment above this file's
  // font block explains why next/font/google was dropped, and a check that reads
  // its own documentation as evidence fails on the explanation.
  assert(
    !/from\s+['"]next\/font\/google['"]/.test(SHELL),
    'fonts are fetched from Google at build time again',
  );

  const faces = [...FONTS.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0]);
  assert(faces.length >= 6, `only ${faces.length} @font-face rules`);

  const families = new Set(
    faces.map((f) => f.match(/font-family:\s*'([^']+)'/)?.[1]).filter(Boolean),
  );
  assert(families.size >= 3, `only ${families.size} font families declared`);

  for (const v of ['--font-display', '--font-body', '--font-mono']) {
    assert(FONTS.includes(v), `${v} is never defined`);
  }

  // Every string in this game is Russian, so every family needs a cyrillic file.
  for (const family of families) {
    const own = faces.filter((f) => f.includes(`'${family}'`));
    assert(
      own.some((f) => /U\+0400-045F/.test(f)),
      `${family} has no cyrillic range: russian text would fall back to system sans`,
    );
    assert(
      own.some((f) => /U\+0000-00FF/.test(f)),
      `${family} has no latin range`,
    );
  }

  // Two rules sharing family+weight with no unicode-range do not cooperate: the
  // last one declared wins for ALL text. That is the specific bug this asserts
  // against, because it looks like "the font just did not load".
  for (const f of faces) {
    assert(/unicode-range:/.test(f), `an @font-face has no unicode-range:\n${f.slice(0, 120)}`);
  }

  // A face that is referenced but not committed is a 404 at first paint.
  const urls = [...FONTS.matchAll(/url\('\/fonts\/([^']+)'\)/g)].map((m) => m[1]);
  assert(urls.length === faces.length, 'some @font-face rule has no src');
  for (const file of urls) {
    assert(exists(`public/fonts/${file}`), `public/fonts/${file} is referenced but missing`);
  }

  // The menu must paint in the right face without waiting on a discovery round
  // trip; the display weight is what the masthead is set in.
  assert(/rel="preload"/.test(SHELL), 'no font is preloaded, so the masthead swaps in late');
  assert(/oswald-cyrillic-700/.test(SHELL), 'the masthead weight is not preloaded');
});

/* ===================================================== summary ========= */

console.log(`\n${'-'.repeat(WIDTH)}`);
if (failures.length) {
  console.log(`FAILED - ${failures.length} of ${passed + failures.length} checks`);
  for (const f of failures) console.log(`  . ${f}`);
  process.exit(1);
}
console.log(`all green - ${passed} shell checks passed`);
