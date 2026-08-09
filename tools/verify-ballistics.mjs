#!/usr/bin/env node
/**
 * GATE — exterior ballistics against published data.
 *
 * The point of this gate is that the trajectory model is falsifiable. Anyone can
 * write a drag term and tune it until the game feels fine; the claim being made
 * in game/ballistics/cartridges.js is stronger than that — that the numbers come
 * from published ballistic data and are therefore checkable against it. So they
 * are checked, with tolerances tight enough to catch a real error and loose enough
 * to survive the honest ambiguity in which lot of ammunition a table describes.
 *
 * It also checks the two consistency properties that no amount of physics gets
 * you for free:
 *
 *   * data vs geometry — a weapon that declares a 415 mm barrel must not be
 *     modelled with a 200 mm one, or the gun the player sees is not the gun that
 *     shoots
 *   * monotonicity — longer barrel is never slower, further is never faster,
 *     more energy is never less damage. These are the invariants a future tuning
 *     pass is most likely to break by accident.
 *
 * Everything runs in plain node: no GPU, no DOM, no browser.
 */

import { readFileSync } from 'node:fs';
import {
  CARTRIDGES,
  CARTRIDGE_IDS,
  cartridgeFor,
  muzzleVelocity,
  solve,
  energy,
  zeroAngle,
  cdG7,
  formFactor,
  sectionalDensity,
  airDensity,
  speedOfSound,
  dragDecel,
  RHO_0,
  MACH_1,
} from '../game/ballistics/cartridges.js';
import { ARSENAL_DEFS } from '../game/arsenal/defs.js';
import { MODEL_SPECS, layoutOf } from '../game/arsenal/models/specs.js';

let passed = 0;
const failures = [];
let group = '';

