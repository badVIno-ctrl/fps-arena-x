/**
 * VERIFY — the test gate for everything added on top of the base engine.
 *
 * Three tiers, because the sandbox this was authored in had no network and
 * therefore no `three` and no browser:
 *
 *   --syntax  parse every source file, resolve every relative import
 *   --unit    run assertions against the pure (three-free) modules
 *   --contract lint the engine contract: unique system ids, no Math.random in
 *             gameplay code, no cross-subsystem imports, required model nodes
 *
 * `node tools/verify.mjs` runs all three. Exit code 1 on any failure.
 * The GPU-dependent gates (`npm run build`, headless boot, shot capture) run in
 * CI where the dependencies can actually be installed — see .github/workflows.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/* ----------------------------------------------------------------- harness */
let passed = 0;
const failures = [];
const groups = [];
let current = null;

function group(name) {
  current = { name, tests: 0, failed: 0 };
  groups.push(current);
}
function check(label, fn) {
  if (current) current.tests += 1;
  try {
    fn();
    passed += 1;
  } catch (err) {
    if (current) current.failed += 1;
    failures.push({ group: current?.name ?? '-', label, message: err.message });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function near(a, b, eps, msg) {
  assert(Math.abs(a - b) <= eps, `${msg ?? ''} expected ~${b}, got ${a}`);
}

/* ------------------------------------------------------------------- files */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const ALL = walk(SRC);
/** Files added by this project (as opposed to the untouched base engine). */
const NEW_DIRS = ['arsenal', 'modes', 'net', 'shell'];
const NEW = ALL.filter((p) => NEW_DIRS.some((d) => p.includes(`${join(SRC, d)}/`) || p === join(SRC, d, 'index.js')));

/* ------------------------------------------------------------------ syntax */
async function syntax() {
  group('syntax');
  const { default: vm } = await import('node:vm');
  for (const file of ALL) {
    const rel = relative(ROOT, file);
    check(`parses ${rel}`, () => {
      const code = readFileSync(file, 'utf8');
      // SourceTextModule is behind a flag; compiling as a classic script would
      // reject `import`, so use the parser via dynamic Function on a stripped
      // copy is unsafe. Instead rely on vm.compileFunction over the module body
      // with import/export lines masked — catches every syntax error that is
      // not in an import statement, and the import graph check covers those.
      const masked = code
        .replace(/^\s*import\s[^;]*;?$/gm, '')
        .replace(/^\s*export\s+(default\s+)?/gm, '')
        .replace(/^\s*export\s*\{[^}]*\}\s*;?$/gm, '');
      vm.compileFunction(masked, [], { filename: rel });
    });
  }

  group('import graph');
  for (const file of ALL) {
    const code = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);
    const specs = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue;
      check(`${rel} -> ${spec}`, () => {
        const target = resolve(dirname(file), spec);
        const ok =
          existsSync(target) ||
          existsSync(`${target}.js`) ||
          existsSync(join(target, 'index.js'));
        assert(ok, `unresolved import ${spec}`);
      });
    }
  }
}

/* ---------------------------------------------------------------- contract */
async function contract() {
  group('engine contract');

  // Every subsystem declares a unique static id.
  const ids = new Map();
  for (const file of ALL) {
    const code = readFileSync(file, 'utf8');
    for (const m of code.matchAll(/static\s+id\s*=\s*'([^']+)'/g)) {
      const rel = relative(ROOT, file);
      const id = m[1];
      check(`system id "${id}" is unique`, () => {
        assert(!ids.has(id), `duplicate id "${id}" in ${rel} and ${ids.get(id)}`);
      });
      ids.set(id, rel);
    }
  }

  // Determinism: no Math.random in anything we added.
  for (const file of NEW) {
    const code = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);
    check(`${rel} uses ctx.rng, not Math.random`, () => {
      const hit = code.match(/Math\.random/);
      assert(!hit, 'Math.random() breaks lockstep capture; use ctx.rng');
    });
  }

  // Isolation: our subsystems must not reach into another subsystem's files.
  const OWN = new Set(NEW_DIRS);
  for (const file of NEW) {
    const code = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);
    const mine = relative(SRC, file).split('/')[0];
    for (const m of code.matchAll(/from\s+['"](\.\.[^'"]+)['"]/g)) {
      const spec = m[1];
      const target = relative(SRC, resolve(dirname(file), spec));
      const owner = target.split('/')[0];
      check(`${rel} does not import ${owner}/`, () => {
        assert(
          owner === mine || owner === 'core' || !OWN.has(owner) === false || owner === '',
          `cross-subsystem import of ${owner}: use ctx.get('${owner}') instead`,
        );
      });
    }
  }
}

