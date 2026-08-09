import {
  box,
  blob,
  dome,
  latheZ,
  rodZ,
  tubeZ,
  knurlBand,
  serrations,
  ring,
  extrude,
  roundRect,
} from '../../weapons/geometry.js';
import { layoutOf } from './specs.js';

/**
 * ARSENAL — SIGNATURE GEOMETRY.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR
 * ---------------------------------------------------------------------------
 * `detail.js` builds what a weapon HAS: a bolt catch, a brass deflector, slide
 * serrations. Useful, and it was not enough — rendered in profile on one light,
 * the АКМ and the M416 were indistinguishable, and the report was blunt about
 * it: "визуально модельки M416 и калаша это одинаковые модельки".
 *
 * The reason is that identification does not work the way a parts list does. A
 * person does not recognise a Kalashnikov by counting its rivets. They recognise
 * it by four or five large shapes in a particular arrangement — the gas tube
 * riding ABOVE the barrel, the front sight tower standing off on a pedestal, the
 * gas block cut at a slant, wood where an AR has polymer. Every one of those is
 * readable at ten metres in a silhouette. None of them was in the model.
 *
 * So this module builds the LOUD geometry, per family, and it is deliberately
 * separate from `detail.js` because it answers a different question:
 *
 *   detail.js     "does this weapon have the parts it claims to have?"
 *   signature.js  "would someone who knows guns name this one from across
 *                  the room, with no colour and no texture?"
 *
 * ---------------------------------------------------------------------------
 * HOW TO JUDGE A CHANGE HERE
 * ---------------------------------------------------------------------------
 * Not by reading it. Render the weapon in left profile on flat light
 * (`node tools/lab.mjs eval --script=tools/lab/sheet.mjs`) and cover the label.
 * If the answer is not immediate, the shape is wrong — not the material, not the
 * roughness, the shape.
 *
 * Coordinates as everywhere else: −Z down range, +Y up, +X right, metres. Every
 * figure is scaled by the same viewmodel compression the specs are, because it
 * is read out of the spec's own fields rather than written as a constant.
 */

/** Add and dispose. Same contract as detail.js — one-shot geometry, no leaks. */
function put(body, geo, mat, t) {
  body.add(geo, mat, t);
  geo.dispose();
  return body;
}

/** Mirror across the centreline: paired rivets, paired lugs, paired bars. */
function putBoth(body, geo, mat, t) {
  const x = t.x ?? 0;
  body.add(geo, mat, t);
  body.add(geo, mat, { ...t, x: -x, sx: -(t.sx ?? 1) });
  geo.dispose();
  return body;
}

/* ========================================================================= */
/* KALASHNIKOV                                                               */
/* ========================================================================= */

/**
 * THE FRONT SIGHT TOWER.
 *
 * The most under-rated silhouette cue on the whole weapon. An AR's front sight
 * is a folding blade lying flat on a rail; an AK's is a cylindrical post inside
 * a machined hood, sitting on a BASE that stands 18 mm clear of the barrel with
 * daylight underneath it. That gap is the tell — it is why an AK's front end
 * reads as a skeleton and an AR's reads as a tube.
 *
 * Built as four pieces so the daylight survives: a pedestal block, two ears, and
 * the post between them. A single box would fill the gap and lose the read.
 */
function akFrontTower(body, spec, M) {
  const y0 = spec.bore + spec.rBarrel;
  const z = spec.zBarrelEnd + 0.026;

  // Pedestal: the barrel band the tower is pinned to, waisted at the top.
  const base = latheZ(
    [
      [0, spec.rBarrel * 0.4],
      [0, spec.rBarrel + 0.0022],
      [0.0092, spec.rBarrel + 0.0026],
      [0.0132, spec.rBarrel * 0.86],
    ],
    12,
  );
  put(body, base, M.steel, { y: spec.bore, z: z + 0.0066 });

  // The stalk. Narrow, so the two ears above it read as separate objects.
  const stalk = box(0.0092, 0.0132, 0.0112, 0.0009, 1);
  put(body, stalk, M.steel, { y: y0 + 0.0062, z });

  // Protective ears, one either side, with the post standing between them.
  const ear = box(0.0026, 0.0142, 0.0104, 0.0006, 1);
  putBoth(body, ear, M.steel, { x: 0.0052, y: y0 + 0.0182, z });

  const post = rodZ(0.0011, 0.0011, 0.0132, 8, 0.0003);
  post.rotateX(Math.PI / 2);
  put(body, post, M.bright, { y: y0 + 0.0176, z });

  // Sling loop under the tower, on the left — an AK carries from the front.
  const loop = ring(0.0052, 0.0011, 10, 5);
  put(body, loop, M.bright, { x: -0.0092, y: spec.bore - spec.rBarrel - 0.002, z: z + 0.008, ry: Math.PI / 2 });
}

