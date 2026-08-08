import {
  box,
  dome,
  latheZ,
  rodZ,
  tubeZ,
  knurlBand,
  serrations,
  mlokSlot,
  ring,
} from '../../weapons/geometry.js';
import { layoutOf } from './specs.js';

/**
 * ARSENAL — the detail pass.
 *
 * specs.js declares 38 `features` across the nine weapons. build.js reads 15 of
 * them. The rest were declared and then never built: a Glock with
 * 'slideSerrations' had smooth slide flats, a Desert Eagle with
 * 'triangularBarrel' had a round barrel like every other gun, an MP5 with
 * 'collapsingStock' wore an AR receiver-extension stock, and 'boltCatch',
 * 'brassDeflector', 'shellLifter', 'triggerSafety', 'gasPiston' and
 * 'ambiCharging' existed only as strings in an array.
 *
 * That is why the roster read as one weapon with nine sets of numbers. The
 * silhouettes differed; the surfaces did not. This module builds what the specs
 * already promise, so a feature string means geometry rather than intent.
 *
 * Everything here is millimetre work against the real hardware, in the same
 * coordinate frame as specs.js: -Z down range, +Y up, +X right, metres.
 *
 * LOD. All of this lands on a viewmodel that fills a third of the screen, so at
 * `lod: 0` it is all built. A weapon on the ground or in another player's hands
 * never shows a 0.4 mm serration, so `lod: 1` drops the sub-millimetre work and
 * `lod: 2` keeps only what changes the silhouette. Callers that do not care get
 * full detail, which keeps the gunsmith board and the viewmodel unchanged.
 */

/** Fine detail is anything below roughly a millimetre of relief. */
const FINE = 0;
/** Mid detail still reads at arm's length: covers, levers, deflectors. */
const MID = 1;

/**
 * Add `geo` to `body` and dispose it. Every helper below builds one-shot
 * geometry, and forgetting the dispose leaks a buffer per weapon per rebuild —
 * the gunsmith board rebuilds on every attachment change.
 */
function put(body, geo, mat, t) {
  body.add(geo, mat, t);
  geo.dispose();
  return body;
}

/** Mirror a part across the centreline. Ambidextrous controls, paired screws. */
function putBoth(body, geo, mat, t) {
  const x = t.x ?? 0;
  body.add(geo, mat, t);
  body.add(geo, mat, { ...t, x: -x, sx: -(t.sx ?? 1) });
  geo.dispose();
  return body;
}

/* ------------------------------------------------------------------- AR bits */

/**
 * Bolt catch: the paddle on the left of an AR lower, ahead of the magwell. Two
 * lobes on a pin through a raised fence, because on the real gun the fence is
 * what stops the paddle being knocked by a sling.
 */
function boltCatch(body, spec, M) {
  const x = -spec.rUpper - 0.0028;
  const z = spec.zUpperFront + 0.036;
  const y = spec.bore - 0.0092;

  const fence = box(0.0044, 0.0132, 0.0224, 0.0007, 1);
  put(body, fence, M.alu, { x: x + 0.0012, y, z });

  // Upper lobe (the release) and lower lobe (the catch), joined by the web the
  // pin runs through.
  const upper = box(0.0038, 0.0072, 0.0086, 0.0009, 1);
  put(body, upper, M.steel, { x, y: y + 0.0042, z: z - 0.0062 });
  const lower = box(0.0038, 0.0096, 0.0078, 0.0009, 1);
  put(body, lower, M.steel, { x, y: y - 0.0034, z: z + 0.0068 });
  const web = box(0.0034, 0.0048, 0.0132, 0.0006, 1);
  put(body, web, M.steel, { x, y, z });

  // Serrated thumb face on the release lobe.
  const grip = serrations(0.0034, 0.0064, 0.0082, 4, 0.00035, 'y');
  put(body, grip, M.soot, { x: x - 0.0021, y: y + 0.0042, z: z - 0.0062 });

  const pin = rodZ(0.0011, 0.0011, 0.0076, 8, 0.0002);
  put(body, pin, M.bright, { x: x + 0.0008, y, z, ry: Math.PI / 2 });
}

/**
 * Brass deflector: the wedge behind the ejection port that keeps cases off a
 * left-handed shooter's face. On an AR it is a cast bulge on the upper, and it
 * is one of the most recognisable shapes on the receiver's right side.
 */
