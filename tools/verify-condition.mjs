#!/usr/bin/env node
/**
 * GATE — weapon condition: heat, wear and stoppages.
 *
 * `weapons/condition.js` is pure, so the whole curve is checkable here rather
 * than by holding a trigger in a browser and squinting at a bar.
 *
 * The checks are chosen around the failure modes this code actually has, which
 * are all SIGN and SCALE errors — the kind that stay invisible for a week and
 * then surface as "the gun gets better as it heats up":
 *
 *   * every consequence must move in the direction that HURTS
 *   * heat must be recoverable and wear must not be
 *   * a magazine of continuous fire must produce a felt amount of heat, and a
 *     single shot must produce almost none
 *   * burst-tapping must not dodge the thermal budget
 *   * a fresh weapon must never jam, and a worn one must
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(join(ROOT, 'game', rel)).href);

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

const { WeaponCondition, HEAT, WEAR } = await load('weapons/condition.js');
const { ARSENAL_DEFS } = await load('arsenal/defs.js');

/** Fire n rounds at `rpm`, ticking the clock between them. */
function burst(c, n, rpm, rand = () => 1) {
  const dt = 60 / rpm;
  let jams = 0;
  for (let i = 0; i < n; i++) {
    if (c.shoot(rand)) jams++;
    c.update(dt);
  }
  return jams;
}

section('direction: every consequence has to hurt');

check('heat widens the cone, slows the cadence and worsens the sway', () => {
  const c = new WeaponCondition({ mass: 3.5 });
  const cold = c.modifiers;
  c.heat = 1;
  const hot = c.modifiers;
  assert(hot.spread > cold.spread, `spread ${cold.spread} -> ${hot.spread}`);
  assert(hot.cadence > cold.cadence, `cadence multiplier ${cold.cadence} -> ${hot.cadence}`);
  assert(hot.cadence > 1, 'a hot weapon must fire SLOWER, so the interval multiplier is > 1');
  assert(hot.sway > cold.sway, `sway ${cold.sway} -> ${hot.sway}`);
  return `spread x${hot.spread.toFixed(2)}, cadence x${hot.cadence.toFixed(3)}`;
});

check('heat does not touch damage: that is a fiction, and it feels broken', () => {
  const c = new WeaponCondition();
  c.heat = 1;
  const m = c.modifiers;
  assert(!('damage' in m), 'condition should not modify damage');
});

check('wear widens the cone and slows the reload', () => {
  const c = new WeaponCondition();
  const fresh = c.modifiers;
  c.wear = 1;
  const worn = c.modifiers;
  assert(worn.spread > fresh.spread, `spread ${fresh.spread} -> ${worn.spread}`);
  assert(worn.reload > fresh.reload, `reload ${fresh.reload} -> ${worn.reload}`);
  return `spread x${worn.spread.toFixed(2)}, reload x${worn.reload.toFixed(2)}`;
});

check('below the onset, condition is invisible', () => {
  const c = new WeaponCondition();
  c.heat = HEAT.onset * 0.99;
  c.wear = WEAR.onset * 0.99;
  const m = c.modifiers;
  assert(Math.abs(m.spread - 1) < 1e-9, `spread is already ${m.spread} below the onset`);
  assert(Math.abs(m.cadence - 1) < 1e-9, `cadence is already ${m.cadence} below the onset`);
});

section('scale: a magazine has to be felt, one shot must not be');

check('one round barely warms the weapon', () => {
  const c = new WeaponCondition({ mass: 3.5 });
  c.shoot(() => 1);
  assert(c.heat < 0.03, `one round produced ${c.heat.toFixed(3)} heat`);
  assert(c.modifiers.spread === 1, 'one round already widened the cone');
  return c.heat.toFixed(4);
});

check('a full magazine held down is a real thermal event, but not a stoppage', () => {
  const c = new WeaponCondition({ mass: 3.5 });
  burst(c, 30, 600);
  assert(c.heat > 0.14, `30 rounds produced only ${c.heat.toFixed(2)} heat`);
  assert(c.heat < 0.75, `30 rounds produced ${c.heat.toFixed(2)} heat: too punishing`);
  return `${c.heat.toFixed(2)} heat, spread x${c.modifiers.spread.toFixed(2)}`;
});