/**
 * THE SLANTED GAS BLOCK.
 *
 * An AK's gas block is cut at about 45 degrees to the bore and carries the front
 * sling swivel and the cleaning-rod channel. The angle is the point: every other
 * weapon in the roster has a square or cylindrical block, so a diagonal in the
 * profile belongs to exactly one family.
 */
function akGasBlock(body, spec, M) {
  const z = spec.gasAt;
  const y = spec.bore;

  const band = latheZ(
    [
      [0, spec.rBarrel * 0.5],
      [0, spec.rBarrel + 0.0024],
      [0.0186, spec.rBarrel + 0.0028],
      [0.0224, spec.rBarrel * 0.9],
    ],
    12,
  );
  put(body, band, M.soot, { y, z: z + 0.0112 });

  // The slanted riser that takes gas up into the tube. Rotated about X so the
  // face runs diagonally in the profile view, which is the whole cue.
  const riser = box(0.0132, 0.0242, 0.0142, 0.0011, 1);
  put(body, riser, M.soot, { y: y + spec.rBarrel + 0.0086, z: z + 0.0026, rx: -0.72 });

  // Cleaning-rod channel below the barrel: a slim tube that runs most of the
  // exposed barrel length and reads as a second line under the first.
  // Blued, not bright: `steel_bright` is 0xb9c0c8, and at the viewmodel's
  // exposure a chrome rod 400 mm long becomes the brightest object on the weapon
  // and steals the whole front end.
  const rod = rodZ(0.0021, 0.0021, Math.abs(spec.zBarrelEnd - spec.hgZ1) + 0.012, 8, 0.0004);
  put(body, rod, M.steel, {
    y: spec.bore - spec.rBarrel - 0.0038,
    z: (spec.zBarrelEnd + spec.hgZ1) / 2,
  });
}

/**
 * The АКМ slant compensator: a can with its muzzle face cut off at an angle and
 * a single expansion port on the right. `addMuzzleDevice('brake')` builds a
 * symmetric brake, so the asymmetry — which is the recognisable part — is added
 * here rather than by making the shared part lopsided for everyone.
 */
function slantBrake(body, spec, M) {
  const L = layoutOf(spec);
  const z = L.muzzleZ + 0.018;
  const wedge = box(0.0212, 0.0212, 0.0092, 0.001, 1);
  put(body, wedge, M.soot, { y: spec.bore, z: z - 0.0132, rx: 0.42 });
  const port = box(0.0062, 0.0132, 0.0132, 0.0008, 1);
  put(body, port, M.cavity, { x: 0.0082, y: spec.bore + 0.0026, z });
}

/**
 * The safety/selector lever: a long stamped paddle on the RIGHT of the receiver
 * that sweeps from above the trigger up past the ejection port. Nothing else in
 * the roster has a control that big or that visible, and on the real weapon its
 * two positions are the loudest mechanical statement the gun makes.
 */
function akSafetyLever(body, spec, M) {
  const x = spec.rUpper + 0.0026;
  const z = spec.portZ + 0.026;
  const y = spec.bore - 0.0092;

  // Parkerised sheet, not brushed billet: at the board's light a 62 mm plate of
  // `steel` was a bright slab across the middle of the receiver, which is where
  // the eye lands. `soot` is the bank's dark ferrous finish.
  const paddle = box(0.0034, 0.0104, 0.062, 0.0009, 2);
  put(body, paddle, M.soot, { x, y, z, rx: -0.24 });
  // The thumb tab, bent outboard at the rear.
  const tab = box(0.0062, 0.0096, 0.0142, 0.0011, 1);
  put(body, tab, M.soot, { x: x + 0.0021, y: y - 0.0062, z: z + 0.031, ry: 0.2 });
  // Detent stops, stamped into the receiver wall above it.
  const stop = box(0.0022, 0.0038, 0.0058, 0.0005, 1);
  put(body, stop, M.soot, { x: x - 0.0008, y: y + 0.0132, z: z - 0.0212 });
  put(body, stop.clone?.() ?? box(0.0022, 0.0038, 0.0058, 0.0005, 1), M.soot, {
    x: x - 0.0008,
    y: y + 0.0132,
    z: z + 0.0132,
  });
}

