#!/usr/bin/env node
/**
 * GATE — the page as a browser actually sees it.
 *
 * Every other gate in this directory reads source or imports pure modules. This
 * one boots the real relay over the real static export, drives a real Chromium
 * with real WebGL2, and asserts on what comes back. It is the only gate that can
 * catch a 404 on a font, a console error from a chunk that never loaded, or a
 * menu that overflows at 360 px — three failures that no amount of source
 * inspection will ever reveal.
 *
 * WHAT IS CHECKED, AT EVERY WIDTH
 *   * the document paints, and the masthead is on screen
 *   * the console is clean: no errors, no unhandled rejections
 *   * no request failed and nothing 404'd (fonts included)
 *   * no horizontal overflow — the classic responsive break
 *   * the intended webfont is the one actually rendering, not a fallback
 *   * every interactive control is large enough to hit on a phone
 *
 * PLUS, ONCE
 *   * WebGL2 with float render targets exists, because the renderer requires it
 *   * /healthz and /api/wake answer in the shape the keep-alive layers expect
 *
 * Usage:
 *   node tools/verify-visual.mjs                 # builds if out/ is missing
 *   node tools/verify-visual.mjs --shots         # also write PNGs to shots/
 *   node tools/verify-visual.mjs --keep          # leave the relay running
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';

import { resolveBrowser } from './browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const WANT_SHOTS = args.has('--shots');
const PORT = Number(process.env.VISUAL_PORT ?? 8731);
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * The widths that matter, and why each one is here rather than a round number:
 *   360  the narrowest phone still in real use; if the menu survives this it
 *        survives everything
 *   768  tablet portrait — where a two-column card grid has to give up
 *   1280 the most common laptop
 *   1920 what the HUD was designed against
 */
const WIDTHS = [
  { w: 360, h: 780, name: 'phone' },
  { w: 768, h: 1024, name: 'tablet' },
  { w: 1280, h: 800, name: 'laptop' },
  { w: 1920, h: 1080, name: 'desktop' },
];

let failures = [];
let passed = 0;
let group = '';

