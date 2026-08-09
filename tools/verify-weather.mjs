#!/usr/bin/env node
/**
 * GATE — weather and night vision.
 *
 * Both subsystems are mostly shaders, and a shader cannot be checked in node. So
 * this gate checks the part that CAN be: the numbers that decide what the enemy
 * is able to do, and the wiring that carries them.
 *
 * The distinction it enforces is the one the weather file is built around:
 * weather that only changes pixels is a filter, weather that changes what the AI
 * can do is a mechanic. A preset missing `soundMask` is a weather type that
 * silently has no gameplay effect, and nothing in a screenshot would ever show it.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GAME = join(ROOT, 'game');
const load = (rel) => import(pathToFileURL(join(GAME, rel)).href);
const src = (rel) => readFileSync(join(GAME, rel), 'utf8');

let passed = 0;
const failures = [];
let group = '';

function section(name) {
  group = name;
  console.log(`\n${name}`);
  console.log('-'.repeat(60));
}
function check(name, fn) {
  try {
    const note = fn();
    passed++;
    console.log(`  ok   ${name}${note ? ` — ${note}` : ''}`);
  } catch (err) {
    failures.push({ name: `${group} / ${name}`, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
function assert(c, m) {
  if (!c) throw new Error(m);
}

const W = await load('weather/index.js');
const { NVG } = await load('vision/index.js');

/* ------------------------------------------------------------------ presets */

section('weather: the table is complete');

check('every preset declares every field', () => {
  for (const name of W.PRESET_ORDER) {
    const p = W.PRESETS[name];
    assert(p, `no preset "${name}"`);
    for (const f of W.PRESET_FIELDS) {
      assert(p[f] !== undefined, `${name} is missing "${f}" — that weather type would have no effect`);
    }
    assert(typeof p.sky === 'object', `${name}.sky is not a patch`);
  }
  return `${W.PRESET_ORDER.length} presets x ${W.PRESET_FIELDS.length} fields`;
});

check('the preset order and the table agree', () => {
  const keys = Object.keys(W.PRESETS).sort().join();
  assert(keys === [...W.PRESET_ORDER].sort().join(), 'PRESET_ORDER has drifted from PRESETS');
});

check('every sky patch touches the same set of atmosphere knobs', () => {
  // A patch that omits a knob leaves the PREVIOUS weather's value in place, so a
  // transition into it would inherit whatever came before — the classic source of
  // "the fog never lifted".
  const ref = Object.keys(W.PRESETS.clear.sky).sort().join();
  for (const name of W.PRESET_ORDER) {
    const k = Object.keys(W.PRESETS[name].sky).sort().join();
    assert(k === ref, `${name}.sky has a different shape: a missing knob would be inherited`);
  }
});

/* ------------------------------------------------------- the actual mechanic */

section('weather: the consequences point the right way');

check('fog is the shortest sight line, clear is the longest', () => {
  const vis = W.PRESET_ORDER.map((n) => [n, W.PRESETS[n].visibility]).sort((a, b) => a[1] - b[1]);
  assert(vis[0][0] === 'fog', `shortest visibility is ${vis[0][0]}, expected fog`);
  assert(vis[vis.length - 1][0] === 'clear', `longest is ${vis[vis.length - 1][0]}, expected clear`);
  return vis.map(([n, v]) => `${n} ${v}m`).join(' · ');
});

check('rain and storm mask the most sound; fog masks almost none', () => {
  const P = W.PRESETS;
  assert(P.storm.soundMask > P.rain.soundMask, 'a storm should be louder than rain');
  assert(P.rain.soundMask > P.overcast.soundMask, 'rain should mask more than overcast');
  assert(P.fog.soundMask < 0.15, `fog masks ${P.fog.soundMask} of sound: fog is quiet`);
  assert(P.clear.soundMask === 0, 'clear weather should mask nothing');
});