/**
 * Receiver rivets. Small individually and decisive together: an AK receiver is
 * STAMPED and riveted, an AR's is machined and pinned, and a row of six domed
 * heads down the flank is the difference between the two surfaces reading as
 * pressed sheet or as billet.
 */
function akRivets(body, spec, M) {
  const x = spec.rUpper - 0.0006;
  const zs = [0.086, 0.042, -0.012, -0.068, -0.112, -0.142];
  for (const z of zs) {
    const head = dome(0.0021, 8);
    putBoth(body, head, M.bright, { x, y: spec.bore - 0.0112, z: z * (spec.rUpper / 0.0198), rz: Math.PI / 2, ry: Math.PI / 2 });
  }
  // The magwell's front and rear lips, pressed rather than machined: a shallow
  // flare either end of the well.
  const lip = box(spec.mag.w + 0.0092, 0.0052, 0.0034, 0.0007, 1);
  put(body, lip, M.steel, { y: spec.bore - 0.0162, z: spec.magZ - spec.mag.d / 2 - 0.001 });
  put(body, box(spec.mag.w + 0.0092, 0.0052, 0.0034, 0.0007, 1), M.steel, {
    y: spec.bore - 0.0162,
    z: spec.magZ + spec.mag.d / 2 + 0.001,
  });
}

/**
 * The paddle magazine catch, immediately behind the well. An AK's is a lever you
 * push forward with the magazine itself; an AR's is a round button on the right.
 * Different verb, different shape, and it is right where the eye lands when the
 * magazine is the thing you are looking at.
 */
function akMagCatch(body, spec, M) {
  const z = spec.magZ + spec.mag.d / 2 + 0.0092;
  const y = spec.bore - 0.0242;
  const paddle = box(0.0112, 0.0182, 0.0072, 0.0011, 1);
  put(body, paddle, M.steel, { y, z, rx: 0.34 });
  const guard = box(0.0142, 0.0042, 0.0132, 0.0008, 1);
  put(body, guard, M.steel, { y: y - 0.0092, z: z + 0.0026 });
}

/* ========================================================================= */
/* ARMALITE                                                                  */
/* ========================================================================= */

/**
 * THE BUFFER TUBE AND ITS CASTLE NUT.
 *
 * An AR's stock is not a stock in the AK sense: it is a COLLAR sliding on a
 * round aluminium tube that continues the bore line straight back to the
 * shoulder. In profile that gives an unbroken horizontal cylinder from the
 * receiver to the buttplate, where an AK gives a wooden wedge angling down.
 * Those two lines are the fastest way to tell the families apart, and the
 * previous model drew a featureless slab for both.
 *
 * The castle nut and the end plate at the front of the tube are what stop the
 * cylinder reading as a rolled-up sock.
 */
function bufferTube(body, spec, M) {
  const y = spec.bore - 0.0062;
  const z0 = spec.zUpperRear + 0.004;
  const z1 = spec.stockRear - 0.008;
  const len = Math.abs(z1 - z0);

  const tube = tubeZ(0.0158, 0.0136, len, 18, 0.0006);
  put(body, tube, M.alu, { y, z: (z0 + z1) / 2 });

  // End plate + castle nut: two annuli of different diameter at the receiver end.
  const plate = latheZ(
    [
      [0, 0.0136],
      [0, 0.0192],
      [0.0026, 0.0192],
      [0.0026, 0.0136],
    ],
    16,
  );
  put(body, plate, M.steel, { y, z: z0 + 0.0018 });
  const nut = knurlBand(0.0176, 0.0092, 22, 0.0005, 3);
  put(body, nut, M.bright, { y, z: z0 + 0.0086 });

  // The seven adjustment detents along the underside of the tube.
  for (let i = 0; i < 6; i++) {
    const notch = box(0.0058, 0.0026, 0.0038, 0.0004, 1);
    put(body, notch, M.cavity, { y: y - 0.0146, z: z0 + 0.028 + i * 0.0182 });
  }
}

/**
 * The sliding stock body: a polymer collar around the tube with a cheek plate,
 * a sling loop and a release lever underneath. Hollow-sided, because an AR stock
 * you can see daylight through is the difference between this and a brick.
 */