function section(name) {
  group = name;
  console.log(`\n${name}`);
}
function check(name, fn) {
  try {
    fn();
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
/** Assert `actual` is within `tol` (fractional) of `expected`. */
function near(actual, expected, tol, what) {
  const off = Math.abs(actual - expected) / Math.abs(expected);
  assert(
    off <= tol,
    `${what}: got ${actual.toFixed(2)}, expected ~${expected} (off by ${(off * 100).toFixed(1)}%, tolerance ${(tol * 100).toFixed(0)}%)`,
  );
}

/* ------------------------------------------------------- the drag function */

section('the G7 drag function');

check('the transonic rise is present and the right size', () => {
  // This is the whole reason the old linear-drag model was replaced. If this
  // check ever passes trivially, the curve has been flattened and rifle drop at
  // 400 m is wrong again.
  const sub = cdG7(0.95);
  const sup = cdG7(1.15);
  assert(sup > sub, 'Cd does not rise through Mach 1');
  const rise = sup / sub - 1;
  near(rise, 0.42, 0.15, 'transonic Cd rise');
});

check('the curve is flat well below Mach 1', () => {
  // Pistol rounds live here; a wobble would make them behave unpredictably.
  const a = cdG7(0.2);
  const b = cdG7(0.5);
  assert(Math.abs(a - b) / a < 0.02, `Cd moved ${(Math.abs(a - b) / a * 100).toFixed(1)}% between Mach 0.2 and 0.5`);
});

check('Cd falls again once supersonic', () => {
  assert(cdG7(3.0) < cdG7(1.3), 'Cd does not fall in the supersonic regime');
});

check('the table is clamped, not extrapolated off the end', () => {
  assert(cdG7(-1) === cdG7(0), 'negative Mach is not clamped');
  assert(cdG7(99) === cdG7(5), 'hypersonic Mach is not clamped');
  assert(Number.isFinite(cdG7(0.9999)), 'Cd is not finite at the knee');
});

check('sectional density and form factor follow their definitions', () => {
  // 62 gr, .224 in: the textbook worked example.
  near(sectionalDensity(62, 0.224), 0.1765, 0.01, 'SD of a 62 gr .224');
  near(formFactor(62, 0.224, 0.151), 1.169, 0.01, 'form factor of M855');
  // A blunt pistol bullet must come out markedly draggier than the standard
  // boat-tail shape. If this ever lands near 1.0 the BC data has been mixed up
  // between the G1 and G7 systems, which is the single easiest mistake here.
  assert(
    formFactor(124, 0.355, 0.075) > 1.5,
    'a 9 mm FMJ came out no draggier than the G7 standard projectile: G1 BC used as G7?',
  );
});

/* ---------------------------------------------------------- the atmosphere */

section('atmosphere');

check('the reference conditions are the ones the tables use', () => {
  near(airDensity({ altitude: 0, celsius: 15 }), RHO_0, 0.01, 'sea-level density');
  near(speedOfSound(15), MACH_1, 0.01, 'speed of sound at 15 C');
});

check('thin air means less drag', () => {
  const cart = cartridgeFor('5.56x45');
  const low = dragDecel(cart, 800, airDensity({ altitude: 0 }));
  const high = dragDecel(cart, 800, airDensity({ altitude: 2000 }));
  assert(high < low, 'drag did not fall with altitude');
  near(high / low, 0.82, 0.08, 'drag ratio at 2000 m');
});

check('hot air is thinner', () => {
  assert(
    airDensity({ celsius: 35 }) < airDensity({ celsius: -10 }),
    'a hot afternoon is denser than a cold morning',
  );
});

/* ----------------------------------------------------- published ballistics */

section('trajectories against published data');

/**
 * Each row is one published figure. Tolerances are per-row because the data is
 * not equally firm: velocity is chronographed and tight, drop depends on the
 * exact zero and sight height and is looser.
 */
const PUBLISHED = [
  // 5.56 M855 out of a 14.5" carbine, zeroed at 100 m.
  { cart: '5.56x45', barrel: 368, zero: 100, at: 300, v: 721, vTol: 0.06, drop: -0.25, dropTol: 0.35 },
  { cart: '5.56x45', barrel: 368, zero: 100, at: 400, v: 671, vTol: 0.06, drop: -0.70, dropTol: 0.30 },
  // The 20" rifle is genuinely faster with the same round: the barrel matters.
  { cart: '5.56x45', barrel: 508, zero: 100, at: 300, v: 758, vTol: 0.06 },
  // 7.62x39 from an AKM.
  { cart: '7.62x39', barrel: 415, zero: 100, at: 300, v: 570, vTol: 0.07, drop: -0.48, dropTol: 0.30 },
  // 7.62x54R from an SVD: the long shot the roster's DMR exists for.
  { cart: '7.62x54R', barrel: 620, zero: 100, at: 800, v: 555, vTol: 0.08, drop: -4.8, dropTol: 0.30 },
  // 9 mm from a Glock-length barrel.
  { cart: '9x19', barrel: 114, zero: 25, at: 50, v: 338, vTol: 0.06 },
  // .50 AE: heavy, slow, and it hits like a shovel.
  { cart: '.50AE', barrel: 152, zero: 50, at: 100, v: 393, vTol: 0.07 },
];

for (const row of PUBLISHED) {
  const cart = cartridgeFor(row.cart);
  const v0 = muzzleVelocity(cart, row.barrel);
  const angle = zeroAngle(cart, { v0, distance: row.zero });
  const s = solve(cart, { v0, distance: row.at, angle });
  const label = `${row.cart} · ${row.barrel} mm · ${row.at} m`;

  if (row.v !== undefined) {
    check(`${label}: retained velocity`, () => near(s.speed, row.v, row.vTol, 'velocity'));
  }
  if (row.drop !== undefined) {
    check(`${label}: drop from a ${row.zero} m zero`, () =>
      near(s.drop, row.drop, row.dropTol, 'drop'));
  }
}

check('muzzle energies match the published figures', () => {
  const cases = [
    ['5.56x45', 368, 1550, 0.10],
    ['7.62x39', 415, 2010, 0.10],
    ['7.62x51', 508, 3300, 0.12],
    ['7.62x54R', 620, 3370, 0.10],
    ['9x19', 114, 520, 0.12],
    ['.50AE', 152, 2050, 0.10],
  ];
  for (const [id, barrel, joules, tol] of cases) {
    const c = cartridgeFor(id);
    near(energy(c, muzzleVelocity(c, barrel)), joules, tol, `${id} muzzle energy`);
  }
});

/* ------------------------------------------------------------- invariants */

section('invariants a tuning pass must not break');

check('a longer barrel is never slower', () => {
  for (const id of CARTRIDGE_IDS) {
    const c = CARTRIDGES[id];
    let prev = -Infinity;
    for (let mm = 100; mm <= 800; mm += 25) {
      const v = muzzleVelocity(c, mm);
      assert(v >= prev - 1e-6, `${id}: ${mm} mm is slower than ${mm - 25} mm`);
      assert(v > 0 && Number.isFinite(v), `${id}: ${mm} mm gave ${v}`);
      prev = v;
    }
  }
});

check('a round never speeds up downrange', () => {
  for (const id of CARTRIDGE_IDS) {
    const c = CARTRIDGES[id];
    const v0 = muzzleVelocity(c, c.barrels[0][0]);
    let prev = v0 + 1;
    for (const d of [10, 25, 50, 100, 200, 300]) {
      const { speed } = solve(c, { v0, distance: d, dt: 1 / 1200 });
      assert(speed <= prev, `${id}: faster at ${d} m than before it`);
      prev = speed;
    }
  }
});

check('drop grows with distance, at an increasing rate', () => {
  const c = cartridgeFor('5.56x45');
  const v0 = muzzleVelocity(c, 368);
  const d1 = solve(c, { v0, distance: 200 }).drop;
  const d2 = solve(c, { v0, distance: 400 }).drop;
  const d3 = solve(c, { v0, distance: 600 }).drop;
  assert(d1 > d2 && d2 > d3, 'drop is not monotonic');
  // Gravity acts for longer AND the round is slower, so the second 200 m must
  // cost more than the first.
  assert(d1 - d2 < d2 - d3, 'drop is linear in distance, which is wrong');
});

check('a heavier, sleeker bullet holds velocity better', () => {
  // 7.62x51 versus 5.56x45 at 500 m: the battle rifle should retain a larger
  // FRACTION of its muzzle velocity, which is the entire argument for the round.
  const a = cartridgeFor('7.62x51');
  const b = cartridgeFor('5.56x45');
  const va0 = muzzleVelocity(a, 508);
  const vb0 = muzzleVelocity(b, 508);
  const ra = solve(a, { v0: va0, distance: 500 }).speed / va0;
  const rb = solve(b, { v0: vb0, distance: 500 }).speed / vb0;
  assert(ra > rb, `7.62 retained ${(ra * 100).toFixed(0)}% vs 5.56 ${(rb * 100).toFixed(0)}%`);
});

check('a subsonic load stays subsonic', () => {
  // The whole reason the load exists: with a suppressor there is no ballistic
  // crack. If it goes supersonic out of any barrel it is silently useless.
  const c = cartridgeFor('9x19sub');
  for (const [mm] of c.barrels) {
    const v = muzzleVelocity(c, mm);
    assert(v < MACH_1, `${mm} mm barrel launches the subsonic load at ${v.toFixed(0)} m/s`);
  }
  assert(c.subsonic === true, 'the load is not flagged subsonic');
});

check('buckshot is nine pellets, not one lump', () => {
  const c = cartridgeFor('12g-buck');
  assert(c.pellets === 9, `pellets is ${c.pellets}`);
  // One pellet must be individually weak: the lethality is in the pattern, and
  // that is what makes distance and cover matter.
  const v0 = muzzleVelocity(c, 470);
  assert(energy(c, v0) < 350, `a single pellet carries ${energy(c, v0).toFixed(0)} J`);
});

check('a hollow point deposits more of its energy than an FMJ', () => {
  assert(
    cartridgeFor('.50AE').transfer > cartridgeFor('5.56x45').transfer,
    'the terminal model does not distinguish bullet construction',
  );
  for (const id of CARTRIDGE_IDS) {
    const t = CARTRIDGES[id].transfer;
    assert(t > 0 && t <= 1, `${id}: transfer ${t} is not a fraction`);
  }
});

check('zeroing points the barrel up, and further zeros point it further up', () => {
  const c = cartridgeFor('7.62x54R');
  const v0 = muzzleVelocity(c, 620);
  const a100 = zeroAngle(c, { v0, distance: 100 });
  const a300 = zeroAngle(c, { v0, distance: 300 });
  assert(a100 > 0, 'a zeroed rifle points at or below the sight line');
  assert(a300 > a100, 'a 300 m zero is not higher than a 100 m zero');
  // And the round must actually cross the sight line at the zero distance.
  const at300 = solve(c, { v0, distance: 300, angle: a300 });
  assert(Math.abs(at300.drop - 0.075) < 0.03, `at its 300 m zero the round is ${(at300.drop * 100).toFixed(1)} cm off the line`);
});

/* ---------------------------------------------- data against the geometry */

section('the gun that shoots is the gun that is drawn');

check('every weapon names a cartridge that exists', () => {
  for (const [id, def] of Object.entries(ARSENAL_DEFS)) {
    if (!def.cartridge) continue;
    assert(CARTRIDGES[def.cartridge], `${id} is chambered for unknown "${def.cartridge}"`);
    assert(typeof def.barrelMm === 'number', `${id} names a cartridge but no barrel length`);
    // The caliber string the UI shows must not contradict the cartridge.
    const bore = def.cartridge.replace(/[^0-9.x]/g, '');
    const shown = (def.caliber ?? '').replace(/[^0-9.x]/g, '');
    assert(
      bore.startsWith(shown.slice(0, 4)) || shown.startsWith(bore.slice(0, 4)),
      `${id} shows "${def.caliber}" but is chambered for "${def.cartridge}"`,
    );
  }
});

check('declared barrel length matches the modelled barrel', () => {
  // The viewmodel compresses reality a little so the weapon frames well at
  // 300 mm from the eye, so this is a sanity band and not an equality. What it
  // catches is a real class of bug: data that says carbine and a model that
  // draws a pistol, which would make velocity and silhouette disagree.
  const worst = [];
  for (const [id, def] of Object.entries(ARSENAL_DEFS)) {
    if (!def.barrelMm || !MODEL_SPECS[id]) continue;
    const modelled = layoutOf(MODEL_SPECS[id]).barrelLen * 1000;
    const ratio = modelled / def.barrelMm;
    worst.push(`${id} ${modelled.toFixed(0)}/${def.barrelMm} = ${ratio.toFixed(2)}`);
    assert(
      ratio > 0.6 && ratio < 1.3,
      `${id}: model barrel ${modelled.toFixed(0)} mm vs declared ${def.barrelMm} mm (ratio ${ratio.toFixed(2)})`,
    );
  }
  assert(worst.length >= 8, `only ${worst.length} weapons had both a model and a barrel length`);
});

check('the two 9 mm weapons are genuinely different guns', () => {
  // Same cartridge, different barrels. If this ever comes out equal, the barrel
  // has stopped feeding into velocity and the gunsmith is cosmetic again.
  const cart = cartridgeFor('9x19');
  const mp5 = muzzleVelocity(cart, ARSENAL_DEFS.mp5.barrelMm);
  const glock = muzzleVelocity(cart, ARSENAL_DEFS.glock18.barrelMm);
  assert(mp5 > glock + 20, `MP5 ${mp5.toFixed(0)} m/s vs Glock ${glock.toFixed(0)} m/s`);
});

check('the roster spans the range it claims to', () => {
  const energies = Object.values(ARSENAL_DEFS)
    .filter((d) => d.cartridge)
    .map((d) => {
      const c = cartridgeFor(d.cartridge);
      return energy(c, muzzleVelocity(c, d.barrelMm)) * (c.pellets ?? 1);
    });
  const min = Math.min(...energies);
  const max = Math.max(...energies);
  // A pistol to a DMR is roughly a factor of six in muzzle energy. Anything less
  // and the roster has collapsed into one gun with nine skins.
  assert(max / min > 4, `muzzle energy spans only ${(max / min).toFixed(1)}x`);
});

/* ---------------------------------------------------- the live simulation */

section('the live projectile simulation uses this model');

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/**
 * Source with comments removed.
 *
 * Necessary, and the reason is worth stating: these files document the model they
 * replaced. `game/weapons/ballistics.js` explains at length that drag "used to be
 * v *= 1 - dragK*dt", and a check searching the raw text for that expression finds
 * the explanation and reports the bug it was written to describe. Comments are
 * prose; assertions belong on code.
 */
const codeOnly = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');

const SIM = codeOnly(src('game/weapons/ballistics.js'));
const WEAPONS = codeOnly(src('game/weapons/index.js'));
const ARS = codeOnly(src('game/arsenal/index.js'));

check('drag comes from the cartridge model, not a linear term', () => {
  assert(/dragDecel/.test(SIM), 'the sim does not call dragDecel');
  assert(
    !/v\s*\*=\s*1\s*-\s*.*dragK/.test(SIM),
    'the old linear drag decay is still the primary path',
  );
});

check('drag is computed against air-relative velocity, so wind bends the shot', () => {
  assert(/sub\(this\.wind\)/.test(SIM), 'wind is not subtracted from velocity');
});

check('damage falls out of energy rather than a distance curve', () => {
  assert(/kineticEnergy/.test(SIM), 'the sim never computes energy');
  assert(/dropoff: 1/.test(SIM), 'the penetration solver would apply falloff a second time');
});

check('ricochets exist and are bounded', () => {
  assert(/MAX_RICOCHETS/.test(SIM), 'no ricochet cap: a round could skip forever');
  assert(/RICOCHET_ANGLE/.test(SIM), 'no per-material critical angle');
  assert(/bullet:ricochet/.test(SIM), 'a ricochet is silent and invisible');
});

check('the fire path spawns one projectile per pellet', () => {
  assert(/pellets/.test(WEAPONS), 'buckshot is still a single round');
  assert(/damage: def\.damage \/ pellets/.test(WEAPONS), 'nine pellets would each do full damage');
  assert(/_ballisticsFor/.test(WEAPONS), 'muzzle velocity is not resolved from the cartridge');
});

check('a barrel swap invalidates the memoised muzzle velocity', () => {
  assert(
    /resetBallisticsCache/.test(ARS),
    'changing a build would keep the previous barrel’s velocity',
  );
});

/* ------------------------------------------------------------------ report */

console.log(`\n${'-'.repeat(60)}`);
if (failures.length) {
  console.log(`FAILED - ${failures.length} of ${passed + failures.length} checks`);
  for (const f of failures) console.log(`  . ${f}`);
  process.exit(1);
}
console.log(`all green - ${passed} ballistics checks passed`);