check('fog and rain are opposite trades, not two versions of the same thing', () => {
  // This is the design claim the two presets exist to make: fog cuts sight and
  // leaves hearing, rain cuts hearing and leaves more sight. If both cut both,
  // there is only one weather type wearing two names.
  const { fog, rain } = W.PRESETS;
  assert(fog.visibility < rain.visibility, 'fog should be blinder than rain');
  assert(rain.soundMask > fog.soundMask, 'rain should be deafer than fog');
  return `fog ${fog.visibility}m/${fog.soundMask} vs rain ${rain.visibility}m/${rain.soundMask}`;
});

check('wetness rises with rain and is zero in the dust', () => {
  const P = W.PRESETS;
  assert(P.storm.wetness >= P.rain.wetness, 'a storm should be at least as wet as rain');
  assert(P.rain.wetness > P.overcast.wetness, 'rain should be wetter than overcast');
  assert(P.clear.wetness === 0 && P.dust.wetness === 0, 'clear and dust should be dry');
});

check('the AI scales move monotonically with the weather', () => {
  let lastView = Infinity;
  for (const name of ['clear', 'overcast', 'rain', 'storm']) {
    const v = W.viewScaleFor(W.PRESETS[name].visibility);
    assert(v <= lastView + 1e-9, `${name} sees further than the weather before it`);
    lastView = v;
    assert(v > 0 && v <= 1, `${name} view scale ${v} is out of range`);
  }
  for (const name of W.PRESET_ORDER) {
    const h = W.hearingScaleFor(W.PRESETS[name].soundMask);
    assert(h > 0 && h <= 1, `${name} hearing scale ${h} is out of range`);
  }
  return `clear x${W.viewScaleFor(W.PRESETS.clear.visibility).toFixed(2)} → fog x${W.viewScaleFor(W.PRESETS.fog.visibility).toFixed(2)}`;
});

check('fog actually makes an agent nearly blind at its own view range', () => {
  // The agent's declared range, read out of the source so this cannot drift.
  const agent = src('ai/agent.js');
  const m = agent.match(/this\.viewRange\s*=\s*([\d.]+)/);
  assert(m, 'could not find viewRange in the agent');
  const base = Number(m[1]);
  const fogged = base * W.viewScaleFor(W.PRESETS.fog.visibility);
  assert(fogged < base * 0.35, `fog leaves ${fogged.toFixed(1)} m of ${base} m: not enough to feel`);
  assert(fogged > 5, `fog leaves ${fogged.toFixed(1)} m: the AI would be unplayably blind`);
  return `${base} m → ${fogged.toFixed(1)} m`;
});

/* ---------------------------------------------------------------- blending */

section('weather: transitions cannot get stuck');

check('blend hits both endpoints exactly', () => {
  const a = W.PRESETS.clear;
  const b = W.PRESETS.storm;
  const at0 = W.blend(a, b, 0);
  const at1 = W.blend(a, b, 1);
  for (const f of ['wetness', 'rain', 'visibility', 'soundMask']) {
    assert(Math.abs(at0[f] - a[f]) < 1e-9, `blend(0).${f} is ${at0[f]}, expected ${a[f]}`);
    assert(Math.abs(at1[f] - b[f]) < 1e-9, `blend(1).${f} is ${at1[f]}, expected ${b[f]}`);
  }
});

check('blend is clamped, so an overshooting timer cannot invent weather', () => {
  const a = W.PRESETS.clear;
  const b = W.PRESETS.fog;
  const over = W.blend(a, b, 4.5);
  assert(Math.abs(over.visibility - b.visibility) < 1e-9, `t=4.5 gave ${over.visibility} m`);
  const under = W.blend(a, b, -2);
  assert(Math.abs(under.visibility - a.visibility) < 1e-9, `t=-2 gave ${under.visibility} m`);
});