function arStock(body, spec, M) {
  const y = spec.bore - 0.0062;
  const zMid = spec.stockRear - 0.052;

  /**
   * SKELETON, NOT A BLOCK.
   *
   * The first version built two full-height side walls, a comb and a belly that
   * all overlapped in profile, so the result was a solid rectangle and the buffer
   * tube inside it was never seen — which threw away the exact cue that separates
   * an AR stock from an AK's wooden wedge.
   *
   * So: the comb spans the top, a short collar wraps the tube at the FRONT only,
   * and the belly rail runs along the bottom REAR. Between the comb and the rail
   * there is a real window, and the round tube shows through it. That window is
   * the shape people recognise.
   */
  const comb = box(0.0392, 0.0112, 0.102, 0.0026, 2);
  put(body, comb, M.poly, { y: y + 0.0172, z: zMid - 0.006, rx: -0.02 });
  // Front collar: the part that actually clamps the tube, 26 mm long.
  const collar = box(0.0402, 0.0442, 0.026, 0.0026, 2);
  put(body, collar, M.poly, { y: y - 0.0032, z: zMid - 0.048 });
  // Bottom rail, rear half only — this is where the sling loop and the lever go.
  const rail = box(0.0342, 0.0102, 0.072, 0.0022, 2);
  put(body, rail, M.poly, { y: y - 0.0262, z: zMid + 0.016 });
  // Thin webs tying the comb to the rail at the rear, leaving the window open.
  const web = box(0.0034, 0.0342, 0.0182, 0.0011, 1);
  putBoth(body, web, M.poly, { x: 0.0182, y: y - 0.0062, z: zMid + 0.038 });

  // Buttplate with a rubber pad, angled the way a shouldered stock actually is.
  const plate = box(0.0402, 0.0492, 0.0112, 0.0032, 2);
  put(body, plate, M.poly, { y: y - 0.0042, z: spec.stockRear - 0.004, rx: 0.05 });
  const pad = box(0.0412, 0.0502, 0.0072, 0.0036, 2);
  put(body, pad, M.rubber, { y: y - 0.0042, z: spec.stockRear + 0.004, rx: 0.05 });

  // Release lever under the collar, and the QD sling socket on the left.
  const lever = box(0.0132, 0.0112, 0.0242, 0.0016, 1);
  put(body, lever, M.poly, { y: y - 0.0322, z: zMid + 0.0182, rx: -0.16 });
  const socket = latheZ(
    [
      [0, 0],
      [0, 0.0062],
      [0.0038, 0.0062],
      [0.0038, 0.0022],
    ],
    12,
  );
  put(body, socket, M.bright, { x: -0.0212, y: y - 0.0062, z: zMid - 0.022, ry: Math.PI / 2 });
}

/**
 * Forward assist and the dust-cover door: the two bumps on the right rear of an
 * AR upper. Nothing else in the roster has either, and they sit exactly where
 * the eye rests when the weapon is shouldered.
 */
function arUpperFurniture(body, spec, M) {
  const x = spec.rUpper - 0.0022;
  const yTop = spec.bore + spec.rUpper * 0.62;

  // Forward assist: a teardrop boss with a serrated pawl.
  const boss = latheZ(
    [
      [0, 0.0062],
      [0.0086, 0.0086],
      [0.0182, 0.0072],
      [0.0182, 0],
    ],
    12,
  );
  put(body, boss, M.alu, { x: x - 0.0018, y: yTop, z: spec.zUpperRear - 0.03, ry: 0.0, rx: 0.0 });
  const pawl = serrations(0.0092, 0.0058, 0.0086, 4, 0.0004, 'y');
  put(body, pawl, M.soot, { x: x - 0.0018, y: yTop + 0.0072, z: spec.zUpperRear - 0.024 });

  // Ejection-port door: a rectangular panel on a hinge pin, sprung shut.
  const door = box(0.0028, 0.0182, 0.0392, 0.0007, 1);
  put(body, door, M.alu, { x: x + 0.0016, y: spec.bore + 0.0042, z: spec.portZ });
  const hinge = rodZ(0.0013, 0.0013, 0.0432, 8, 0.0003);
  put(body, hinge, M.bright, { x: x + 0.0016, y: spec.bore - 0.0062, z: spec.portZ });
  const detent = box(0.0034, 0.0038, 0.0058, 0.0005, 1);
  put(body, detent, M.bright, { x: x + 0.0018, y: spec.bore + 0.0132, z: spec.portZ - 0.0212 });
}

/**
 * The magwell fence: a raised, flared collar around the magazine opening.
 * An AK's well is a plain pressed hole; an AR's is a machined trumpet. In
 * profile it is the difference between the magazine looking inserted and looking
 * bolted on.
 */
