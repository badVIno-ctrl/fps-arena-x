#!/usr/bin/env node
/**
 * GATE — what the player is allowed to carry.
 *
 * `arsenal/rules.js` is pure data and pure functions with no three.js, no ctx and
 * no DOM, precisely so that the whole rule set can be exercised here in about a
 * second instead of by booting a browser and clicking a board.
 *
 * What this gate is protecting, in order of how badly it hurt:
 *
 *   1. THE ORIGINAL DEFECT. `WeaponSystem.weaponIds` returned every registered
 *      state, so Tab cycled all nine weapons and the player carried the whole
 *      arsenal. The check "two full-size rifles is refused" is the regression
 *      test for that, and it must fail for the RIGHT REASON — a position clash,
 *      not a mass overrun — because a mass overrun would be fixable by dropping
 *      magazines, and "M416 and a Kalashnikov" must stay impossible however
 *      light they are.
 *
 *   2. THE DUPLICATED TABLE. `PACK.magKg` is a local copy of `LOAD.magKg` in
 *      player/load.js, because the engine-contract gate forbids arsenal/ from
 *      importing player/. Duplication that no gate watches is duplication that
 *      rots, so this file compares them number for number.
 *
 *   3. THE BUDGET BEING REACHABLE AT ALL. A ceiling nobody can hit is not a rule,
 *      it is a comment. There has to exist a legal set of positions that still
 *      goes over mass, and the default kit has to be comfortably under.
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GAME = join(ROOT, 'game');
const load = (rel) => import(pathToFileURL(join(GAME, rel)).href);

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
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function near(a, b, eps, what) {
  assert(Math.abs(a - b) <= eps, `${what}: ${a} != ${b}`);
}

const R = await load('arsenal/rules.js');
const { ARSENAL_DEFS, ARSENAL_ORDER } = await load('arsenal/defs.js');
const { LOAD } = await load('player/load.js');
const { ATTACHMENTS } = await load('arsenal/attachments.js');

/* ------------------------------------------------------------------ tables */

section('tables: the duplicated magazine masses still agree');

check('PACK.magKg matches LOAD.magKg class for class', () => {
  const a = R.PACK.magKg;
  const b = LOAD.magKg;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    assert(a[k] !== undefined, `PACK.magKg is missing "${k}"`);
    assert(b[k] !== undefined, `LOAD.magKg is missing "${k}"`);
    near(a[k], b[k], 1e-9, `magazine mass for ${k}`);
  }
  return `${keys.size} classes`;
});

check('every weapon class has a magazine mass and a volume', () => {
  for (const id of ARSENAL_ORDER) {
    const cls = ARSENAL_DEFS[id].class;
    assert(R.PACK.magKg[cls] !== undefined, `no magazine mass for class ${cls} (${id})`);
    assert(R.PACK.magLitres[cls] !== undefined, `no magazine volume for class ${cls} (${id})`);
    assert(R.DEFAULT_MAGS[cls] !== undefined, `no default magazine count for class ${cls}`);
  }
  return `${ARSENAL_ORDER.length} weapons`;
});

/* --------------------------------------------------------------- positions */

section('positions: where each weapon rides');

check('every weapon has exactly one carry position', () => {
  for (const id of ARSENAL_ORDER) {
    const pos = R.carryPositionFor(ARSENAL_DEFS[id]);
    assert(['sling', 'holster', 'pack'].includes(pos), `${id} rides "${pos}"`);
  }
});

check('handguns holster, SMGs stow, everything else slings', () => {
  assert(R.carryPositionFor(ARSENAL_DEFS.glock18) === 'holster', 'Glock should holster');
  assert(R.carryPositionFor(ARSENAL_DEFS.deagle) === 'holster', 'Deagle should holster');
  assert(R.carryPositionFor(ARSENAL_DEFS.mp5) === 'pack', 'MP5 should stow');
  for (const id of ['akm', 'ak74', 'm416', 'scar', 'svd', 'm870']) {
    assert(R.carryPositionFor(ARSENAL_DEFS[id]) === 'sling', `${id} should sling`);
  }
});

/* ------------------------------------------------------- the original bug */

section('THE ORIGINAL DEFECT: you cannot carry the whole arsenal');

check('the entire roster at once is refused', () => {
  const v = R.validateKit({ weapons: [...ARSENAL_ORDER] });
  assert(!v.ok, `nine weapons were accepted at ${v.kg.toFixed(1)} kg`);
  return v.code;
});

check('an M416 AND a Kalashnikov is refused — and for a position, not a diet', () => {
  const v = R.validateKit({ weapons: ['m416', 'akm'] });
  assert(!v.ok, 'two full-size rifles were accepted');
  assert(
    v.code === 'position:sling',
    `refused for "${v.code}" — a mass refusal could be fixed by dropping magazines, ` +
      'and two rifles must stay impossible however light they are',
  );
  assert(/ремень один/.test(v.reason), `the reason does not explain the sling: "${v.reason}"`);
});

check('no number of dropped magazines makes two rifles legal', () => {
  const v = R.validateKit({ weapons: ['m416', 'akm'], mags: { m416: 0, akm: 0 }, lethal: 0, tactical: 0, medical: false });
  assert(!v.ok, 'two rifles with zero magazines were accepted');
  assert(v.code === 'position:sling', `refused for "${v.code}"`);
});

check('two handguns is refused: one holster', () => {
  const v = R.validateKit({ weapons: ['glock18', 'deagle'] });
  assert(!v.ok, 'two handguns were accepted');
  assert(v.code === 'position:holster', `refused for "${v.code}"`);
});