function brassDeflector(body, spec, M) {
  const x = spec.rUpper + 0.0034;
  const z = spec.portZ + 0.026;
  const y = spec.bore + 0.0052;

  // A truncated cone laid on its side reads as the cast wedge without needing a
  // bespoke profile: wide at the receiver, tapering out and back.
  const wedge = rodZ(0.0102, 0.0044, 0.0148, 12, 0.0008);
  put(body, wedge, M.alu, { x, y, z, ry: Math.PI / 2 - 0.34, rz: 0.12 });

  // The port fence it grows out of, so the two read as one casting.
  const fence = box(0.0038, 0.0148, 0.0272, 0.0011, 1);
  put(body, fence, M.alu, { x: x - 0.0042, y: y - 0.0018, z: spec.portZ + 0.004 });
}

/**
 * Backup irons: the folding hinge and detent knob that make a BUIS read as a
 * mechanism rather than a fixed post. addFrontSight/addRearSight in build.js
 * already place the sight bodies; this is the hardware that folds them.
 */
function buisHardware(body, spec, M) {
  const L = layoutOf(spec);
  const zRear = spec.zUpperRear - 0.018;

  // Hinge barrel across the rail, plus the spring detent knob on the right.
  const hinge = rodZ(0.0026, 0.0026, 0.0182, 10, 0.0003);
  put(body, hinge, M.steel, { y: L.railTop + 0.0028, z: zRear + 0.0092, ry: Math.PI / 2 });
  const knob = knurlBand(0.0038, 0.0042, 14, 0.0003, 2);
  put(body, knob, M.soot, { x: 0.0108, y: L.railTop + 0.0028, z: zRear + 0.0092, ry: Math.PI / 2 });

  // Windage drum on the rear sight, and the elevation drum's index marks.
  const drum = knurlBand(0.0044, 0.0052, 16, 0.00032, 3);
  put(body, drum, M.soot, { x: 0.0092, y: L.railTop + 0.0132, z: zRear, ry: Math.PI / 2 });

  const front = rodZ(0.0024, 0.0024, 0.0168, 10, 0.0003);
  put(body, front, M.steel, {
    y: L.railTop + 0.0028,
    z: (spec.hgZ1 ?? spec.zUpperFront) + 0.0242,
    ry: Math.PI / 2,
  });
}

/* ---------------------------------------------------------------- SCAR bits */

/**
 * Ambidextrous charging handle: the SCAR's handle can be run on either side, so
 * the receiver carries a slot and a shoulder on both flanks. Without the left
 * slot the receiver was symmetric only by accident.
 */
function ambiCharging(body, spec, M) {
  const y = spec.bore + spec.rUpper * 0.52;
  const z = spec.zUpperRear - 0.052;
  const len = 0.086;

  // The slot: a cavity-material channel, so it reads as an opening rather than a
  // painted line.
  const slot = box(0.0032, 0.0062, len, 0.0004, 1);
  putBoth(body, slot, M.cavity, { x: spec.rUpper - 0.0004, y, z });

  // Rolled lips above and below the channel.
  const lipTop = box(0.0044, 0.0022, len, 0.0005, 1);
  putBoth(body, lipTop, M.alu, { x: spec.rUpper - 0.0006, y: y + 0.0042, z });
  const lipBot = box(0.0044, 0.0022, len, 0.0005, 1);
  putBoth(body, lipBot, M.alu, { x: spec.rUpper - 0.0006, y: y - 0.0042, z });

  // Forward shoulder the handle latches into at each end of the slot.
  const stop = box(0.0046, 0.0072, 0.0034, 0.0006, 1);
  putBoth(body, stop, M.steel, { x: spec.rUpper - 0.0006, y, z: z - len / 2 - 0.0017 });
}

/* ----------------------------------------------------------------- MP5 bits */

/**
 * Tubular receiver: an MP5's upper is a rolled steel tube, not a machined
 * flat-sided box. Wrapping the generic upper in a tube shell with a visible weld
 * seam is what stops it reading as an AR with different numbers.
 */