function magwellFence(body, spec, M) {
  const y = spec.bore - 0.0192;
  const flare = extrude(roundRect(spec.mag.w + 0.0112, spec.mag.d + 0.0132, 0.0042, 4), 0.0132, {
    bevel: 0.0011,
  });
  flare.rotateX(Math.PI / 2);
  put(body, flare, M.alu, { y, z: spec.magZ, rx: spec.magTilt });
  // Trigger-guard bow, integral to the lower on an AR.
  const bow = extrude(
    [
      [-0.0018, 0],
      [0.0018, 0],
      [0.0018, 0.0212],
      [-0.0018, 0.0212],
    ],
    0.0392,
    { bevel: 0.0006 },
  );
  bow.rotateY(Math.PI / 2);
  put(body, bow, M.alu, { y: spec.bore - 0.0482, z: spec.gripZ - 0.026 });
}

/**
 * The A2 birdcage: five slots cut into a stepped can with a solid bottom, so it
 * does not kick dust up off the prone. Reads as a cage rather than a cylinder,
 * which is the difference from the АКМ's solid slant cut 60 mm away.
 */
function birdcage(body, spec, M) {
  const L = layoutOf(spec);
  const z = L.muzzleZ + 0.026;
  for (let i = 0; i < 5; i++) {
    // Top and upper flanks only: the bottom third stays closed.
    const a = -Math.PI * 0.62 + (i / 4) * Math.PI * 1.24;
    const slot = box(0.0038, 0.0072, 0.0182, 0.0005, 1);
    put(body, slot, M.cavity, {
      x: Math.sin(a) * 0.0112,
      y: spec.bore + Math.cos(a) * 0.0112,
      z,
      rz: a,
    });
  }
  const shoulder = latheZ(
    [
      [0, spec.rBarrel],
      [0, 0.0132],
      [0.0058, 0.0132],
      [0.0058, spec.rBarrel + 0.0011],
    ],
    14,
  );
  put(body, shoulder, M.soot, { y: spec.bore, z: L.muzzleZ + 0.048 });
}

/**
 * Low-profile gas block: a small square block UNDER the handguard, invisible
 * except as a bump in the rail's underside — which is precisely the point. An AK
 * wears its gas system on the outside; an AR hides it. Building both makes the
 * contrast explicit instead of leaving the AR's front end simply empty.
 */
function lowProfileGasBlock(body, spec, M) {
  const blk = box(0.0182, 0.0162, 0.0242, 0.0011, 1);
  put(body, blk, M.soot, { y: spec.bore - 0.0016, z: spec.gasAt });
  const tube = rodZ(0.0022, 0.0022, Math.abs(spec.gasAt - spec.zUpperFront) + 0.008, 8, 0.0004);
  put(body, tube, M.bright, {
    y: spec.bore + spec.rBarrel + 0.0042,
    z: (spec.gasAt + spec.zUpperFront) / 2,
  });
}

/* ========================================================================= */
/* SCAR                                                                      */
/* ========================================================================= */

/**
 * The monolithic upper: one extrusion carrying the rail from the charging handle
 * all the way to the gas block, with the barrel trunnion INSIDE it. On an AR the
 * rail stops at the receiver and restarts on the handguard; on a SCAR it never
 * stops. A continuous top line over 330 mm is the family's whole silhouette.
 */
function monolithicRail(body, spec, M) {
  const L = layoutOf(spec);
  const shell = box(spec.rUpper * 1.9, spec.rUpper * 1.5, Math.abs(spec.zUpperRear - spec.hgZ1) * 0.62, 0.0026, 2);
  put(body, shell, M.alu, {
    y: spec.bore + 0.0026,
    z: (spec.zUpperRear + spec.hgZ1) / 2 + 0.03,
  });
  // Cooling slots down both flanks — the SCAR's other loud cue.
  for (let i = 0; i < 5; i++) {
    const slot = box(0.0026, 0.0132, 0.0212, 0.0005, 1);
    putBoth(body, slot, M.cavity, {
      x: spec.rUpper * 0.94,
      y: spec.bore + 0.0026,
      z: spec.zUpperFront - 0.012 - i * 0.0292,
    });
  }
}

/** The non-reciprocating side charging handle: a folded lever on the LEFT. */
function sideCharging(body, spec, M) {
  const x = -spec.rUpper - 0.0062;
  const z = spec.zUpperFront + 0.052;
  const arm = box(0.0142, 0.0072, 0.0212, 0.0011, 1);
  put(body, arm, M.alu, { x: x + 0.0042, y: spec.bore + spec.rUpper * 0.5, z });
  const knob = box(0.0086, 0.0132, 0.0182, 0.0018, 2);
  put(body, knob, M.poly, { x, y: spec.bore + spec.rUpper * 0.5, z: z - 0.004, ry: -0.12 });
  const slot = box(0.0038, 0.0038, 0.086, 0.0006, 1);
  put(body, slot, M.cavity, { x: x + 0.0086, y: spec.bore + spec.rUpper * 0.5, z: z + 0.03 });
}