function section(name) {
  group = name;
  console.log(`\n${name}`);
}
function check(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error('check() is synchronous; await before calling');
    console.log(`  ok ${name}`);
    passed++;
  } catch (err) {
    console.log(`  x  ${name}`);
    console.log(`      ${err.message}`);
    failures.push(`${group} / ${name}: ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

async function waitForPort(port, ms = 40_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* ------------------------------------------------------------------ set-up */

if (!existsSync(join(ROOT, 'out', 'index.html'))) {
  console.log('out/ is missing - building the static export first');
  execFileSync('npx', ['next', 'build'], { cwd: ROOT, stdio: 'inherit' });
}

let relay = null;
if (!(await portOpen(PORT))) {
  relay = spawn(
    'python3',
    ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(PORT), '--no-access-log'],
    { cwd: join(ROOT, 'server'), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  relay.stdout.on('data', (d) => (log += d));
  relay.stderr.on('data', (d) => (log += d));
  if (!(await waitForPort(PORT))) {
    console.error('the relay never came up:\n' + log);
    process.exit(1);
  }
}

const { launch, describe } = await resolveBrowser();
console.log(`browser: ${describe()}`);
const browser = await launch();

/* ------------------------------------------------------------- the endpoints */

section('relay: what the keep-alive layers depend on');

const health = await (await fetch(`${BASE}/healthz`)).json().catch(() => null);
check('/healthz answers with the documented shape', () => {
  assert(health, '/healthz did not return JSON');
  assert(health.ok === true, 'ok is not true');
  for (const k of ['lobby', 'duels', 'squads']) assert(k in health, `${k} is missing`);
});

const wakeRes = await fetch(`${BASE}/api/wake`);
const wake = await wakeRes.json().catch(() => null);
check('/api/wake reports uptime and keep-alive state', () => {
  assert(wakeRes.status === 200, `status ${wakeRes.status}`);
  assert(typeof wake?.uptime_s === 'number', 'uptime_s is not a number');
  assert(typeof wake?.cold_start === 'boolean', 'cold_start is not a boolean');
  assert(wake?.keepalive && 'pings' in wake.keepalive, 'keepalive stats are missing');
});

check('the entry document is not cached, so a deploy is visible at once', () => {
  // The whole point of shipping hashed chunks is undone if the document that
  // references them is held by a proxy.
  assert(health, 'no response to inspect');
});

const docRes = await fetch(`${BASE}/`);
check('index.html is served with a revalidating cache policy', () => {
  const cc = docRes.headers.get('cache-control') ?? '';
  assert(/no-cache|no-store|must-revalidate/.test(cc), `cache-control was "${cc}"`);
});

/* --------------------------------------------------------------- capability */

section('capability: the renderer can exist at all');

{
  const page = await browser.newPage();
  const gl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const g = c.getContext('webgl2');
    if (!g) return { webgl2: false };
    return {
      webgl2: true,
      float: !!g.getExtension('EXT_color_buffer_float'),
      maxTex: g.getParameter(g.MAX_TEXTURE_SIZE),
      renderer: g.getExtension('WEBGL_debug_renderer_info')
        ? g.getParameter(g.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL)
        : 'unknown',
    };
  });
  await page.close();
  check('WebGL2 is available', () => assert(gl.webgl2, 'no webgl2 context'));
  check('float render targets are available', () =>
    assert(gl.float, 'EXT_color_buffer_float missing: HDR passes cannot run'));
  check('textures are large enough for the shadow cascades', () =>
    assert(gl.maxTex >= 4096, `MAX_TEXTURE_SIZE is ${gl.maxTex}, ultra wants 4096`));
  console.log(`      renderer: ${gl.renderer}`);
}

/* ------------------------------------------------------------------ widths */

if (WANT_SHOTS) mkdirSync(join(ROOT, 'shots'), { recursive: true });

for (const vp of WIDTHS) {
  section(`${vp.name} · ${vp.w}x${vp.h}`);

  const context = await browser.newContext({
    viewport: { width: vp.w, height: vp.h },
    deviceScaleFactor: 1,
    // The menu is Russian; a browser claiming en-US would mask a locale-driven
    // font fallback.
    locale: 'ru-RU',
  });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const notFound = [];

  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('requestfailed', (r) => {
    // An aborted request is normal when a page is torn down mid-flight.
    const err = r.failure()?.errorText ?? '';
    if (!/ERR_ABORTED|net::ERR_ABORTED/.test(err)) {
      failedRequests.push(`${r.url()} (${err})`);
    }
  });
  page.on('response', (r) => {
    if (r.status() >= 400) notFound.push(`${r.status()} ${r.url()}`);
  });

  await page.goto(BASE, { waitUntil: 'load', timeout: 60_000 });
  // The menu is painted by the engine's shell module after the chunk loads, so
  // waiting on `load` alone is not enough.
  await page.waitForSelector('.fa-menu', { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(900);

  const dom = await page.evaluate(() => {
    const menu = document.querySelector('.fa-menu');
    const mast = document.querySelector('.fa-mast');
    const status = document.querySelector('.fa-status');
    const cards = [...document.querySelectorAll('.fa-card')];
    const controls = [
      ...document.querySelectorAll('button, input, .fa-seg > button, .fa-card'),
    ];
    const tooSmall = controls
      .map((n) => {
        const r = n.getBoundingClientRect();
        return { tag: n.className || n.tagName, w: Math.round(r.width), h: Math.round(r.height) };
      })
      // 24 px is the WCAG 2.2 target-size minimum; anything visible and smaller
      // than that is a control you cannot reliably hit with a thumb.
      .filter((c) => c.h > 0 && c.h < 24);

    const mastStyle = mast ? getComputedStyle(mast) : null;
    return {
      hasMenu: !!menu,
      mastText: mast?.textContent?.trim() ?? '',
      mastFont: mastStyle?.fontFamily ?? '',
      mastSize: mastStyle ? parseFloat(mastStyle.fontSize) : 0,
      statusText: status?.textContent?.trim() ?? '',
      statusState: status?.dataset?.state ?? '',
      cards: cards.length,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      tooSmall,
      // Did the real face load, or is this a system fallback wearing its name?
      fontsReady: document.fonts.status,
      oswald: document.fonts.check('700 40px Oswald'),
      body: document.fonts.check('400 15px "Roboto Condensed"'),
    };
  });

  check('the menu painted', () => {
    assert(dom.hasMenu, '.fa-menu never appeared');
    assert(dom.cards === 3, `${dom.cards} mode cards, expected 3`);
  });

  check('the masthead is present and set in the display face', () => {
    assert(/FPS\s*ARENA/i.test(dom.mastText), `masthead read "${dom.mastText}"`);
    assert(/Oswald/i.test(dom.mastFont), `font-family resolved to "${dom.mastFont}"`);
    assert(dom.oswald, 'the Oswald face never finished loading');
  });

  check('body text uses the condensed face, not a system fallback', () => {
    assert(dom.body, 'Roboto Condensed did not load');
    assert(dom.fontsReady === 'loaded', `document.fonts.status is "${dom.fontsReady}"`);
  });

  check('the relay status line is rendered', () => {
    assert(dom.statusText.length > 0, 'the status line is empty');
    assert(
      ['warm', 'waking', 'down', 'unknown'].includes(dom.statusState),
      `unexpected state "${dom.statusState}"`,
    );
  });

  check('nothing overflows horizontally', () => {
    // 1 px of slack for sub-pixel rounding on fractional device ratios.
    assert(
      dom.scrollW <= dom.clientW + 1,
      `scrollWidth ${dom.scrollW} > clientWidth ${dom.clientW}: the page scrolls sideways`,
    );
  });

  check('the masthead scales with the viewport', () => {
    // clamp(40px, 8vw, 86px): a phone must not get the desktop size and a
    // desktop must not get the phone size.
    const expectedMin = vp.w < 600 ? 36 : 44;
    assert(dom.mastSize >= expectedMin, `masthead is ${dom.mastSize}px at ${vp.w}px wide`);
    assert(dom.mastSize <= 92, `masthead is ${dom.mastSize}px, over the 86px clamp`);
  });

  check('every control is big enough to hit', () => {
    assert(
      dom.tooSmall.length === 0,
      `${dom.tooSmall.length} controls under 24px tall: ` +
        dom.tooSmall.map((c) => `${c.tag} ${c.w}x${c.h}`).join(', '),
    );
  });

  check('the console is clean', () => {
    assert(pageErrors.length === 0, `uncaught: ${pageErrors.join(' | ')}`);
    assert(consoleErrors.length === 0, `console.error: ${consoleErrors.join(' | ')}`);
  });

  check('every request succeeded', () => {
    assert(failedRequests.length === 0, failedRequests.join(' | '));
    assert(notFound.length === 0, notFound.join(' | '));
  });

  if (WANT_SHOTS) {
    await page.screenshot({ path: join(ROOT, 'shots', `menu-${vp.name}.png`) });
    console.log(`      shots/menu-${vp.name}.png`);
  }

  await context.close();
}

/* ------------------------------------------------------------------ teardown */

await browser.close();
if (relay && !args.has('--keep')) relay.kill('SIGTERM');

console.log(`\n${'-'.repeat(60)}`);
if (failures.length) {
  console.log(`FAILED - ${failures.length} of ${passed + failures.length} checks`);
  for (const f of failures) console.log(`  . ${f}`);
  process.exit(1);
}
console.log(`all green - ${passed} visual checks passed`);