check('the scale tops out at roughly the real continuous-fire limit', () => {
  /**
   * The interesting number is not "does it reach 1", it is HOW MANY ROUNDS that
   * takes, because that is the figure with a real-world referent: a rifle barrel
   * takes on the order of 150-200 rounds of continuous fire to reach the point
   * where accuracy visibly degrades. Cooling runs during the burst, so the
   * equilibrium is what sets this, not the per-shot figure alone.
   */
  const four = new WeaponCondition({ mass: 3.5 });
  burst(four, 120, 600);
  assert(four.heat > 0.55, `120 rounds reached only ${four.heat.toFixed(2)}`);
  const six = new WeaponCondition({ mass: 3.5 });
  burst(six, 200, 600);
  assert(six.heat > 0.9, `200 rounds reached only ${six.heat.toFixed(2)}`);
  return `120 rd -> ${four.heat.toFixed(2)}, 200 rd -> ${six.heat.toFixed(2)}`;
});

check('a heavier weapon heats more slowly, but only somewhat', () => {
  const light = new WeaponCondition({ mass: 2.5 });
  const heavy = new WeaponCondition({ mass: 4.3 });
  burst(light, 30, 600);
  burst(heavy, 30, 600);
  assert(heavy.heat < light.heat, `heavy ${heavy.heat.toFixed(3)} >= light ${light.heat.toFixed(3)}`);
  const ratio = light.heat / heavy.heat;
  assert(ratio < 1.7, `mass matters too much: ${ratio.toFixed(2)}x between 2.5 and 4.3 kg`);
  return `${ratio.toFixed(2)}x between an MP5 and an СВД`;
});

section('recovery: heat goes, wear stays');

check('heat clears in a few seconds of trigger discipline', () => {
  const c = new WeaponCondition();
  c.heat = 1;
  c.since = HEAT.soakTime + 1; // past the soak window
  let t = 0;
  while (c.heat > 0 && t < 30) {
    c.update(0.1);
    t += 0.1;
  }
  assert(t < 8, `took ${t.toFixed(1)} s to cool: too long to be a moment-to-moment choice`);
  assert(t > 2, `cooled in ${t.toFixed(1)} s: heat would never bind`);
  return `${t.toFixed(1)} s from full`;
});

check('a short pause inside the soak window buys much less than a long one', () => {
  /**
   * The premise this check started with was wrong, and measuring it said so: it
   * asserted that five-round bursts with a second between them must still heat the
   * weapon. They must not. Five rounds in 0.5 s adds about as much heat as one
   * second of soaked cooling removes, which means burst discipline is sustainable
   * indefinitely — and that is not a leak, it IS the sustained-fire doctrine the
   * numbers were taken from.
   *
   * What the soak window is actually for is making a SHORT pause worth less than a
   * long one, so that stutter-firing is not a way to hold the trigger down for
   * free. So that is what gets asserted: same 60 rounds, same bursts, three
   * different pauses, and the heat has to fall monotonically as the pause grows.
   */
  const run = (pause) => {
    const c = new WeaponCondition({ mass: 3.5 });
    for (let i = 0; i < 12; i++) {
      burst(c, 5, 600);
      c.update(pause);
    }
    return c.heat;
  };
  const continuous = (() => {
    const c = new WeaponCondition({ mass: 3.5 });
    burst(c, 60, 600);
    return c.heat;
  })();
  const stutter = run(0.12);
  const paced = run(0.6);
  const patient = run(2.5);

  assert(stutter > paced, `a 0.12 s pause (${stutter.toFixed(3)}) shed more than a 0.6 s one (${paced.toFixed(3)})`);
  assert(paced >= patient, `a 0.6 s pause (${paced.toFixed(3)}) shed more than a 2.5 s one (${patient.toFixed(3)})`);
  assert(
    stutter > continuous * 0.6,
    `stutter-firing shed too much: ${stutter.toFixed(3)} vs ${continuous.toFixed(3)} continuous`,
  );
  assert(patient < continuous * 0.35, 'a long pause should genuinely cool the weapon');
  return `cont ${continuous.toFixed(2)} · 0.12s ${stutter.toFixed(2)} · 0.6s ${paced.toFixed(2)} · 2.5s ${patient.toFixed(2)}`;
});