function tubularReceiver(body, spec, M) {
  const L = layoutOf(spec);
  const len = L.receiverLen - 0.004;
  const zMid = (spec.zUpperRear + spec.zUpperFront) / 2;

  const shell = tubeZ(spec.rUpper + 0.0014, spec.rUpper - 0.0004, len, 20, 0.0005);
  put(body, shell, M.steel, { y: spec.bore, z: zMid });

  // Weld seam along the top, offset from the centreline like the real tube.
  const seam = box(0.0026, 0.0014, len - 0.008, 0.0003, 1);
  put(body, seam, M.soot, { x: 0.0042, y: spec.bore + spec.rUpper + 0.0012, z: zMid });

  // The three pressed indents that locate the trunnion.
  for (let i = 0; i < 3; i++) {
    const dent = dome(0.0026, 8, 0.45);
    put(body, dent, M.steel, {
      x: spec.rUpper + 0.0008,
      y: spec.bore - 0.0032,
      z: spec.zUpperFront + 0.018 + i * 0.021,
      rz: -Math.PI / 2,
    });
  }
}

/**
 * Wrap-around handguard flange: the MP5's forend is a single polymer shell that
 * closes under the barrel, with a seam either side and a sling swivel boss at
 * the front. addHandguard builds slats; this closes them into a shell.
 */
function wrapHandguard(body, spec, M) {
  const zMid = (spec.hgZ0 + spec.hgZ1) / 2;
  const len = Math.abs(spec.hgZ1 - spec.hgZ0);

  const belly = latheZ(
    [
      [0, spec.hgR * 0.55],
      [0.006, spec.hgR + 0.0018],
      [len - 0.01, spec.hgR + 0.0018],
      [len, spec.hgR * 0.6],
    ],
    16,
    Math.PI * 0.18,
    Math.PI * 0.64
  );
  put(body, belly, M.poly, { y: spec.bore, z: spec.hgZ0, rz: Math.PI });

  // Mould seams either flank.
  const seam = box(0.0018, 0.0026, len - 0.012, 0.0003, 1);
  putBoth(body, seam, M.poly, { x: spec.hgR + 0.0012, y: spec.bore - 0.0062, z: zMid });

  // Front swivel boss.
  const boss = box(0.0132, 0.0098, 0.0122, 0.0012, 1);
  put(body, boss, M.poly, { y: spec.bore - spec.hgR - 0.0028, z: spec.hgZ1 + 0.0122 });
}

/**
 * Collapsing wire stock: the MP5's sliding stock is a steel tube pair on a
 * collar with a thin butt. build.js otherwise gives it addCarbineStock, which is
 * an AR receiver extension — the wrong mechanism entirely.
 */
function collapsingStock(body, spec, M) {
  const z0 = spec.zUpperRear;
  const z1 = spec.stockRear;
  const len = Math.abs(z1 - z0);

  // Two slide tubes either side of the centreline.
  const tube = tubeZ(0.0062, 0.0046, len, 12, 0.0004);
  putBoth(body, tube, M.steel, { x: 0.0148, y: spec.bore - 0.0132, z: (z0 + z1) / 2 });

  // The collar they run through, clamped to the receiver's rear.
  const collar = box(0.0432, 0.0206, 0.0142, 0.0016, 1);
  put(body, collar, M.steel, { y: spec.bore - 0.0132, z: z0 + 0.0092 });

  // Butt plate: thin, sprung, with a rubber face.
  const plate = box(0.0402, 0.0512, 0.0072, 0.0014, 1);
  put(body, plate, M.steel, { y: spec.bore - 0.0182, z: z1 - 0.0034 });
  const pad = box(0.0392, 0.0492, 0.0038, 0.0012, 1);
  put(body, pad, M.rubber, { y: spec.bore - 0.0182, z: z1 + 0.0018 });

  // Detent button on the left of the collar.
  const button = rodZ(0.0034, 0.0034, 0.0048, 10, 0.0004);
  put(body, button, M.soot, { x: -0.0238, y: spec.bore - 0.0132, z: z0 + 0.0092, ry: Math.PI / 2 });
}

/* ---------------------------------------------------------------- M870 bits */

/**
 * Shell lifter and carrier: the sprung tongue inside a pump's loading port. It
 * is the one moving part you see through the bottom of the receiver, and its
 * absence is why the M870's underside read as a solid block.
 */