check('a rifle plus an SMG plus a handgun is legal — one per position', () => {
  const v = R.validateKit({ weapons: ['akm', 'mp5', 'glock18'], lethal: 2, tactical: 1 });
  assert(v.ok, `refused: ${v.reason}`);
  return `${v.kg.toFixed(1)} kg / ${v.litres.toFixed(1)} l`;
});

/* ------------------------------------------------------------- the budget */

section('the budget: reachable, but not by accident');

check('the default kit is legal and has real headroom', () => {
  const v = R.validateKit(R.defaultKit());
  assert(v.ok, `the default kit is illegal: ${v.reason}`);
  assert(v.kg < R.PACK.kg * 0.85, `default kit is ${v.kg.toFixed(1)} kg of ${R.PACK.kg}: no room to choose`);
  assert(v.kg > R.PACK.kg * 0.35, `default kit is only ${v.kg.toFixed(1)} kg: the budget would never bind`);
  return `${v.kg.toFixed(1)} of ${R.PACK.kg} kg`;
});

check('mass can be blown with every position legal', () => {
  // The heaviest legal set of positions, loaded with magazines.
  const kit = {
    weapons: ['svd', 'mp5', 'deagle'],
    mags: { svd: 14, mp5: 12, deagle: 8 },
    lethal: 6,
    tactical: 4,
    medical: true,
  };
  const v = R.validateKit(kit);
  assert(!v.ok, `${v.kg.toFixed(1)} kg passed a ${R.PACK.kg} kg budget`);
  assert(v.code === 'mass' || v.code === 'volume', `refused for "${v.code}"`);
  return `${v.kg.toFixed(1)} kg / ${v.litres.toFixed(1)} l → ${v.code}`;
});

check('volume binds independently of mass', () => {
  /**
   * Ammunition is always MASS-bound: a loaded rifle magazine is 0.52 kg in 0.55 l,
   * far denser than the pack's own 22 kg per 24 l. So if volume never binds first
   * for anything, it is decoration and not a rule.
   *
   * What it binds on is bulky light kit — the stowed SMG at 9.5 l plus a full
   * grenade load — and that is the trade the constraint exists to force: a second
   * gun OR the grenades, not both.
   */
  const bulky = R.validateKit({
    weapons: ['akm', 'mp5', 'glock18'],
    lethal: 8,
    tactical: 8,
    medical: true,
  });
  assert(!bulky.ok, 'a stowed SMG plus a full grenade load fitted');
  assert(
    bulky.code === 'volume',
    `refused for "${bulky.code}" at ${bulky.kg.toFixed(1)} kg / ${bulky.litres.toFixed(1)} l, ` +
      'expected volume — it is under the mass ceiling',
  );
  assert(bulky.kg < R.PACK.kg, `it was over mass too (${bulky.kg.toFixed(1)} kg): proves nothing`);
  // And dropping the stowed weapon rather than the grenades is a real answer.
  const dropped = R.validateKit({ weapons: ['akm', 'glock18'], lethal: 8, tactical: 8, medical: true });
  assert(dropped.ok, `leaving the SMG behind still failed: ${dropped.reason}`);
  return `${bulky.litres.toFixed(1)} l → volume; without the SMG ${dropped.litres.toFixed(1)} l → ok`;
});

check('attachment mass reaches the pack', () => {
  const bare = R.weaponCost('m416', { loadout: {} });
  const loaded = R.weaponCost('m416', {
    loadout: { optic: 'pso4x', muzzle: 'suppressor', tactical: 'flashlight', underbarrel: 'grip' },
  });
  assert(loaded.kg > bare.kg, 'a fully kitted rifle weighs the same as a bare one');
  const expected = Object.values({
    optic: 'pso4x', muzzle: 'suppressor', tactical: 'flashlight', underbarrel: 'grip',
  }).reduce((a, id) => a + (ATTACHMENTS[id]?.mass ?? 0), 0);
  near(loaded.kg - bare.kg, expected, 1e-9, 'attachment mass');
  return `+${(loaded.kg - bare.kg).toFixed(2)} kg`;
});

/* --------------------------------------------------------------- the board */

section('the board: a refusal has to be actionable');

check('adding a second rifle offers a swap rather than a wall', () => {
  const kit = R.defaultKit();
  const r = R.canAdd(kit, 'm416');
  assert(r.ok, `adding an M416 was refused outright: ${r.reason}`);
  assert(r.displaces === 'akm', `expected it to displace the АКМ, got ${r.displaces}`);
  assert(!r.resulting.includes('akm'), 'the displaced rifle is still in the kit');
  assert(r.resulting.includes('m416'), 'the new rifle is not in the kit');
});

check('withWeapon does not mutate the kit it was given', () => {
  const kit = R.defaultKit();
  const before = JSON.stringify(kit);
  R.withWeapon(kit, 'svd');
  assert(JSON.stringify(kit) === before, 'withWeapon mutated its argument');
});

check('you cannot put your last weapon back on the rack', () => {
  const one = { weapons: ['akm'] };
  const r = R.withoutWeapon(one, 'akm');
  assert(!r.ok, 'the player was allowed into the field unarmed');
  assert(r.code === 'empty', `refused for "${r.code}"`);
});

check('availability explains every weapon the player cannot add', () => {
  const kit = R.defaultKit();
  const list = R.availability(kit);
  assert(list.length === ARSENAL_ORDER.length, `${list.length} entries for ${ARSENAL_ORDER.length} weapons`);
  for (const a of list) {
    assert(a.ok || a.reason, `${a.id} is unavailable with no reason given`);
    assert(a.position, `${a.id} has no carry position`);
  }
  const carried = list.filter((a) => a.carried).map((a) => a.id);
  assert(carried.length === kit.weapons.length, `${carried.length} marked carried, kit has ${kit.weapons.length}`);
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
console.log(`all green — ${passed} loadout checks passed`);
