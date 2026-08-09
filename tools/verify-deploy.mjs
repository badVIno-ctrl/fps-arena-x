#!/usr/bin/env node
/**
 * GATE — deployment and keep-alive consistency.
 *
 * The keep-alive design is spread across five files that have to agree with each
 * other, and every one of them is edited for an unrelated reason sooner or later:
 *
 *   next.config.mjs                     must produce a static tree
 *   Dockerfile                          must copy that tree where the relay looks
 *   render.yaml                         must point its health check at a route
 *                                       that exists, on the free plan
 *   server/keepalive.py                 must ping well inside 15 minutes
 *   .github/workflows/keepalive.yml     must run well inside 15 minutes
 *   game/net/heartbeat.js               must beat well inside 15 minutes
 *
 * None of that can be checked by running the game: a mistake here shows up as a
 * sleeping service three weeks later, when nobody is looking. So it is checked
 * as arithmetic on the files themselves, in plain node, with no network.
 *
 * Run: node tools/verify-deploy.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** Render stops a free web service after this long without inbound HTTP. */
const SPIN_DOWN_S = 15 * 60;

let failures = 0;
let checks = 0;
let group = '';

function section(name) {
  group = name;
  console.log(`\n${name}`);
}

function check(name, fn) {
  checks++;
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (err) {
    failures++;
    console.log(`  x  ${name}`);
    console.log(`      ${err.message}`);
    check.failed ??= [];
    check.failed.push(`${group} / ${name}: ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** First integer after `label` in `text`, or null. */
function num(text, label) {
  const m = text.match(new RegExp(`${label}[^0-9-]{0,40}(-?\\d+)`));
  return m ? Number(m[1]) : null;
}

// --------------------------------------------------------------- static build

section('build: the client is a static tree the relay can serve');

const NEXT_CONFIG = read('next.config.mjs');

check('next is configured to export, not to run a node server', () => {
  assert(/output:\s*'export'/.test(NEXT_CONFIG), "next.config.mjs has no output:'export'");
});

check('images are unoptimized, because there is no image server', () => {
  // next/image's optimizer is a server feature. With `output: 'export'` a
  // missing `unoptimized` is a build error, not a runtime one — but the build
  // error only appears once someone adds an <Image>, which is a bad time.
  assert(/unoptimized:\s*true/.test(NEXT_CONFIG), 'images.unoptimized is not set');
});

check('the relay looks for the directory next actually writes', () => {
  const server = read('server/main.py');
  assert(/"out"/.test(server), 'server/main.py never looks for ./out');
  assert(
    server.indexOf('"out"') < server.indexOf('"dist"'),
    'dist/ is checked before out/, so a stale Vite build would win over a fresh next export',
  );
});

// ------------------------------------------------------------------- container

section('image: one process serves the page and the websocket');

const DOCKERFILE = read('Dockerfile');

check('the build stage is thrown away', () => {
  assert(/AS client/.test(DOCKERFILE), 'no named client build stage');
  assert(/FROM python:.* AS runtime/.test(DOCKERFILE), 'no python runtime stage');
  assert(/--from=client/.test(DOCKERFILE), 'the runtime never copies the built bundle');
});

check('the bundle lands where the relay searches', () => {
  // /app/server is the working directory, so PROJECT_DIR is /app and the tree
  // has to be /app/out. Getting this wrong yields a 503 with a helpful message
  // and a completely blank game.
  assert(/--from=client \/build\/out \.\/out/.test(DOCKERFILE), 'the export is not copied to /app/out');
  assert(/WORKDIR \/app\/server/.test(DOCKERFILE), 'uvicorn would not find main:app');
});

check('the container does not run as root', () => {
  assert(/USER arena/.test(DOCKERFILE), 'no unprivileged user');
});

check('one worker only', () => {
  // Room state lives in process memory. A second worker would put two players in
  // two different worlds and the bug would look like packet loss.
  assert(/--workers 1/.test(DOCKERFILE), 'uvicorn is not pinned to a single worker');
});

check('the port comes from the platform', () => {
  assert(/\$\{PORT:-\d+\}/.test(DOCKERFILE), 'the port is hardcoded; Render assigns it');
});

// --------------------------------------------------------------------- render

section('render.yaml: what the free tier will accept');

const RENDER = read('render.yaml');

check('the service is on the free plan', () => {
  assert(/plan:\s*free/.test(RENDER), 'the blueprint does not request the free plan');
});

check('it builds the Dockerfile in this repository', () => {
  assert(/runtime:\s*docker/.test(RENDER), 'not a docker service');
  assert(/dockerfilePath:\s*\.\/Dockerfile/.test(RENDER), 'no dockerfilePath');
});

check('the health check points at a route that exists', () => {
  const m = RENDER.match(/healthCheckPath:\s*(\S+)/);
  assert(m, 'no healthCheckPath');
  const path = m[1];
  const server = read('server/main.py');
  assert(
    new RegExp(`@app\\.get\\("${path}"\\)`).test(server),
    `render.yaml health-checks ${path}, which server/main.py does not define`,
  );
});

check('keep-alive is on by default in production', () => {
  assert(/key: KEEPALIVE\b[\s\S]{0,40}value: "1"/.test(RENDER), 'KEEPALIVE is not enabled');
});

// ------------------------------------------------------------------ keepalive

section('keep-alive: the arithmetic against a 15-minute spin-down');

const KEEPALIVE_PY = read('server/keepalive.py');

check('layer 1 checks often enough to notice, and pings before the deadline', () => {
  const period = num(KEEPALIVE_PY, 'period: int =');
  const idle = num(KEEPALIVE_PY, 'idle_threshold: int =');
  assert(period && idle, 'could not read the defaults out of KeepAliveConfig');
  // Worst case: silence for `idle`, then up to one more `period` before the loop
  // looks. That total is what has to fit inside the platform's window.
  const worst = idle + period;
  assert(
    worst < SPIN_DOWN_S,
    `worst-case ${worst}s is not inside the ${SPIN_DOWN_S}s spin-down`,
  );
  assert(
    SPIN_DOWN_S - worst >= 120,
    `only ${SPIN_DOWN_S - worst}s of slack; a late tick would let the service sleep`,
  );
});

/**
 * Python source with docstrings and comments removed.
 *
 * Needed because this file's prose talks about the wrong ways to do things —
 * "a request to 127.0.0.1 counts for nothing" is an explanation, not a bug — and
 * a check that reads documentation as if it were code fails on its own comments.
 */
function pythonCodeOnly(src) {
  return src
    .replace(/"""[\s\S]*?"""/g, '')
    .replace(/'''[\s\S]*?'''/g, '')
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
}

check('layer 1 pings the public URL, not localhost', () => {
  // Only traffic that arrives at Render's edge resets the idle timer. A request
  // to 127.0.0.1 never leaves the container and counts for nothing.
  assert(/RENDER_EXTERNAL_URL/.test(KEEPALIVE_PY), 'the external URL is never read');
  const code = pythonCodeOnly(KEEPALIVE_PY);
  assert(!/127\.0\.0\.1|localhost/.test(code), 'it pings itself locally');
  assert(
    /f"\{self\.config\.external_url\}\/healthz"/.test(code),
    'the ping target is not built from the configured external URL',
  );
});

check('layer 1 marks its own requests so they do not look like players', () => {
  assert(/PING_HEADER/.test(KEEPALIVE_PY), 'no ping header');
  const server = read('server/main.py');
  assert(
    /request\.headers\.get\(PING_HEADER\)/.test(server),
    'the relay counts keep-alive pings as real traffic, so it would never go quiet',
  );
});

check('layer 1 is idle-driven, to protect the 750 free instance-hours', () => {
  assert(/should_ping/.test(KEEPALIVE_PY), 'no idle gate');
  assert(/skipped_busy/.test(KEEPALIVE_PY), 'skipping a busy service is not even counted');
});

check('layer 1 cannot take the server down with it', () => {
  assert(
    /except Exception as exc:\s*#? ?a keep-alive must never kill the server|except Exception as exc:/.test(
      KEEPALIVE_PY,
    ),
    'the loop has no catch-all; one DNS failure would end the task',
  );
  assert(/max_backoff/.test(KEEPALIVE_PY), 'a failing ping would retry forever at full rate');
});

check('layer 2 runs from outside, often enough to wake a stopped service', () => {
  const wf = read('.github/workflows/keepalive.yml');
  const m = wf.match(/cron:\s*'([^']+)'/);
  assert(m, 'no cron schedule');
  const spec = m[1].trim().split(/\s+/)[0];
  const every = spec.match(/^\*\/(\d+)$/);
  assert(every, `minute field ${spec} is not a */N interval`);
  const minutes = Number(every[1]);
  assert(
    minutes * 60 < SPIN_DOWN_S,
    `${minutes} minutes is not inside the ${SPIN_DOWN_S / 60}-minute spin-down`,
  );
  // GitHub's scheduler is routinely several minutes late; a 14-minute interval
  // would be arithmetically fine and operationally useless.
  assert(minutes <= 10, `${minutes} minutes leaves no room for a late run`);
  assert(/workflow_dispatch/.test(wf), 'no manual trigger to re-enable a disabled schedule');
  assert(/vars.RENDER_URL/.test(wf), 'the workflow has no URL to ping');
});

check('layer 2 survives a cold start instead of failing on it', () => {
  const wf = read('.github/workflows/keepalive.yml');
  assert(/attempt/.test(wf) && /sleep \$delay/.test(wf), 'no retry loop');
  assert(/--max-time 45/.test(wf), 'the timeout is too short for a container pull');
});

check('layer 3 beats while a tab is open, and only where that means something', () => {
  const hb = read('game/net/heartbeat.js');
  const m = hb.match(/PERIOD_MS\s*=\s*([\d\s*]+);/);
  assert(m, 'no beat period');
  // eslint-disable-next-line no-new-func -- a literal arithmetic expression from our own source
  const ms = Function(`return ${m[1]}`)();
  assert(ms / 1000 < SPIN_DOWN_S, `${ms}ms is longer than the spin-down`);
  assert(ms >= 60_000, 'beating more than once a minute is waste, not safety');
  assert(/isLocalHost/.test(hb), 'a dev server would be pinged for nothing');
  assert(/MAX_FAILURES/.test(hb), 'an offline tab would hammer a dead server forever');
  assert(/dispose\(\)/.test(hb), 'no teardown; a remount would stack heartbeats');
});

check('layer 3 is wired into boot and torn down with it', () => {
  const boot = read('game/boot.js');
  assert(/new Heartbeat\(/.test(boot), 'the heartbeat is never constructed');
  assert(/heartbeat\?\.dispose\(\)/.test(boot), 'dispose() does not stop the heartbeat');
  assert(
    /capture \? null : new Heartbeat/.test(boot),
    'a capture run would make network requests and stop being reproducible',
  );
});

// ------------------------------------------------------------------ vercel-free

section('the project no longer assumes Vercel');

check('no analytics beacon is shipped to a host we do not deploy to', () => {
  const layout = read('app/layout.tsx');
  assert(!/@vercel\/analytics/.test(layout), 'app/layout.tsx still loads Vercel Analytics');
});

check('the entry document is still complete', () => {
  const layout = read('app/layout.tsx');
  assert(/lang="ru"/.test(layout), 'the html lang attribute was lost');
  assert(/export const metadata/.test(layout), 'metadata was lost');
  // The font variables moved out of layout.tsx when the faces were self-hosted;
  // what has to remain true is that the document still ships them and preloads
  // the one the masthead is set in. verify-shell.mjs owns the deeper font rules.
  assert(/rel="preload"/.test(layout), 'no font preload: the masthead swaps in late');
  assert(/--font-display/.test(read('app/fonts.css')), 'the display font variable was lost');
});

check('the docker context excludes what must not be uploaded', () => {
  assert(existsSync(join(ROOT, '.dockerignore')), 'no .dockerignore');
  const ignore = read('.dockerignore');
  for (const entry of ['node_modules', '.git', 'out', '.next']) {
    assert(new RegExp(`^${entry.replace('.', '\\.')}$`, 'm').test(ignore), `${entry} is not ignored`);
  }
});

// ---------------------------------------------------------------------- report

console.log(`\n${'-'.repeat(60)}`);
if (failures) {
  console.log(`FAILED - ${failures} of ${checks} checks`);
  for (const f of check.failed ?? []) console.log(`  . ${f}`);
  process.exit(1);
}
console.log(`all green - ${checks} deploy checks passed`);