check('a midpoint is between its endpoints for every pair', () => {
  for (const x of W.PRESET_ORDER) {
    for (const y of W.PRESET_ORDER) {
      const mid = W.blend(W.PRESETS[x], W.PRESETS[y], 0.5);
      const lo = Math.min(W.PRESETS[x].visibility, W.PRESETS[y].visibility);
      const hi = Math.max(W.PRESETS[x].visibility, W.PRESETS[y].visibility);
      assert(mid.visibility >= lo - 1e-9 && mid.visibility <= hi + 1e-9, `${x}->${y} midpoint escaped`);
    }
  }
  return `${W.PRESET_ORDER.length ** 2} pairs`;
});

check('the surface weather vector stays in the shader contract', () => {
  for (const w of [0, 0.25, 0.5, 0.75, 1]) {
    const v = W.surfaceWeather(w);
    assert(v.length === 4, `surfaceWeather(${w}) returned ${v.length} channels, the uniform is a vec4`);
    for (const c of v) assert(c >= 0 && c <= 2 && Number.isFinite(c), `channel ${c} out of range at wetness ${w}`);
  }
  // Rain washes dust off: the dust channel has to FALL as wetness rises.
  assert(W.surfaceWeather(1)[0] < W.surfaceWeather(0)[0], 'rain should wash dust off, not add it');
  // Runoff and spray both rise.
  assert(W.surfaceWeather(1)[1] > W.surfaceWeather(0)[1], 'wetness should add vertical runoff');
  assert(W.surfaceWeather(1)[2] > W.surfaceWeather(0)[2], 'wetness should raise the splash band');
});

/* ------------------------------------------------------------------ wiring */

section('weather: it is actually connected');

check('the AI reads both scales where it computes a range', () => {
  const agent = src('ai/agent.js');
  const ai = src('ai/index.js');
  assert(/viewRangeScale/.test(agent), 'the agent never reads viewRangeScale: fog would be a filter');
  assert(/hearingScale/.test(ai), 'the AI never reads hearingScale: rain would be a filter');
  assert(/this\.viewRangeScale = 1/.test(ai), 'the AI must default the scale to 1 without weather');
  assert(/this\.hearingScale = 1/.test(ai), 'the AI must default hearing to 1 without weather');
});