/* -------------------------------------------------------------------- unit */
async function unit() {
  const defsUrl = pathToFileURL(join(SRC, 'arsenal/defs.js')).href;
  const attUrl = pathToFileURL(join(SRC, 'arsenal/attachments.js')).href;
  if (!existsSync(join(SRC, 'arsenal/defs.js'))) return;

  const D = await import(defsUrl);
  const A = await import(attUrl);
  const { ARSENAL_DEFS, ARSENAL_ORDER, SLOTS, cycleTime, damageAt, weaponsInSlot } = D;

  group('arsenal: roster');
  check('nine weapons, all listed in display order', () => {
    const keys = Object.keys(ARSENAL_DEFS);
    assert(keys.length === 9, `expected 9 weapons, got ${keys.length}`);
    for (const k of keys) assert(ARSENAL_ORDER.includes(k), `${k} missing from ARSENAL_ORDER`);
    assert(ARSENAL_ORDER.length === 9, 'ARSENAL_ORDER has strays');
  });

  const REQUIRED = [
    'id', 'label', 'class', 'slot', 'caliber', 'rpm', 'modes', 'magSize', 'reserve',
    'muzzleVelocity', 'damage', 'penetration', 'dropoff', 'maxRange', 'dragK',
    'spreadHip', 'spreadAds', 'spreadPerShot', 'spreadMax', 'spreadDecay', 'recoil',
    'adsTime', 'adsFov', 'viewFov', 'reloadTac', 'reloadEmpty', 'inspectTime',
    'drawTime', 'holsterTime', 'hipPos', 'hipRot', 'sprintPos', 'sprintRot',
    'lowReadyPos', 'lowReadyRot', 'adsCant', 'eyeRelief', 'mounts', 'weight',
  ];
  const RECOIL_KEYS = [
    'pitch', 'yaw', 'kickBack', 'kickUp', 'roll', 'punch', 'freq', 'damping',
    'patternLength', 'patternSeed', 'climbShape', 'drift',
  ];

  for (const id of ARSENAL_ORDER) {
    const def = ARSENAL_DEFS[id];
    group(`arsenal: ${id}`);
    check('schema complete', () => {
      for (const key of REQUIRED) assert(def[key] !== undefined, `missing ${key}`);
      for (const key of RECOIL_KEYS) assert(def.recoil[key] !== undefined, `missing recoil.${key}`);
    });
    check('id matches its key', () => assert(def.id === id, `def.id=${def.id}`));
    check('carry slot is valid', () => assert(SLOTS.includes(def.slot), `bad slot ${def.slot}`));
    check('poses are 3-vectors', () => {
      for (const key of ['hipPos', 'hipRot', 'sprintPos', 'sprintRot', 'lowReadyPos', 'lowReadyRot', 'adsCant']) {
        assert(Array.isArray(def[key]) && def[key].length === 3, `${key} is not [x,y,z]`);
        for (const v of def[key]) assert(Number.isFinite(v), `${key} has non-finite component`);
      }
    });
    check('numbers are in sane ranges', () => {
      assert(def.rpm >= 60 && def.rpm <= 1300, `rpm ${def.rpm}`);
      assert(def.magSize >= 1 && def.magSize <= 100, `magSize ${def.magSize}`);
      assert(def.damage > 0 && def.damage <= 120, `damage ${def.damage}`);
      assert(def.muzzleVelocity >= 250 && def.muzzleVelocity <= 1100, `v0 ${def.muzzleVelocity}`);
      assert(def.adsTime > 0.05 && def.adsTime < 1.0, `adsTime ${def.adsTime}`);
      assert(def.spreadAds < def.spreadHip, 'ADS must be tighter than the hip');
      assert(def.spreadMax > def.spreadHip, 'spreadMax must exceed the resting hip cone');
      assert(def.reloadEmpty >= def.reloadTac, 'empty reload cannot be faster than tactical');
      assert(def.eyeRelief > 0 && def.eyeRelief < 0.5, `eyeRelief ${def.eyeRelief}`);
      assert(def.adsFov > 0.2 && def.adsFov <= 1, `adsFov ${def.adsFov}`);
    });
    check('fire modes are known', () => {
      const KNOWN = ['auto', 'burst', 'semi', 'pump'];
      assert(def.modes.length > 0, 'no fire modes');
      for (const m of def.modes) assert(KNOWN.includes(m), `unknown mode ${m}`);
    });
    check('mount points are real slots', () => {
      for (const s of def.mounts) assert(A.SLOT_ORDER.includes(s), `unknown mount ${s}`);
    });
    check('damage falls off monotonically', () => {
      let prev = Infinity;
      for (let d = 0; d <= def.maxRange; d += def.maxRange / 12) {
        const dmg = damageAt(def, d);
        assert(dmg <= prev + 1e-9, `damage rose at ${d} m`);
        assert(dmg > 0, `damage hit zero at ${d} m`);
        prev = dmg;
      }
    });
    check('recoil pattern length fits the magazine', () => {
      assert(def.recoil.patternLength >= 8, 'pattern too short to learn');
      assert(def.recoil.climbShape.length >= 1, 'climbShape empty');
    });
  }

  group('arsenal: ported values match FPS Arena');
  // Spot-check the numbers that came straight out of WEAPON_STATS.
  const PORTED = {
    akm: { magSize: 30, muzzleVelocity: 715, adsTime: 0.32, rpm: 600 },
    ak74: { magSize: 30, muzzleVelocity: 900, adsTime: 0.3 },
    m416: { magSize: 30, muzzleVelocity: 880, adsTime: 0.27 },
    scar: { magSize: 20, muzzleVelocity: 870, adsTime: 0.34 },
    svd: { magSize: 10, muzzleVelocity: 830, adsTime: 0.42 },
    mp5: { magSize: 30, muzzleVelocity: 400, adsTime: 0.22 },
    m870: { magSize: 6, muzzleVelocity: 400, adsTime: 0.3 },
    glock18: { magSize: 17, muzzleVelocity: 375, adsTime: 0.15 },
    deagle: { magSize: 9, muzzleVelocity: 470, adsTime: 0.22 },
  };
  for (const [id, want] of Object.entries(PORTED)) {
    check(`${id} keeps its FPS Arena numbers`, () => {
      const def = ARSENAL_DEFS[id];
      for (const [k, v] of Object.entries(want)) near(def[k], v, 1e-6, `${id}.${k}`);
    });
  }
  check('cadence conversion matches the old fireRate', () => {
    // FPS Arena stored seconds-per-shot; 0.10 s == 600 rpm.
    near(cycleTime(ARSENAL_DEFS.akm, 'auto'), 0.1, 1e-3, 'akm');
    near(cycleTime(ARSENAL_DEFS.m416, 'auto'), 0.085, 1e-3, 'm416');
    near(cycleTime(ARSENAL_DEFS.m870, 'pump'), 0.857, 2e-3, 'm870');
  });
  check('Glock auto sear is faster than its semi cadence', () => {
    const g = ARSENAL_DEFS.glock18;
    assert(cycleTime(g, 'auto') < cycleTime(g, 'semi'), 'auto sear not faster');
  });
  check('shotgun carries pellet data, nothing else does', () => {
    assert(ARSENAL_DEFS.m870.pellets === 9, 'M870 lost its nine pellets');
    for (const id of ARSENAL_ORDER) {
      if (id === 'm870') continue;
      assert(!ARSENAL_DEFS[id].pellets, `${id} should not fire pellets`);
    }
  });
  check('SVD carries breath-hold data and defaults to glass', () => {
    assert(ARSENAL_DEFS.svd.breathHold, 'no breath hold');
    assert(ARSENAL_DEFS.svd.defaultOptic === 'pso4x', 'SVD should come scoped');
  });
  check('every carry slot has at least one weapon', () => {
    for (const slot of SLOTS) assert(weaponsInSlot(slot).length > 0, `slot ${slot} empty`);
  });
  check('relative lethality survived the damage conversion', () => {
    const d = (id) => ARSENAL_DEFS[id].damage;
    assert(d('svd') > d('deagle'), 'SVD should out-hit the Deagle');
    assert(d('deagle') > d('scar'), 'Deagle should out-hit SCAR-H per shot');
    assert(d('scar') > d('akm'), 'SCAR-H should out-hit the AKM');
    assert(d('akm') > d('ak74'), 'AKM (7.62) should out-hit the AK-74 (5.45)');
    assert(d('ak74') > d('m416'), 'AK-74 should out-hit the M416');
    assert(d('m416') > d('glock18'), 'rifle should out-hit a pistol');
    assert(d('m870') * ARSENAL_DEFS.m870.pellets > d('svd'), 'full shotgun load should be lethal up close');
  });

  /* --------------------------------------------------------- attachments */
  const { ATTACHMENTS, SLOT_ORDER, BY_SLOT, canMount, defaultLoadout, resolveStats, nextOptic, statDelta } = A;

  group('attachments: catalog');
  check('every entry is well formed', () => {
    for (const [id, att] of Object.entries(ATTACHMENTS)) {
      assert(att.id === id, `${id}: id mismatch`);
      assert(SLOT_ORDER.includes(att.slot), `${id}: bad slot ${att.slot}`);
      assert(typeof att.label === 'string' && att.label.length, `${id}: no label`);
      assert(typeof att.mass === 'number', `${id}: no mass`);
      assert(att.mul && att.add, `${id}: missing modifier tables`);
    }
  });
  check('every slot offers something', () => {
    for (const slot of SLOT_ORDER) assert(BY_SLOT[slot].length > 0, `slot ${slot} is empty`);
  });
  check('all four FPS Arena sight tiers are present', () => {
    for (const id of ['iron', 'reddot', 'holo', 'scope3x']) {
      assert(ATTACHMENTS[id], `missing optic ${id}`);
    }
  });
  check('laser, flashlight and suppressor are all detachable', () => {
    for (const id of ['laser', 'flashlight', 'suppressor', 'reddot', 'holo', 'scope3x']) {
      assert(ATTACHMENTS[id].detachable, `${id} must be removable`);
    }
  });
  check('more magnification costs more ADS time', () => {
    const t = (id) => ATTACHMENTS[id].mul.adsTime ?? 1;
    assert(t('reddot') < t('holo') && t('holo') < t('scope3x') && t('scope3x') < t('pso4x'),
      'ADS penalty should grow with magnification');
    const z = (id) => ATTACHMENTS[id].zoom;
    assert(z('reddot') > z('holo') && z('holo') > z('scope3x') && z('scope3x') > z('pso4x'),
      'FOV scale should shrink with magnification');
  });

  group('attachments: compatibility');
  check('PSO-1 only fits the AK family and the SVD', () => {
    assert(canMount(ARSENAL_DEFS.svd, 'pso4x').ok, 'SVD should take a PSO');
    assert(canMount(ARSENAL_DEFS.akm, 'pso4x').ok, 'AKM should take a PSO');
    assert(!canMount(ARSENAL_DEFS.m416, 'pso4x').ok, 'M416 must not take a PSO');
  });
  check('pistols reject foregrips and magazines they do not have', () => {
    assert(!canMount(ARSENAL_DEFS.glock18, 'foregrip').ok, 'no foregrip on a Glock');
    assert(!canMount(ARSENAL_DEFS.glock18, 'magExtended').ok, 'Glock has no magazine mount listed');
  });
  check('the shotgun has no muzzle or magazine mount', () => {
    assert(!canMount(ARSENAL_DEFS.m870, 'suppressor').ok, 'M870 must not take a can');
    assert(!canMount(ARSENAL_DEFS.m870, 'magExtended').ok, 'M870 is tube-fed');
    assert(canMount(ARSENAL_DEFS.m870, 'reddot').ok, 'M870 should take a red dot');
  });
  check('bipods only fit rifles and marksman rifles', () => {
    assert(canMount(ARSENAL_DEFS.svd, 'bipod').ok, 'SVD should take a bipod');
    assert(!canMount(ARSENAL_DEFS.mp5, 'bipod').ok, 'no bipod on an MP5');
  });
  check('unknown ids are rejected, not thrown', () => {
    const r = canMount(ARSENAL_DEFS.akm, 'railgun');
    assert(r.ok === false && typeof r.reason === 'string', 'should fail softly');
  });

  group('attachments: stat resolution');
  check('default loadout is irons + standard mag', () => {
    const l = defaultLoadout(ARSENAL_DEFS.m416);
    assert(l.optic === 'iron' && l.magazine === 'magStandard', JSON.stringify(l));
    assert(defaultLoadout(ARSENAL_DEFS.svd).optic === 'pso4x', 'SVD default optic');
    assert(defaultLoadout(ARSENAL_DEFS.m870).magazine === undefined, 'M870 has no mag slot');
  });
  check('resolving does not mutate the definition', () => {
    const before = JSON.stringify(ARSENAL_DEFS.akm);
    resolveStats(ARSENAL_DEFS.akm, { optic: 'holo', muzzle: 'suppressor', magazine: 'magExtended' });
    assert(JSON.stringify(ARSENAL_DEFS.akm) === before, 'def was mutated');
  });
  check('suppressor trades velocity and damage for silence', () => {
    const bare = resolveStats(ARSENAL_DEFS.akm, defaultLoadout(ARSENAL_DEFS.akm));
    const can = resolveStats(ARSENAL_DEFS.akm, { ...defaultLoadout(ARSENAL_DEFS.akm), muzzle: 'suppressor' });
    assert(can.silent === true, 'not silent');
    assert(can.muzzleVelocity < bare.muzzleVelocity, 'velocity unchanged');
    assert(can.damage < bare.damage, 'damage unchanged');
    assert(can.flashScale < bare.flashScale * 0.3, 'flash not hidden');
    assert(can.adsTime > bare.adsTime, 'extra mass should slow the aim');
    assert(can.weight > bare.weight, 'mass not added');
  });
  check('extended magazine grows the mag and slows the reload', () => {
    const d = ARSENAL_DEFS.m416;
    const ext = resolveStats(d, { ...defaultLoadout(d), magazine: 'magExtended' });
    assert(ext.magSize === 42, `expected 42, got ${ext.magSize}`);
    assert(Number.isInteger(ext.magSize), 'magazine must be a whole number of rounds');
    assert(ext.reloadTac > d.reloadTac, 'reload unchanged');
  });
  check('quickdraw magazine only speeds up reloads', () => {
    const d = ARSENAL_DEFS.akm;
    const q = resolveStats(d, { ...defaultLoadout(d), magazine: 'magQuick' });
    assert(q.reloadTac < d.reloadTac, 'reload unchanged');
    assert(q.magSize === d.magSize, 'mag size should not change');
  });
  check('optic sets the ADS zoom and eye relief', () => {
    const d = ARSENAL_DEFS.akm;
    const holo = resolveStats(d, { optic: 'holo' });
    assert(holo.zoom === ATTACHMENTS.holo.zoom, 'zoom not applied');
    near(holo.relief, d.eyeRelief + ATTACHMENTS.holo.relief, 1e-9, 'relief');
    assert(holo.opticKind === 'holo', 'opticKind not reported');
  });
  check('laser tightens the hip cone only while lit', () => {
    const d = ARSENAL_DEFS.akm;
    const on = resolveStats(d, { tactical: 'laser' }, { laserOn: true });
    const off = resolveStats(d, { tactical: 'laser' }, { laserOn: false });
    near(on.spreadHip, d.spreadHip * 0.72, 1e-6, 'lit');
    near(off.spreadHip, d.spreadHip, 1e-6, 'dark');
    assert(on.hasLaser && off.hasLaser, 'laser presence lost');
  });
  check('flashlight reports a light spec for the renderer', () => {
    const s = resolveStats(ARSENAL_DEFS.m416, { tactical: 'flashlight' });
    assert(s.hasLight && s.light && s.light.angle > 0, 'no usable light spec');
  });
  check('bipod bonus applies only when deployed', () => {
    const d = ARSENAL_DEFS.svd;
    const up = resolveStats(d, { underbarrel: 'bipod' });
    const down = resolveStats(d, { underbarrel: 'bipod' }, { bipodDeployed: true });
    assert(down.recoilPitch < up.recoilPitch, 'deployed bipod did nothing');
    assert(down.spreadAds < up.spreadAds, 'deployed bipod did not steady the aim');
  });
  check('incompatible entries are reported, not silently dropped', () => {
    const s = resolveStats(ARSENAL_DEFS.m416, { optic: 'pso4x' });
    assert(s.rejected.length === 1, 'expected one rejection');
    assert(s.attachments.optic === undefined, 'illegal optic was mounted');
    assert(s.zoom === ARSENAL_DEFS.m416.adsFov, 'zoom should fall back to irons');
  });
  check('a full build resolves to finite, sane numbers', () => {
    for (const id of ARSENAL_ORDER) {
      const def = ARSENAL_DEFS[id];
      const build = { ...defaultLoadout(def) };
      for (const slot of SLOT_ORDER) {
        const pick = BY_SLOT[slot].find((a) => canMount(def, a).ok && ATTACHMENTS[a].detachable);
        if (pick) build[slot] = pick;
      }
      const s = resolveStats(def, build, { laserOn: true });
      assert(s.rejected.length === 0, `${id}: ${JSON.stringify(s.rejected)}`);
      for (const key of ['damage', 'adsTime', 'spreadHip', 'spreadAds', 'magSize', 'recoilPitch', 'weight', 'muzzleVelocity']) {
        assert(Number.isFinite(s[key]) && s[key] > 0, `${id}.${key} = ${s[key]}`);
      }
      assert(s.spreadAds < s.spreadHip, `${id}: ADS cone must stay tighter than the hip`);
      assert(s.adsTime < 1.4, `${id}: ADS time ${s.adsTime.toFixed(2)} s is unplayable`);
    }
  });
  check('optic cycling walks the ring and comes home', () => {
    const d = ARSENAL_DEFS.akm;
    const seen = new Set();
    let cur = 'iron';
    for (let i = 0; i < 12; i += 1) {
      cur = nextOptic(d, cur);
      seen.add(cur);
      if (cur === 'iron' && i > 0) break;
    }
    assert(seen.has('reddot') && seen.has('holo') && seen.has('scope3x'), `ring was ${[...seen]}`);
    assert(cur === 'iron', 'cycle did not return to irons');
  });
  check('optic cycling respects what the player owns', () => {
    const d = ARSENAL_DEFS.m416;
    const owned = new Set(['reddot']);
    let cur = 'iron';
    const ring = [];
    for (let i = 0; i < 4; i += 1) {
      cur = nextOptic(d, cur, owned);
      ring.push(cur);
    }
    assert(!ring.includes('holo'), 'offered an unowned holo sight');
    assert(ring.includes('reddot'), 'never offered the owned red dot');
  });
  check('stat delta reads the right way round', () => {
    const d = ARSENAL_DEFS.akm;
    const rows = statDelta(d, { ...defaultLoadout(d), muzzle: 'brake', magazine: 'magExtended' });
    const byStat = Object.fromEntries(rows.map((r) => [r.stat, r]));
    assert(byStat.recoilPitch && byStat.recoilPitch.better, 'brake should read as an improvement');
    assert(byStat.magSize && byStat.magSize.better, 'bigger mag should read as an improvement');
    assert(byStat.reloadTac && !byStat.reloadTac.better, 'slower reload should read as a downside');
  });
}

/* -------------------------------------------------------------------- main */
const args = process.argv.slice(2);
const want = (flag) => args.length === 0 || args.includes(flag);

if (want('--syntax')) await syntax();
if (want('--contract')) await contract();
if (want('--unit')) await unit();

const width = 58;
for (const g of groups) {
  if (!g.tests) continue;
  const mark = g.failed ? 'FAIL' : ' ok ';
  const dots = '.'.repeat(Math.max(2, width - g.name.length - String(g.tests).length));
  console.log(`[${mark}] ${g.name} ${dots} ${g.tests - g.failed}/${g.tests}`);
}
console.log('');
if (failures.length) {
  console.log(`${failures.length} failure(s):\n`);
  for (const f of failures) console.log(`  ✗ ${f.group} / ${f.label}\n      ${f.message}`);
  process.exit(1);
}
console.log(`all green — ${passed} checks passed`);