function shellLifter(body, spec, M) {
  const z = spec.zUpperFront + 0.03;
  const y = spec.bore - 0.0182;

  // The lifter tongue, tilted up into the receiver.
  const lifter = box(0.0242, 0.0028, 0.0382, 0.0005, 1);
  put(body, lifter, M.bright, { y, z, rx: 0.14 });

  // Loading port cut in the receiver belly, and the shell stop either side.
  const port = box(0.0252, 0.0042, 0.0432, 0.0006, 1);
  put(body, port, M.cavity, { y: y - 0.0042, z });
  const stop = box(0.0032, 0.0062, 0.0122, 0.0005, 1);
  putBoth(body, stop, M.steel, { x: 0.0132, y: y - 0.0022, z: z - 0.0182 });

  // Carrier pivot pin.
  const pin = rodZ(0.0013, 0.0013, 0.0272, 8, 0.0002);
  put(body, pin, M.bright, { y: y + 0.0022, z: z + 0.0192, ry: Math.PI / 2 });
}

/* -------------------------------------------------------------- pistol bits */

/**
 * Slide serrations: the angled cocking grooves at the rear of a slide, and on
 * these two guns the front cocking grooves as well. Both specs have declared
 * 'slideSerrations' from the start while the slide flats stayed smooth — the
 * single most obvious missing detail on either pistol.
 */
function slideSerrations(body, spec, M) {
  if (!spec.slide) return;
  const s = spec.slide;
  const y = spec.bore + 0.0042;
  const xFlank = s.w / 2 - 0.0004;

  // Rear grooves: eleven ribs over 34 mm, the usual count on a service slide.
  const rear = serrations(0.0028, s.h * 0.62, 0.0342, 11, 0.00042, 'y');
  putBoth(body, rear, M.soot, { x: xFlank, y, z: s.zRear - 0.0242 });

  // Front grooves, shorter, ahead of the ejection port.
  const front = serrations(0.0028, s.h * 0.5, 0.0182, 6, 0.00038, 'y');
  putBoth(body, front, M.soot, { x: xFlank, y, z: s.zRear - s.len + 0.0322 });

  // Top flat gets a single anti-glare row of fine longitudinal lines.
  const top = serrations(s.w * 0.52, 0.0016, 0.0522, 9, 0.00022, 'x');
  put(body, top, M.soot, { y: spec.bore + s.h * 0.5 + 0.0008, z: s.zRear - s.len * 0.46 });
}

/**
 * Glock trigger safety: the blade split down the middle with a sprung centre
 * tab. It is a 6 mm detail that every player recognises instantly, and it was
 * declared but never built.
 */
function triggerSafety(body, spec, M) {
  const y = spec.bore - 0.0295;
  const z = spec.gripZ - 0.0205;

  const tab = box(0.0022, 0.0132, 0.0032, 0.0004, 1);
  put(body, tab, M.soot, { y, z: z - 0.0018, rx: -0.12 });
  // The two blade halves either side of it.
  const half = box(0.0016, 0.0142, 0.0038, 0.0004, 1);
  putBoth(body, half, M.soot, { x: 0.0021, y, z, rx: -0.12 });
}

/**
 * Glock 18 selector: the fire-mode lever on the rear left of the slide. This is
 * the only external difference between a Glock 17 and a Glock 18, so a G18
 * without it is a G17.
 */
function autoSear(body, spec, M) {
  if (!spec.slide) return;
  const s = spec.slide;
  const x = -(s.w / 2) - 0.0022;
  const z = s.zRear - 0.0092;
  const y = spec.bore + 0.0102;

  const plate = box(0.0034, 0.0122, 0.0162, 0.0006, 1);
  put(body, plate, M.soot, { x, y, z });
  // The two-position paddle, canted to the rear position.
  const paddle = box(0.0028, 0.0062, 0.0102, 0.0005, 1);
  put(body, paddle, M.bright, { x: x - 0.0026, y: y + 0.0012, z: z - 0.0022, rx: 0.22 });
  const detent = rodZ(0.0011, 0.0011, 0.0042, 8, 0.0002);
  put(body, detent, M.bright, { x: x - 0.0012, y, z, ry: Math.PI / 2 });
}

/**
 * Desert Eagle gas system: a gas piston tube slung under the barrel, feeding a
 * port near the muzzle. This is why a Deagle is a rifle action in a pistol
 * frame, and why its underside is not just a flat dust cover.
 */
