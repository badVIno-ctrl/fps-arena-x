/**
 * VERIFY-MODELS — build every weapon, every attachment, headlessly.
 *
 * Geometry construction needs three.js but NOT a GL context: `Assembly` only
 * merges BufferGeometry, so the whole arsenal can be built in Node. That matters
 * because the alternative loop — boot the game in a browser, click through the
 * menu, wait ~50 s for shader prewarm on a software rasteriser, read one stack
 * trace — surfaces exactly one defect per run.
 *
 * This gate builds all 9 weapons plus each attachment rig and reports every
 * failure at once, in about a second.
 *
 * The `assertFinite` check inside Assembly.add is what gives this file teeth: a
 * NaN vertex throws with the assembly and material that produced it, instead of
 * silently poisoning a merged bounding sphere and surfacing later as an
 * untraceable "Computed radius is NaN" from inside the render loop.
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GAME = join(ROOT, 'game');

const load = (rel) => import(pathToFileURL(join(GAME, rel)).href);

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message.split('\n')[0]}`);
  }
}

const { ARSENAL_ORDER, ARSENAL_DEFS } = await load('arsenal/defs.js');
const { buildArsenalModel } = await load('arsenal/models/build.js');
const { specFor } = await load('arsenal/models/specs.js');
const { buildAttachmentUnit } = await load('arsenal/hardware/build.js');
const { ATTACHMENTS } = await load('arsenal/attachments.js');

console.log('\nmodels: every weapon body builds with finite geometry');
console.log('-'.repeat(60));

for (const id of ARSENAL_ORDER) {
  check(`${id} — body`, () => {
    const model = buildArsenalModel(id);
    if (!model) throw new Error('builder returned nothing');
  });
}

console.log('\nmodels: every attachment rig builds with finite geometry');
console.log('-'.repeat(60));

/**
 * An attachment is buildable on a weapon when the weapon has that mount and the
 * attachment's own `fits` predicate accepts the def. That pairing is the same
 * rule the board uses to decide what to offer, so walking it here covers exactly
 * the combinations a player can actually reach.
 */
for (const id of ARSENAL_ORDER) {
  const def = ARSENAL_DEFS[id];
  const spec = specFor(id);
  for (const att of Object.values(ATTACHMENTS)) {
    if (!def.mounts?.includes(att.slot)) continue;
    if (att.fits && !att.fits(def)) continue;
    check(`${id} · ${att.slot} · ${att.id}`, () => {
      const unit = buildAttachmentUnit(spec, att.id);
      if (!unit) throw new Error('builder returned nothing');
    });
  }
}

console.log('\n' + '='.repeat(60));
if (failures.length) {
  console.log(`${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) {
    console.log(`--- ${f.name}`);
    console.log(
      String(f.err.stack || f.err.message)
        .split('\n')
        .slice(0, 6)
        .join('\n'),
    );
    console.log();
  }
  process.exit(1);
}
console.log(`all green — ${passed} model builds passed`);