check('weather does not import the AI, and the AI does not import weather', () => {
  const w = src('weather/index.js');
  const ai = src('ai/index.js');
  assert(!/from '\.\.\/ai\//.test(w), 'weather imports ai: the dependency must be injection only');
  assert(!/from '\.\.\/weather\//.test(ai), 'ai imports weather: that is a cycle');
  assert(/peek\('ai'\)/.test(w), 'weather should reach the AI through the registry, optionally');
});

check('the rain field is one draw and keeps out of the prepass', () => {
  const w = src('weather/index.js');
  assert(/InstancedBufferGeometry/.test(w), 'rain should be instanced, not one mesh per drop');
  assert(/owNoPrepass/.test(w), 'rain in the velocity buffer would smear the frame under TAA');
  assert(/owNoShadow/.test(w), 'rain must not cast into the cascades');
});

/* --------------------------------------------------------------------- NVG */

section('night vision: an intensifier, not a green filter');

check('the tube costs something', () => {
  assert(NVG.tubeRadius < 0.85, `a tube radius of ${NVG.tubeRadius} is not a tube, it is the screen`);
  assert(NVG.batteryLife > 60 && NVG.batteryLife < 1800, `${NVG.batteryLife}s of battery is not a decision`);
  assert(NVG.softness > 0, 'an intensified image is not sharper than the naked eye');
  return `${NVG.tubeRadius} radius · ${NVG.batteryLife}s · gain x${NVG.gain}`;
});

check('gain and noise are chosen together, against the night signal', () => {
  /**
   * THIS CHECK'S FIRST VERSION WAS WRONG, and recording that is the point.
   *
   * It asserted `gain > 10`, on the reasoning that a small gain would not make a
   * moonlit street usable. Rendering it said otherwise: the engine's AUTO-EXPOSURE
   * runs after the pass and adapts to whatever it produces, so a large fixed gain
   * is counted twice — the pass brightens, the meter stops down, and the histogram
   * ends up jammed against the top. At x42 the tube was a white blur.
   *
   * The gain's real job is narrower: lift the signal clear of the SHOT-NOISE FLOOR
   * before the meter looks at it. So the requirement is a relationship between two
   * constants rather than a floor under one of them, and it is stated the way the
   * shader computes it — relative noise = coefficient / sqrt(signal * gain).
   *
   * Same lesson as the heat curve: when a gate goes red, first ask whether its
   * premise is true.
   */
  // Linear radiance of a moonlit street in this engine's units, near enough.
  const night = 0.01;
  const rel = Math.min(0.72, NVG.noise / Math.sqrt(night * NVG.gain));
  assert(rel < 0.5, `at x${NVG.gain} gain the night image is ${(rel * 100) | 0}% noise: unusable`);
  assert(rel > 0.15, `at x${NVG.gain} gain the night image is only ${(rel * 100) | 0}% noise: too clean to be a tube`);
  // And it must not be so much gain that the meter has nothing left to do.
  assert(night * NVG.gain < 0.5, `x${NVG.gain} gain puts a night scene at ${night * NVG.gain} linear: blown out`);
  assert(NVG.gateStrength > 0.5, 'without a bright-source gate, light is not a counter to goggles');
  return `x${NVG.gain} gain → ${(rel * 100) | 0}% noise at night`;
});

check('the noise is relative, not absolute, and is bounded', () => {
  const v = src('vision/index.js');
  assert(
    /lit \*= 1\.0 \+ grain \* rel \* amount/.test(v),
    'the noise is added absolutely: at a night signal of 0.02 an absolute 1/sqrt term ' +
      'reaches 2.4, i.e. a hundred times the image, and the tube renders as falling characters',
  );
  assert(/min\(0\.72/.test(v), 'the relative noise is unbounded: a black corner would flicker white');
  assert(
    /gl_FragCoord/.test(v),
    'the noise is sampled from scaled uv: on a non-square frame that gives non-square ' +
      'cells, which reads as streaks rather than as grain',
  );
  // Matched on the old hash's BODY rather than on its constants: the constants are
  // named in a comment that explains why it was replaced, and a check that trips on
  // its own documentation is a check nobody will keep.
  assert(!/p \+= dot\(p, p \+ 19\.19\)/.test(v), 'the streaky hash is back');
  assert(/uvec2/.test(v), 'the hash is not integer bit mixing: streaks will return');
});

check('the warm-up is felt and the fade is faster than it', () => {
  assert(NVG.warmup > 0.2, 'an instant tube reads as a post effect, not as equipment');
  assert(NVG.cooldown < NVG.warmup, 'phosphor decays faster than a tube warms up');
});

check('noise scales with 1/sqrt(signal): heavy in the dark, not uniform', () => {
  const v = src('vision/index.js');
  assert(/sqrt\(max\(/.test(v), 'the noise term is not inverse-square-root: it would read as film grain');
  assert(/uExposure/.test(v), 'the gate has to read the engine exposure, or it cannot know what is bright');
  assert(/uPhosphor/.test(v), 'no phosphor colour');
});

check('the tube includes the weapon in your hands', () => {
  const v = src('vision/index.js');
  const r = src('render/index.js');
  assert(/afterViewmodel/.test(v), 'the pass runs before the viewmodel composite');
  assert(/viewPasses/.test(r), 'render has no after-viewmodel hook');
  // And it still has to be before metering, or exposure would adapt to the
  // pre-tube image and fight the gain.
  const i = r.indexOf('this.viewPasses.length');
  const j = r.indexOf('// ---- 15. metering');
  assert(i > 0 && j > i, 'the after-viewmodel passes do not run before metering');
});

check('the pass runs before metering and before the low-health pass', () => {
  const v = src('vision/index.js');
  const low = src('player/lowhealth.js');
  const nvgOrder = Number(v.match(/this\.order = (\d+)/)[1]);
  const lowOrder = Number(low.match(/this\.order = (\d+)/)[1]);
  assert(nvgOrder < lowOrder, `NVG at ${nvgOrder} must run before low-health at ${lowOrder}`);
  return `order ${nvgOrder} < ${lowOrder}`;
});

check('the battery drains on the picture, not on the switch', () => {
  const v = src('vision/index.js');
  const upd = v.slice(v.indexOf('update(dt, ctx)'));
  assert(
    /this\.amount > 0\.001/.test(upd),
    'draining on `wanted` instead of on `amount` lets a player spam the key for free power',
  );
});

check('a flat battery is visible before it is empty', () => {
  const v = src('vision/index.js');
  assert(/battery \/ 0\.12/.test(v), 'no brown-out: the picture would just switch off with no warning');
});

check('night vision has a binding that is not already taken', () => {
  const inp = src('core/input.js');
  const m = inp.match(/ACTIONS = \{([\s\S]*?)\n\};/);
  assert(m, 'could not read ACTIONS');
  const body = m[1];
  assert(/nvg:/.test(body), 'no nvg action');
  // Count how many actions claim each key: a double-booked key is a keypress
  // that does two things with nothing to arbitrate.
  const counts = new Map();
  for (const line of body.split('\n')) {
    const am = line.match(/^\s*([A-Za-z]+):\s*\[([^\]]+)\]/);
    if (!am) continue;
    for (const raw of am[2].split(',')) {
      const key = raw.trim().replace(/['"]/g, '');
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? []).concat(am[1]));
    }
  }
  const nvgKeys = counts.get('KeyO') ?? [];
  assert(nvgKeys.includes('nvg'), 'nvg is not bound to KeyO');
  assert(nvgKeys.length === 1, `KeyO is shared by ${nvgKeys.join(', ')}`);
  // The known and documented exception is the weapon light on both T and N.
  for (const [key, owners] of counts) {
    if (owners.length <= 1) continue;
    const set = new Set(owners);
    assert(
      set.size === 1,
      `${key} is claimed by ${[...set].join(' and ')}: one press, two verbs, no arbitration`,
    );
  }
  return `${counts.size} keys bound, none double-booked`;
});

/* ------------------------------------------------------- the integration test */

section('weather: it applies, not just resolves');

/**
 * BOOT THE SUBSYSTEM FOR REAL, against a stub context.
 *
 * This section exists because of a defect the source-reading checks above could
 * not see and a live probe found in one line: `set(name, { fade: 0 })` resolved
 * the new state into `current` and never pushed it anywhere, because `#apply` was
 * only reachable from the transition branch in `update()` — and a fade of 0
 * leaves `_t` already at 1. Fog therefore rolled in with the AI's view scale
 * still at exactly 1.0: a filter.
 *
 * "The wiring exists" and "the wiring runs" are different claims. Checking the
 * first by grep is cheap and was not enough. Nothing here needs a GPU: the rain
 * field builds plain BufferGeometry, and the sky and material banks are stubbed.
 */
async function bootWeather() {
  const { WeatherSystem } = W;
  const skyPatches = [];
  const tuned = [];
  const ai = { viewRangeScale: 1, hearingScale: 1, agents: [] };
  const fakeMaterial = { userData: {} };
  const ctx = {
    config: { quality: 'low', q: 1 },
    scene: { add() {}, remove() {} },
    camera: { matrixWorld: { elements: new Array(16).fill(0) } },
    events: { emit() {}, on: () => () => {} },
    get: (id) =>
      id === 'sky'
        ? { setWeather: (p) => skyPatches.push(p), weather: { windAngle: 0 } }
        : { materials: () => [fakeMaterial], tune: (m, c) => tuned.push(c) },
    peek: (id) => (id === 'ai' ? ai : null),
  };
  const w = new WeatherSystem();
  await w.init(ctx);
  return { w, ai, skyPatches, tuned };
}

const booted = await bootWeather();

check('a snapped weather change reaches the AI on the spot', () => {
  const { w, ai } = booted;
  w.set('fog', { fade: 0 });
  assert(
    ai.viewRangeScale < 0.5,
    `fog left the AI view scale at ${ai.viewRangeScale}: the change resolved but never applied`,
  );
  w.set('storm', { fade: 0 });
  assert(ai.hearingScale < 0.5, `a storm left hearing at ${ai.hearingScale}`);
  w.set('clear', { fade: 0 });
  assert(Math.abs(ai.viewRangeScale - 1) < 1e-6, `clear left the view scale at ${ai.viewRangeScale}`);
  assert(Math.abs(ai.hearingScale - 1) < 1e-6, `clear left hearing at ${ai.hearingScale}`);
  return 'fog, storm and clear all land';
});

check('a snapped change reaches the sky and the surfaces too', () => {
  const { w, skyPatches, tuned } = booted;
  const skyBefore = skyPatches.length;
  const tunedBefore = tuned.length;
  w.set('rain', { fade: 0 });
  assert(skyPatches.length > skyBefore, 'the sky was never told it is raining');
  assert(tuned.length > tunedBefore, 'no surface was retuned: nothing would look wet');
  const last = tuned[tuned.length - 1];
  assert(Array.isArray(last.weather) && last.weather.length === 4, 'the surface patch is not a vec4');
  assert(last.weather[1] > 0.5, `runoff is only ${last.weather[1]} in the rain`);
});

check('a faded change arrives by the end of the fade and not before', () => {
  const { w, ai } = booted;
  w.set('clear', { fade: 0 });
  w.set('fog', { fade: 4 });
  const ctxStub = { camera: booted.w.ctx?.camera ?? { matrixWorld: { elements: new Array(16).fill(0) } } };
  // Halfway: partly applied, definitely not finished.
  for (let i = 0; i < 20; i++) w.update(0.1, w.ctx);
  const mid = ai.viewRangeScale;
  assert(mid < 1 && mid > W.viewScaleFor(W.PRESETS.fog.visibility), `midpoint scale ${mid} is not between`);
  for (let i = 0; i < 25; i++) w.update(0.1, w.ctx);
  const end = ai.viewRangeScale;
  assert(
    Math.abs(end - W.viewScaleFor(W.PRESETS.fog.visibility)) < 1e-3,
    `the fade ended at ${end}, expected ${W.viewScaleFor(W.PRESETS.fog.visibility)}`,
  );
  return `mid ${mid.toFixed(3)} → end ${end.toFixed(3)}`;
});

check('changing weather mid-transition does not jump back to the start', () => {
  const { w, ai } = booted;
  w.set('clear', { fade: 0 });
  w.set('fog', { fade: 10 });
  for (let i = 0; i < 30; i++) w.update(0.1, w.ctx);
  const partway = ai.viewRangeScale;
  // Redirect to storm from HERE. The new blend must start from the live state, not
  // from `clear`, or the fog would visibly lift before the storm arrived.
  w.set('storm', { fade: 10 });
  w.update(0.016, w.ctx);
  const justAfter = ai.viewRangeScale;
  assert(
    Math.abs(justAfter - partway) < 0.05,
    `redirecting jumped the view scale from ${partway.toFixed(3)} to ${justAfter.toFixed(3)}`,
  );
});

check('an unknown preset is refused and changes nothing', () => {
  const { w, ai } = booted;
  w.set('clear', { fade: 0 });
  const before = ai.viewRangeScale;
  const r = w.set('hurricane', { fade: 0 });
  assert(r.ok === false, 'an unknown preset was accepted');
  assert(ai.viewRangeScale === before, 'a refused preset still moved the AI');
  assert(w.preset === 'clear', `the preset name changed to ${w.preset} on a refusal`);
});

/* ------------------------------------------------------------------ report */

console.log('\n' + '='.repeat(60));
if (failures.length) {
  console.log(`${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) {
    console.log(`--- ${f.name}`);
    console.log(String(f.err.stack || f.err.message).split('\n').slice(0, 5).join('\n'));
    console.log();
  }
  process.exit(1);
}
console.log(`all green — ${passed} weather and vision checks passed`);