function gasPiston(body, spec, M) {
  const z0 = spec.zBreech - 0.012;
  const z1 = spec.gasAt ?? spec.zBarrelEnd + 0.02;
  const len = Math.abs(z1 - z0);
  const y = spec.bore - spec.rBarrel - 0.0072;

  const tube = tubeZ(0.0058, 0.0042, len, 14, 0.0004);
  put(body, tube, M.steel, { y, z: (z0 + z1) / 2 });

  // Gas port block at the front, and the return spring collar at the rear.
  const block = box(0.0132, 0.0112, 0.0162, 0.0012, 1);
  put(body, block, M.soot, { y: y + 0.0022, z: z1 + 0.0072 });
  const collar = ring(0.0068, 0.0016, 12, 6);
  put(body, collar, M.bright, { y, z: z0 - 0.004 });
}

/**
 * Desert Eagle barrel: the Mark XIX barrel is a squared shroud with a full-length
 * top rib and scalloped flats, not a tube. The spec declared
 * 'triangularBarrel' and got the same round barrel as everything else, which
 * erased the gun's whole silhouette.
 */
function triangularBarrel(body, spec, M) {
  const z0 = spec.zBreech;
  const z1 = spec.zBarrelEnd;
  const len = Math.abs(z1 - z0);
  const zMid = (z0 + z1) / 2;

  // Squared shroud around the round barrel.
  const shroud = box(spec.rBarrel * 2 + 0.0062, spec.rBarrel * 2 + 0.0052, len - 0.004, 0.0011, 1);
  put(body, shroud, M.steel, { y: spec.bore, z: zMid });

  // Full-length top rib with a mounting slot pair.
  const rib = box(0.0112, 0.0042, len - 0.012, 0.0007, 1);
  put(body, rib, M.aluFine, { y: spec.bore + spec.rBarrel + 0.0042, z: zMid });
  for (let i = 0; i < 2; i++) {
    const slot = box(0.0072, 0.0018, 0.0042, 0.0003, 1);
    put(body, slot, M.cavity, {
      y: spec.bore + spec.rBarrel + 0.0058,
      z: zMid - 0.022 + i * 0.044,
    });
  }

  // Scalloped flanks: the milled lightening cuts along each side.
  for (let i = 0; i < 3; i++) {
    const cut = box(0.0016, 0.0092, 0.0182, 0.0006, 1);
    putBoth(body, cut, M.cavity, {
      x: spec.rBarrel + 0.0031,
      y: spec.bore,
      z: z0 - 0.024 - i * 0.026,
    });
  }
}

/** Pistol frame material: polymer reads matte and warm, steel reads cold. */
function frameShell(body, spec, M, steel) {
  const mat = steel ? M.steel : M.poly;
  const y = spec.bore - 0.0182;
  const z = (spec.zUpperRear + spec.zUpperFront) / 2 + 0.012;

  // Dust cover ahead of the trigger guard.
  const cover = box(spec.rUpper * 1.5, 0.0142, Math.abs(spec.zUpperFront - spec.gripZ) * 0.72, 0.0014, 1);
  put(body, cover, mat, { y, z });

  // Frame rails the slide rides on, always steel even on a polymer frame — this
  // is the detail that makes a polymer pistol read as a real mechanism.
  const rail = box(0.0026, 0.0032, 0.0322, 0.0004, 1);
  putBoth(body, rail, M.bright, { x: spec.rUpper - 0.0012, y: spec.bore - 0.0042, z: spec.zUpperRear - 0.0242 });

  // Takedown lever and the pin behind it.
  const lever = box(0.0032, 0.0062, 0.0122, 0.0006, 1);
  put(body, lever, M.bright, { x: -spec.rUpper - 0.0018, y: spec.bore - 0.0122, z: spec.zUpperRear - 0.0422 });

  if (!steel) {
    // Moulded grip stippling, in four panels.
    for (let i = 0; i < 2; i++) {
      const panel = serrations(0.0182, 0.0242, 0.0016, 7, 0.00028, 'x');
      putBoth(body, panel, mat, {
        x: spec.rUpper * 0.92,
        y: spec.bore - 0.052 - i * 0.026,
        z: spec.gripZ + 0.0042,
        ry: Math.PI / 2,
      });
    }
  } else {
    // Chequered walnut-style grip panels on the steel frame.
    const panel = serrations(0.0202, 0.0382, 0.0022, 9, 0.00034, 'x');
    putBoth(body, panel, M.rubber, {
      x: spec.rUpper * 0.96,
      y: spec.bore - 0.062,
      z: spec.gripZ + 0.0042,
      ry: Math.PI / 2,
    });
  }
}