/** The truss cut through the SCAR's polymer lower, ahead of the trigger. */
function scarTruss(body, spec, M) {
  const y = spec.bore - 0.0342;
  for (let i = 0; i < 2; i++) {
    const cut = box(0.0038, 0.0132, 0.0242, 0.0007, 1);
    putBoth(body, cut, M.cavity, { x: spec.rUpper * 0.72, y, z: spec.zUpperFront + 0.062 + i * 0.034 });
  }
}

/* ========================================================================= */
/* DRAGUNOV                                                                  */
/* ========================================================================= */

/**
 * The vented wooden handguards: two shells either side of the barrel with three
 * long louvres each. The SVD's front end is the only one in the roster that is
 * SPLIT down the middle with the barrel showing between the halves.
 */
function svdVentedHandguard(body, spec, M) {
  const len = Math.abs(spec.hgZ1 - spec.hgZ0);
  const zMid = (spec.hgZ0 + spec.hgZ1) / 2;
  const shell = box(0.0112, 0.0342, len * 0.94, 0.0026, 2);
  putBoth(body, shell, M.wood, { x: spec.hgR * 0.72, y: spec.bore - 0.0026, z: zMid });
  for (let i = 0; i < 3; i++) {
    const louvre = box(0.0058, 0.0072, len * 0.24, 0.0008, 1);
    putBoth(body, louvre, M.cavity, {
      x: spec.hgR * 0.78,
      y: spec.bore - 0.0026,
      z: zMid - len * 0.28 + i * len * 0.28,
    });
  }
}

/** The long slotted flash hider, and the barrel step that carries it. */
function svdFlashHider(body, spec, M) {
  const L = layoutOf(spec);
  const can = tubeZ(0.0132, 0.0102, 0.042, 14, 0.0006);
  put(body, can, M.soot, { y: spec.bore, z: L.muzzleZ + 0.022 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 8;
    const slot = box(0.0034, 0.0058, 0.0262, 0.0005, 1);
    put(body, slot, M.cavity, {
      x: Math.sin(a) * 0.0122,
      y: spec.bore + Math.cos(a) * 0.0122,
      z: L.muzzleZ + 0.022,
      rz: a,
    });
  }
}

/* ========================================================================= */
/* MP5                                                                       */
/* ========================================================================= */

/**
 * THE COCKING TUBE.
 *
 * The single most recognisable feature of the family, and it was absent. The MP5
 * carries a separate tube welded to the LEFT of the barrel jacket, running from
 * the receiver forward past the handguard, with the charging handle at its far
 * end and a notch at the top rear the handle locks into. In profile it doubles
 * the front end's top line, which no other weapon here does.
 */
function mp5CockingTube(body, spec, M) {
  const x = -spec.rUpper * 0.72;
  const y = spec.bore + spec.rUpper * 0.52;
  const z0 = spec.zUpperFront + 0.012;
  const z1 = spec.hgZ1 - 0.008;

  const tube = tubeZ(0.0092, 0.0072, Math.abs(z1 - z0), 14, 0.0005);
  put(body, tube, M.steel, { x, y, z: (z0 + z1) / 2 });
  // The locking notch, cut into the top rear of the tube.
  const notch = box(0.0062, 0.0058, 0.0132, 0.0006, 1);
  put(body, notch, M.cavity, { x, y: y + 0.0072, z: z0 + 0.0132 });
  // Weld seam to the jacket.
  const seam = box(0.0058, 0.0026, Math.abs(z1 - z0) * 0.9, 0.0004, 1);
  put(body, seam, M.steel, { x: x * 0.52, y: y - 0.0026, z: (z0 + z1) / 2 });
}

/**
 * The famous slap handle is a MOVING part, not body geometry.
 *
 * It was built here first, statically, and that made it a handle welded to the
 * tube — you could not slap it. It now lives in `buildMovingParts` in build.js and
 * rides `chargeRest` / `chargePull` like every other charging handle, which is
 * also what lets the reload clips animate it.
 *
 * The feature string is kept so the spec still declares the mechanism, and so the
 * gate that pairs features against builders does not report it missing.
 */
function mp5Slap() {}

/**
 * The drum rear sight: a rotating cylinder with four apertures, standing on a
 * hooded bridge. An AR has a folding blade; this is a barrel-shaped lump, and it
 * sits far enough back that it is in frame in ADS.
 */
function mp5DrumSight(body, spec, M) {
  const L = layoutOf(spec);
  const z = spec.zUpperRear - 0.018;
  const drum = latheZ(
    [
      [0, 0],
      [0, 0.0092],
      [0.0132, 0.0092],
      [0.0132, 0],
    ],
    14,
  );
  drum.rotateY(Math.PI / 2);
  put(body, drum, M.soot, { y: L.railTop + 0.0092, z });
  // Four apertures around the drum's circumference.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const hole = rodZ(0.0011, 0.0011, 0.0142, 6, 0.0002);
    hole.rotateZ(Math.PI / 2);
    put(body, hole, M.cavity, {
      y: L.railTop + 0.0092 + Math.cos(a) * 0.0062,
      z: z + Math.sin(a) * 0.0062,
    });
  }
  // Hooded bridge either side.
  const ear = box(0.0026, 0.0182, 0.0162, 0.0006, 1);
  putBoth(body, ear, M.soot, { x: 0.0082, y: L.railTop + 0.0092, z });
}