check('wear never recovers on its own', () => {
  const c = new WeaponCondition();
  burst(c, 200, 600);
  const w = c.wear;
  for (let i = 0; i < 600; i++) c.update(0.1);
  assert(c.wear === w, `wear fell from ${w} to ${c.wear}`);
  assert(c.heat === 0, 'heat did not clear');
  return `${(w * 100).toFixed(1)}% after 200 rounds`;
});

check('abusing the barrel costs more wear than firing the same rounds cold', () => {
  const hot = new WeaponCondition();
  burst(hot, 90, 600);
  const cold = new WeaponCondition();
  for (let i = 0; i < 90; i++) {
    cold.shoot(() => 1);
    // A long pause between shots: fully cooled every time.
    for (let k = 0; k < 60; k++) cold.update(0.1);
  }
  assert(hot.wear > cold.wear * 1.3, `hot ${hot.wear.toFixed(4)} vs cold ${cold.wear.toFixed(4)}`);
  return `${(hot.wear / cold.wear).toFixed(2)}x`;
});

check('reset clears heat, and clears wear only when asked', () => {
  const c = new WeaponCondition();
  burst(c, 100, 600);
  c.reset({ wear: false });
  assert(c.heat === 0, 'heat survived a reset');
  assert(c.wear > 0, 'wear was cleared when it should not have been');
  c.reset();
  assert(c.wear === 0, 'wear survived a full reset');
});

section('stoppages: rare, earned, and clearable');

check('a fresh weapon cannot jam, however unlucky', () => {
  const c = new WeaponCondition();
  const jams = burst(c, 300, 600, () => 0); // rand() = 0: always the worst roll
  assert(c.wear < WEAR.jamOnset, `300 rounds already reached ${c.wear.toFixed(3)} wear`);
  assert(jams === 0, `${jams} stoppages on a weapon below the jam onset`);
});

check('a worn weapon jams, and clearing it takes real time', () => {
  const c = new WeaponCondition();
  c.wear = 1;
  const jammed = c.shoot(() => 0);
  assert(jammed, 'a fully worn weapon did not jam on the worst possible roll');
  assert(c.jammed, 'jam flag is not set');
  assert(c.jam > 1, `clearing takes only ${c.jam} s`);
  let t = 0;
  while (c.jammed && t < 10) {
    c.update(0.1);
    t += 0.1;
  }
  assert(!c.jammed, 'the stoppage never cleared');
  return `${WEAR.clearTime} s to clear`;
});

check('stoppages stay rare enough to be a story, not a tax', () => {
  // At half wear, over a whole magazine, with fair rolls.
  const trials = 4000;
  let jams = 0;
  for (let i = 0; i < trials; i++) {
    const c = new WeaponCondition();
    c.wear = 0.7;
    jams += burst(c, 30, 600, Math.random);
  }
  const perMag = jams / trials;
  assert(perMag < 0.35, `${perMag.toFixed(3)} stoppages per magazine at 70% wear: a tax`);
  assert(perMag > 0.005, `${perMag.toFixed(4)} per magazine: never seen, so never learnt`);
  return `${perMag.toFixed(3)} per magazine at 70% wear`;
});

section('every weapon in the roster is inside the band');

for (const [id, def] of Object.entries(ARSENAL_DEFS)) {
  check(`${id}: a magazine of continuous fire lands in the useful range`, () => {
    const c = new WeaponCondition({ mass: def.weight, rpm: def.rpm });
    burst(c, def.magSize, def.rpm);
    // A shotgun's six shells cannot and should not heat a barrel; a 30-round
    // automatic magazine should. The band is per-weapon rather than global.
    const hi = def.magSize >= 17 ? 0.8 : 0.5;
    assert(c.heat < hi, `${def.magSize} rounds gave ${c.heat.toFixed(2)} heat`);
    /**
     * A weapon that cannot fire fast enough to outrun its own cooling SHOULD read
     * zero: an СВД at 176 rpm and an M870 at 70 rpm physically do not heat a
     * barrel by emptying a magazine, and asserting otherwise would force a curve
     * that lies. The floor therefore applies only to weapons whose cadence can
     * actually beat the cooling rate.
     */
    if (def.rpm >= 400) assert(c.heat > 0, 'an automatic weapon produced no heat at all');
    return `${c.heat.toFixed(2)} after ${def.magSize} rounds`;
  });
}

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
console.log(`all green — ${passed} condition checks passed`);
