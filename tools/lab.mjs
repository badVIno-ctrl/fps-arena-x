#!/usr/bin/env node
/**
 * LAB — the interactive review harness.
 *
 * The gates in this directory answer yes/no questions. This one answers "what
 * does it actually look like right now", which is the question a critic loop
 * needs answered dozens of times per session.
 *
 * It serves the static export, boots the real game in real WebGL2, and then
 * either runs a snippet against the live engine or writes a PNG. One browser,
 * one boot, many probes — booting the world costs ~20 s, so a harness that
 * re-boots per question is useless for iteration.
 *
 * Usage
 *   node tools/lab.mjs shot --name=board --out=shots/board.png \
 *        --script=tools/lab/board.mjs
 *   node tools/lab.mjs eval --script=tools/lab/probe.mjs
 *   node tools/lab.mjs sheet --out=shots/sheet.png   # every weapon, one grid
 *
 * A --script file default-exports `async (page, api) => any`; whatever it
 * returns is printed as JSON. `api` carries { pump, present, shot, log }.
 */

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname, resolve } from 'node:path';

import { resolveBrowser } from './browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'out');

const argv = Object.fromEntries(
  process.argv.slice(3).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const command = process.argv[2] ?? 'shot';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

/** Static host for out/. No dependency on the python relay being installed. */
function serve(port) {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      let file = join(OUT, p);
      if (!existsSync(file)) {
        // Trailing-slash export: /foo -> /foo/index.html
        const alt = join(OUT, p, 'index.html');
        file = existsSync(alt) ? alt : join(OUT, 'index.html');
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(404).end(String(err));
    }
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

const PORT = Number(argv.port ?? 8791);
const W = Number(argv.w ?? 1920);
const H = Number(argv.h ?? 1080);

/** `--base=http://127.0.0.1:3000` drives an already-running `next dev`, which is
 *  the only way to get an unminified stack out of a boot failure. */
const BASE = argv.base ? String(argv.base) : null;
if (!BASE && !existsSync(join(OUT, 'index.html'))) {
  console.error('out/ is missing — run `pnpm build` first');
  process.exit(1);
}

const server = BASE ? { close() {} } : await serve(PORT);
const { launch, describe } = await resolveBrowser();
console.error(`lab: ${describe()}`);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const query = new URLSearchParams({
  capture: '1',
  lockstep: argv.free ? '0' : '1',
  mode: String(argv.mode ?? 'bots'),
  submode: String(argv.submode ?? 'dm'),
  difficulty: String(argv.difficulty ?? 'normal'),
  q: String(argv.q ?? 'ultra'),
});
if (argv.prewarm === '0') query.set('prewarm', '0');

let failure = null;
try {
  await page.goto(`${BASE ?? `http://127.0.0.1:${PORT}`}/?${query}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120_000,
  });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 180_000 });

  const api = {
    pump: (n = 1) => page.evaluate((k) => window.__PUMP__(k), n),
    present: (n = 2) => page.evaluate((k) => window.__PRESENT__(k), n),
    shot: (name, opts = {}) =>
      page.evaluate(([n, o]) => window.__APPLY_SHOT__(n, o), [name, opts]),
    log: (...a) => console.error(...a),
    async png(file) {
      await mkdir(dirname(resolve(ROOT, file)), { recursive: true });
      await page.screenshot({ path: resolve(ROOT, file), timeout: 120_000, animations: 'disabled' });
      console.error(`wrote ${file}`);
    },
  };

  let result = null;
  if (argv.script) {
    const mod = await import(pathToFileURL(resolve(ROOT, String(argv.script))).href);
    result = await mod.default(page, api);
  } else if (argv.name) {
    await api.shot(String(argv.name));
    await api.pump(Number(argv.settle ?? 40));
    await api.present(3);
  }

  if (command === 'shot' || argv.out) {
    await api.pump(Number(argv.settle ?? 8));
    await api.present(3);
    await api.png(String(argv.out ?? 'shots/lab.png'));
  }
  if (result !== undefined && result !== null) console.log(JSON.stringify(result, null, 2));
} catch (err) {
  failure = err;
} finally {
  const bad = logs.filter((l) => /pageerror|\[error\]/.test(l));
  if (bad.length) console.error('\n--- console errors ---\n' + bad.slice(0, 40).join('\n'));
  if (argv.logs) console.error('\n--- console ---\n' + logs.slice(-120).join('\n'));
  await browser.close();
  server.close();
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