/** The paddle magazine release behind the well — an HK verb, not an AR button. */
function paddleRelease(body, spec, M) {
  const z = spec.magZ + spec.mag.d / 2 + 0.0086;
  const y = spec.bore - 0.0262;
  const paddle = box(0.0182, 0.0162, 0.0062, 0.0011, 1);
  put(body, paddle, M.steel, { y, z, rx: 0.28 });
}

/** The three-lug barrel collar: a stub with three radial lugs at the muzzle. */
function triLugBarrel(body, spec, M) {
  const L = layoutOf(spec);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const lug = box(0.0058, 0.0058, 0.0112, 0.0007, 1);
    put(body, lug, M.steel, {
      x: Math.sin(a) * 0.0092,
      y: spec.bore + Math.cos(a) * 0.0092,
      z: L.muzzleZ + 0.026,
      rz: a,
    });
  }
}

/* ========================================================================= */
/* PUMP SHOTGUN                                                              */
/* ========================================================================= */

/** Corncob ribs on the forend: the texture that says "pump" from any distance. */
function forendRibs(body, spec, M) {
  const len = Math.abs(spec.hgZ1 - spec.hgZ0);
  const n = Math.max(5, Math.round(len / 0.0132));
  for (let i = 0; i < n; i++) {
    const rib = ring(spec.hgR + 0.0016, 0.0021, 14, 5);
    rib.rotateY(Math.PI / 2);
    put(body, rib, M.wood, {
      y: spec.bore - spec.tubeMag.drop * 0.5,
      z: spec.hgZ0 - 0.004 - i * (len / n),
    });
  }
}

/** The side saddle: four spare shells in loops on the left of the receiver. */
function shellCarrier(body, spec, M) {
  const x = -spec.rUpper - 0.0062;
  for (let i = 0; i < 4; i++) {
    const shell = rodZ(spec.shell.rimR * 0.92, spec.shell.rimR * 0.92, 0.052, 10, 0.0004);
    shell.rotateY(Math.PI / 2);
    put(body, shell, M.rubber, { x, y: spec.bore - 0.0132, z: spec.zUpperRear - 0.024 - i * 0.0182 });
    const band = ring(spec.shell.rimR + 0.0011, 0.0013, 10, 4);
    put(body, band, M.bright, { x, y: spec.bore - 0.0132, z: spec.zUpperRear - 0.024 - i * 0.0182 });
  }
  const plate = box(0.0034, 0.0292, 0.086, 0.0008, 1);
  put(body, plate, M.steel, { x: x + 0.0038, y: spec.bore - 0.0132, z: spec.zUpperRear - 0.052 });
}

/* ========================================================================= */
/* PISTOLS                                                                   */
/* ========================================================================= */

/** Glock finger grooves and the checkered grip panels either side. */
function fingerGrooves(body, spec, M) {
  const y0 = spec.bore - 0.052;
  for (let i = 0; i < 3; i++) {
    const groove = ring(0.0162, 0.0018, 12, 4, Math.PI);
    groove.rotateY(Math.PI / 2);
    put(body, groove, M.cavity, { y: y0 - i * 0.0182, z: spec.gripZ - 0.0132, rz: -spec.gripAngle });
  }
  const panel = serrations(0.0026, 0.052, 0.0212, 7, 0.00035, 'y');
  putBoth(body, panel, M.poly, { x: 0.0162, y: y0 - 0.0182, z: spec.gripZ, rx: -spec.gripAngle * 0.5 });
}