/* ------------------------------------------------------------------- M-LOK */

/**
 * Real M-LOK cutouts in a railed handguard.
 *
 * geometry.js has had an `mlokSlot` helper the whole time and nothing called it,
 * so every "railed" handguard was a smooth extrusion with a rail on top. These
 * are the negative-space slots that make a modern forend look modern.
 */
function mlokCutouts(body, spec, M) {
  const len = Math.abs(spec.hgZ1 - spec.hgZ0);
  const count = Math.max(2, Math.min(6, Math.floor(len / 0.042)));
  const step = (len - 0.03) / count;

  for (let i = 0; i < count; i++) {
    const z = spec.hgZ0 - 0.022 - i * step;
    // Three o'clock and nine o'clock rows.
    const side = mlokSlot(0.032, 0.0075, 0.0022);
    putBoth(body, side, M.alu, { x: spec.hgR - 0.0008, y: spec.bore, z, ry: Math.PI / 2 });
    // Six o'clock row, offset half a step so the rows interlock like the real thing.
    if (i < count - 1) {
      const under = mlokSlot(0.032, 0.0075, 0.0022);
      put(body, under, M.alu, { y: spec.bore - spec.hgR + 0.0008, z: z - step / 2, rx: Math.PI / 2 });
    }
  }
}

/* --------------------------------------------------------------- entry point */

/**
 * Build every declared feature that build.js does not already handle.
 *
 * Called after the main groups so the detail sits on top of finished surfaces.
 * Unknown features are ignored rather than throwing: `rollerDelay` and
 * `autoSear`-style internals legitimately have no external geometry, and the
 * gate in verify-arena is what asserts the visible ones are covered.
 *
 * @param {Assembly} body
 * @param {object} spec
 * @param {Record<string,string>} M  material keys from build.js
 * @param {number} lod  0 full, 1 no sub-millimetre relief, 2 silhouette only
 */
export function addSpecDetail(body, spec, M, lod = FINE) {
  const has = (f) => spec.features.includes(f);

  // Silhouette-changing work: built at every level.
  if (has('tubularReceiver')) tubularReceiver(body, spec, M);
  if (has('wrapHandguard')) wrapHandguard(body, spec, M);
  if (has('collapsingStock')) collapsingStock(body, spec, M);
  if (has('triangularBarrel')) triangularBarrel(body, spec, M);
  if (has('gasPiston')) gasPiston(body, spec, M);
  if (has('polymerFrame')) frameShell(body, spec, M, false);
  if (has('steelFrame')) frameShell(body, spec, M, true);

  if (lod > MID) return;

  // Mid detail: controls and covers that read at a few metres.
  if (has('boltCatch')) boltCatch(body, spec, M);
  if (has('brassDeflector')) brassDeflector(body, spec, M);
  if (has('ambiCharging')) ambiCharging(body, spec, M);
  if (has('shellLifter')) shellLifter(body, spec, M);
  if (has('autoSear')) autoSear(body, spec, M);
  if (has('railedHandguard') && spec.hgR !== null) mlokCutouts(body, spec, M);

  if (lod > FINE) return;

  // Fine detail: sub-millimetre relief, only ever seen on a viewmodel.
  if (has('buis')) buisHardware(body, spec, M);
  if (has('slideSerrations')) slideSerrations(body, spec, M);
  if (has('triggerSafety')) triggerSafety(body, spec, M);
}

/** Which features `addSpecDetail` builds geometry for. The gate reads this. */
export const DETAILED_FEATURES = [
  'tubularReceiver',
  'wrapHandguard',
  'collapsingStock',
  'triangularBarrel',
  'gasPiston',
  'polymerFrame',
  'steelFrame',
  'boltCatch',
  'brassDeflector',
  'ambiCharging',
  'shellLifter',
  'autoSear',
  'railedHandguard',
  'buis',
  'slideSerrations',
  'triggerSafety',
];

export const LOD_FULL = FINE;
export const LOD_MID = MID;
export const LOD_SILHOUETTE = 2;