/** The squared trigger guard — a Glock corner where a revolver has a curve. */
function squareTriggerGuard(body, spec, M) {
  const front = box(0.0132, 0.0038, 0.0058, 0.0007, 1);
  put(body, front, M.poly, { y: spec.bore - 0.0392, z: spec.gripZ - 0.0342 });
  const bow = box(0.0132, 0.0038, 0.0262, 0.0007, 1);
  put(body, bow, M.poly, { y: spec.bore - 0.0412, z: spec.gripZ - 0.0212 });
}

/** The slide backplate and striker-status pin at the rear of a Glock slide. */
function glockBackplate(body, spec, M) {
  const z = spec.zUpperRear + 0.0032;
  const plate = box(spec.slide.w * 0.94, spec.slide.h * 0.86, 0.0034, 0.0007, 1);
  put(body, plate, M.soot, { y: spec.bore + 0.0058, z });
  const pin = rodZ(0.0016, 0.0016, 0.0058, 8, 0.0003);
  put(body, pin, M.bright, { y: spec.bore + 0.0058, z: z + 0.0012 });
}

/** The Desert Eagle's ventilated rib: a raised strip with six slots. */
function deagleRib(body, spec, M) {
  const yTop = spec.bore + spec.slide.h * 0.5 + 0.0021;
  const rib = box(0.0132, 0.0042, Math.abs(spec.zBarrelEnd - spec.zUpperRear) * 0.72, 0.0006, 1);
  put(body, rib, M.steel, { y: yTop, z: (spec.zBarrelEnd + spec.zUpperRear) / 2 - 0.008 });
  for (let i = 0; i < 6; i++) {
    const slot = box(0.0086, 0.0026, 0.0072, 0.0004, 1);
    put(body, slot, M.cavity, { y: yTop + 0.0011, z: spec.zUpperFront + 0.026 + i * 0.0162 });
  }
}

/** The Deagle's very wide backstrap and its rubber wrap-around grip. */
function wideBackstrap(body, spec, M) {
  const y = spec.bore - 0.062;
  const strap = box(0.0362, 0.078, 0.0132, 0.0032, 2);
  put(body, strap, M.rubber, { y, z: spec.gripZ + 0.0212, rx: -spec.gripAngle * 0.5 });
  const panel = serrations(0.0032, 0.062, 0.0262, 8, 0.0004, 'y');
  putBoth(body, panel, M.rubber, { x: 0.0182, y, z: spec.gripZ, rx: -spec.gripAngle * 0.5 });
}

/* ========================================================================= */

/**
 * Every signature feature, keyed by the string that appears in `spec.features`.
 *
 * A table rather than a chain of `if`s so that the gate can assert the two
 * agree: a feature declared in specs.js with no entry here is a promise the
 * model does not keep, which is exactly the class of defect this file was
 * written to close.
 */
export const SIGNATURE_FEATURES = {
  akFrontTower,
  akGasBlock,
  slantBrake,
  akSafetyLever,
  akRivets,
  akMagCatch,
  bufferTube,
  arStock,
  forwardAssist: arUpperFurniture,
  dustCoverDoor: () => {}, // built by arUpperFurniture, declared for readability
  magwellFence,
  birdcage,
  lowProfileGasBlock,
  monolithicRail,
  sideCharging,
  scarTruss,
  svdVentedHandguard,
  svdFlashHider,
  mp5CockingTube,
  mp5Slap,
  mp5DrumSight,
  paddleRelease,
  triLugBarrel,
  forendRibs,
  shellCarrier,
  fingerGrooves,
  squareTriggerGuard,
  glockBackplate,
  deagleRib,
  wideBackstrap,
};

/**
 * Build every signature feature this spec declares.
 *
 * Order is the declaration order in the spec, which keeps the diff between "what
 * the weapon says it is" and "what got built" readable in one place.
 *
 * @param {import('../../weapons/geometry.js').Assembly} body
 * @param {object} spec
 * @param {Record<string,string>} M material keys, as build.js defines them
 */
export function addSignature(body, spec, M) {
  let built = 0;
  for (const f of spec.features) {
    const fn = SIGNATURE_FEATURES[f];
    if (!fn) continue;
    fn(body, spec, M);
    built++;
  }
  return built;
}
