import { Assembly, box, blob, dome, extrude, roundRect, latheZ, rodZ, tubeZ, knurlBand } from '../../weapons/geometry.js';
import {
  addBarrel,
  addGasBlock,
  addMuzzleDevice,
  addHandguard,
  addUpperReceiver,
  addLowerReceiver,
  addBoltCarrier,
  addRail,
  addPistolGrip,
  addCarbineStock,
  addFrontSight,
  addRearSight,
  addRollmark,
  addQdSocket,
  addSlingLoop,
  addPin,
  addScrew,
  buildMagazine,
  buildOptic,
  buildMiniReflex,
  buildSlide,
  chargingHandlePart,
  selectorPart,
  triggerPart,
  cartridge,
} from '../../weapons/parts.js';
import { specFor, nodesOf, layoutOf, validateSpec, MOVING_PARTS } from './specs.js';
import { addSpecDetail, LOD_FULL } from './detail.js';
import { addSignature } from './signature.js';

/**
 * ARSENAL — the model builder.
 *
 * One function builds all nine weapons from the specs in specs.js, using the
 * same parts kit and the same call order as the reference M4A1 in
 * src/weapons/models/rifle.js. That reference is the fidelity floor: chamfered
 * receivers, a real bore cavity, pinned takedowns, knurled nuts, engraved
 * rollmarks, a hollow magwell, and glass with a measured aperture.
 *
 * Why a builder instead of nine files: the detail work in rifle.js is about 300
 * lines of solved millimetres. Copied nine times, every future fix has to be
 * made nine times, and the AKM quietly ends up with less care than the M416.
 * Here the care lives once and the differences are declared as data.
 *
 * What each pattern actually changes — these are architectures, not skins:
 *   'ar'     split upper/lower, receiver-extension stock, AR magwell, flat top
 *   'ak'     riveted trunnion receiver, dust cover, gas tube ABOVE the barrel,
 *            left-side optic rail, no flat top at all
 *   'battle' monolithic SCAR upper, side-folding stock, ambidextrous handle
 *   'dmr'    long barrel, wood furniture, thumbhole stock, cheek rest, side mount
 *   'smg'    tubular receiver, wrap-around handguard, collapsing wire stock
 *   'pump'   tube magazine under the barrel, sliding forend on action bars,
 *            vented rib and a bead — no detachable magazine, no bolt handle
 *   'pistol' slide on a frame, no stock, no handguard, mini reflex mount
 */

/** Material keys, from src/weapons/materials.js. */
const M = {
  alu: 'alu',
  aluFine: 'alu_fine',
  steel: 'steel',
  bright: 'steel_bright',
  soot: 'steel_soot',
  cavity: 'cavity',
  poly: 'polymer',
  polyTan: 'polymer_tan',
  rubber: 'rubber',
  brass: 'brass',
  wood: 'wood',
  woodDark: 'wood_dark',
};

/**
 * Furniture material for a spec.
 *
 * This function used to map `woodFurniture` onto `M.rubber`, i.e. onto the
 * DARKEST material in the bank — a near-black overmould at 0.0049 linear. An
 * АКМ's wood therefore rendered as exactly the same black as an M416's polymer,
 * which threw away one of the two loudest identity cues a Kalashnikov has. The
 * comment above it even said "wood-furniture guns read warm, not black", which
 * is what the code was preventing.
 *
 * There are real wood materials now (weapons/materials.js), so the mapping says
 * what it means. The SVD and the M870 take the darker, redder timber so a
 * Dragunov beside a Kalashnikov is two different pieces of wood rather than two
 * copies of one prop.
 */
function furnitureMat(spec) {
  if (spec.features.includes('woodFurniture')) {
    return spec.pattern === 'dmr' || spec.pattern === 'pump' ? M.woodDark : M.wood;
  }
  return M.poly;
}

/* ------------------------------------------------------------------ receiver */

function buildReceiver(body, spec) {
  const L = layoutOf(spec);

  addUpperReceiver(body, M.alu, M.steel, M.cavity, {
    zRear: spec.zUpperRear,
    zFront: spec.zUpperFront,
    bore: spec.bore,
    r: spec.rUpper,
    portZ: spec.portZ,
    // Not optional: addUpperReceiver machines the flat-top rail at this height,
    // and with it missing the rail's Y went undefined -> NaN -> a poisoned
    // bounding sphere for the whole merged body. Same value the handguard rail
    // below is placed with, so the two are guaranteed coplanar.
    railTop: L.railTop,
    /**
     * A stamped Kalashnikov receiver has NO flat top. It has a hinged dust cover,
     * which is why AK optics mount on a side rail — and which the block below
     * builds. Leaving the shared builder to machine a Picatinny deck as well put
     * a nine-slot rail underneath that dust cover: two mutually exclusive
     * receiver tops in the same 20 mm, with the brighter one winning the frame.
     * That rail was one of the reasons the АКМ read as an AR wearing wood.
     */
    rail: !(spec.pattern === 'ak' || spec.pattern === 'dmr'),
  });

  addLowerReceiver(body, M.alu, M.steel, {
    bore: spec.bore,
    zRear: spec.zUpperRear,
    zFront: spec.zUpperFront,
    magZ: spec.magZ ?? spec.zUpperFront + 0.02,
    magW: spec.mag.w + 0.0038,
    magD: spec.mag.d + 0.0052,
    magTilt: spec.magTilt,
    // `gripAngle` and `triggerZ` are the only two options addLowerReceiver reads
    // without a `??` default, so omitting them did not fall back — it put
    // undefined straight into a rotation (`rx: -o.gripAngle * 0.5`). One NaN in a
    // rotation matrix corrupts every axis of the transform, which is why the
    // error pointed at X on a value that only looks like it affects pitch.
    gripAngle: spec.gripAngle,
    // The trigger sits 27 mm forward of grip centre (-Z is forward). That is the
    // same offset the hand-built reference in weapons/models/rifle.js uses:
    // its grip is at 0.015 and its trigger at -0.012.
    triggerZ: spec.gripZ - 0.027,
  });

  // Takedown and pivot pins, plus the two receiver screws. Small, but they are
  // what stops a receiver reading as an extruded block in ADS.
  addPin(body, M.bright, 0, spec.bore - 0.016, spec.zUpperRear - 0.012);
  addPin(body, M.bright, 0, spec.bore - 0.016, spec.zUpperFront + 0.014);
  addScrew(body, M.bright, spec.rUpper * 0.7, spec.bore - 0.006, spec.gripZ + 0.03, 0.0021, 'x');

  for (const r of spec.rollmarks) {
    addRollmark(body, M.soot, {
      x: r.x,
      y: r.y,
      z: r.z,
      h: r.h,
      pattern: r.pattern,
      axis: 'x',
    });
  }

  if (spec.pattern === 'ak' || spec.pattern === 'dmr') {
    // Dust cover: a pressed steel lid with two stiffening ribs, sitting on top
    // of the receiver where an AR would have its rail.
    const cover = latheZ(
      [
        [0, spec.rUpper * 0.5],
        [0, spec.rUpper + 0.001],
        [0.004, spec.rUpper + 0.0016],
        [L.receiverLen - 0.01, spec.rUpper + 0.0016],
        [L.receiverLen - 0.006, spec.rUpper * 0.6],
      ],
      14
    );
    body.add(cover, M.steel, { y: spec.bore, z: spec.zUpperFront + 0.004 });
    cover.dispose();
    for (let i = 0; i < 2; i++) {
      const rib = box(0.0032, 0.0022, L.receiverLen - 0.02, 0.0005, 1);
      body.add(rib, M.steel, {
        x: (i ? 1 : -1) * spec.rUpper * 0.52,
        y: spec.bore + spec.rUpper * 0.86,
        z: (spec.zUpperRear + spec.zUpperFront) / 2,
      });
      rib.dispose();
    }
    // Side rail for the optic mount — the real AK optic interface.
    const rail = box(0.0092, 0.0182, 0.062, 0.0009, 2);
    body.add(rail, M.steel, {
      x: -spec.rUpper - 0.005,
      y: spec.bore + 0.014,
      z: spec.opticZ,
    });
    rail.dispose();
    addScrew(body, M.bright, -spec.rUpper - 0.009, spec.bore + 0.02, spec.opticZ + 0.022, 0.0024, 'x');
  } else if (spec.pattern !== 'pistol') {
    // Flat top: a real Picatinny deck the optic and the BUIS both sit on.
    addRail(body, M.aluFine, spec.zUpperRear - 0.004, spec.zUpperFront + 0.006, L.railTop, 0, {
      slots: 9,
    });
  }

  if (spec.pattern === 'smg') {
    // MP5 claw mount: two lugs over the tubular receiver.
    for (let i = 0; i < 2; i++) {
      const lug = box(0.0068, 0.011, 0.0132, 0.0008, 1);
      body.add(lug, M.steel, {
        x: (i ? 1 : -1) * (spec.rUpper - 0.001),
        y: spec.bore + spec.rUpper * 0.9,
        z: spec.opticZ + (i ? 0.024 : -0.024),
      });
      lug.dispose();
    }
  }
}

/* -------------------------------------------------------------------- barrel */

function buildBarrelGroup(body, spec) {
  const L = layoutOf(spec);

  addBarrel(body, M.steel, M.cavity, {
    y: spec.bore,
    zBreech: spec.zBreech,
    zMuzzle: spec.zBarrelEnd,
    rBarrel: spec.rBarrel,
    rChamber: spec.rChamber,
  });

  if (spec.gasAt !== null) {
    addGasBlock(body, M.soot, {
      y: spec.bore,
      z: spec.gasAt,
      rBarrel: spec.rBarrel,
      w: spec.pattern === 'ak' || spec.pattern === 'dmr' ? 0.024 : 0.021,
      h: 0.02,
      // Where the gas tube terminates. addGasBlock derives the tube's length from
      // `tubeTo - z` with no fallback, so omitting this made the length NaN and
      // poisoned the whole body buffer. The tube carries gas from the block back
      // to the receiver, so it ends at the front face of the upper — which is
      // behind the block, since -Z is forward.
      tubeTo: spec.zUpperFront,
    });
  }

  if (spec.pattern === 'ak' || spec.pattern === 'dmr') {
    // The gas tube: the single most recognisable line on an AK's silhouette.
    const tube = tubeZ(0.0082, 0.0064, Math.abs(spec.gasAt - spec.hgZ0) + 0.03, 14, 0.0004);
    body.add(tube, M.steel, {
      y: spec.bore + spec.rBarrel + 0.0112,
      z: (spec.gasAt + spec.hgZ0) / 2,
    });
    tube.dispose();
  }

  let crownZ = spec.zBarrelEnd;
  if (spec.muzzleKind !== 'none') {
    const dev = addMuzzleDevice(body, M.soot, M.cavity, spec.muzzleKind, spec.zBarrelEnd, spec.rBarrel, spec.bore);
    crownZ = dev?.crownZ ?? L.muzzleZ;
  }

  if (spec.tubeMag) {
    // Shotgun magazine tube plus its front cap, slung under the barrel.
    const t = spec.tubeMag;
    const tube = tubeZ(t.r, t.r - 0.0018, Math.abs(t.z1 - t.z0), 18, 0.0005);
    body.add(tube, M.steel, { y: spec.bore - t.drop, z: (t.z0 + t.z1) / 2 });
    tube.dispose();
    const cap = latheZ(
      [
        [0, 0],
        [0, t.r + 0.0012],
        [0.006, t.r + 0.0016],
        [0.014, t.r * 0.8],
      ],
      16
    );
    body.add(cap, M.steel, { y: spec.bore - t.drop, z: t.z1 - 0.014 });
    cap.dispose();
    const grip = knurlBand(t.r + 0.0018, 0.009, 26, 0.0004, 3);
    body.add(grip, M.steel, { y: spec.bore - t.drop, z: t.z1 - 0.006 });
    grip.dispose();
  }

  return crownZ;
}

/* ---------------------------------------------------------------- handguard */

function buildHandguardGroup(body, spec) {
  if (spec.hgR === null) return;
  const L = layoutOf(spec);

  addHandguard(body, spec.features.includes('railedHandguard') ? M.alu : furnitureMat(spec), {
    y: spec.bore,
    z0: spec.hgZ0,
    z1: spec.hgZ1,
    r: spec.hgR,
    sides: spec.hgSides,
    slats: spec.hgSides,
  });

  if (spec.hgSlots > 0) {
    // Top rail segment over the handguard: this is what a front-mounted optic or
    // a laser actually clamps to, so it has to be real geometry, not a decal.
    addRail(body, M.aluFine, spec.hgZ0 - 0.008, spec.hgZ1 + 0.01, L.railTop, 0, {
      slots: spec.hgSlots,
    });
  }

  if (spec.features.includes('slidingForend')) {
    // Action bars: two steel straps from the forend back into the receiver. They
    // are why a pump reads as a mechanism when it cycles.
    for (let i = 0; i < 2; i++) {
      const bar = box(0.0038, 0.0052, Math.abs(spec.hgZ0 - spec.zUpperFront) + 0.05, 0.0006, 1);
      body.add(bar, M.bright, {
        x: (i ? 1 : -1) * 0.0132,
        y: spec.bore - spec.tubeMag.drop - 0.004,
        z: (spec.hgZ0 + spec.zUpperFront) / 2 - 0.02,
      });
      bar.dispose();
    }
  }
}

/* -------------------------------------------------------- grip and shoulder */

/**
 * Magazine material.
 *
 * NOT the furniture material, which is what it used to be — that put a WOODEN
 * magazine on the АКМ the moment wood became a real material. Real magazines are
 * their own thing, and the differences are large and free:
 *
 *   АКМ      ribbed steel        cold and specular against warm wood
 *   АК-74    plum polymer        the single most recognisable colour in the roster
 *   M416     black polymer       matte, matches the receiver
 *   СВД/MP5  steel
 *
 * Three of the nine weapons therefore have a magazine of a visibly different
 * substance, which is one more free identity cue per weapon than a shared
 * `furnitureMat` could ever give.
 */
function magazineMat(spec) {
  if (spec.id === 'ak74') return M.polyTan;
  if (spec.id === 'akm' || spec.id === 'svd' || spec.id === 'mp5') return M.steel;
  return M.poly;
}

function buildGripAndStock(body, spec) {
  addPistolGrip(body, furnitureMat(spec), M.rubber, {
    len: spec.pattern === 'pistol' ? 0.116 : 0.108,
    w: spec.pattern === 'pistol' ? 0.0324 : 0.031,
    angle: spec.gripAngle,
    y: spec.bore - 0.03,
    z: spec.gripZ,
  });

  if (spec.stockRear === null) return;
  const len = spec.stockRear - spec.zUpperRear;

  if (spec.features.includes('thumbholeStock')) {
    /**
     * СВД: a skeletonised thumbhole stock.
     *
     * The previous version built two horizontal bars and a 90 mm butt block out
     * of `rubber`, which is to say: a black slab with a slot in it. What makes a
     * Dragunov stock recognisable is that it is a FRAME — the thumbhole is a hole
     * you can see the world through, the comb rises to meet the cheek, and the
     * whole thing is warm timber. So it is built as a closed loop of four
     * members with real daylight in the middle.
     */
    const zMid = (spec.stockRear + spec.zUpperRear) / 2;
    // Upper member: wrist to comb, rising toward the rear.
    const upper = box(0.026, 0.019, len * 0.96, 0.0026, 2);
    body.add(upper, M.woodDark, { y: spec.bore - 0.004, z: zMid, rx: -0.05 });
    upper.dispose();
    // Lower member: the pistol-grip strap under the thumbhole.
    const lower = box(0.024, 0.017, len * 0.74, 0.0026, 2);
    body.add(lower, M.woodDark, { y: spec.bore - 0.062, z: zMid + len * 0.1, rx: 0.06 });
    lower.dispose();
    // Rear post closing the loop.
    const post = box(0.026, 0.062, 0.021, 0.003, 2);
    body.add(post, M.woodDark, { y: spec.bore - 0.032, z: spec.stockRear - 0.026 });
    post.dispose();
    // Front post: the back of the pistol grip, which is what the thumb wraps.
    const front = box(0.024, 0.05, 0.019, 0.003, 2);
    body.add(front, M.woodDark, { y: spec.bore - 0.034, z: spec.zUpperRear + 0.024 });
    front.dispose();
    // Butt plate and its pad.
    const butt = box(0.028, 0.086, 0.014, 0.0035, 2);
    body.add(butt, M.woodDark, { y: spec.bore - 0.026, z: spec.stockRear - 0.006 });
    butt.dispose();
    const pad = box(0.03, 0.088, 0.011, 0.004, 2);
    body.add(pad, M.rubber, { y: spec.bore - 0.026, z: spec.stockRear + 0.005 });
    pad.dispose();
    if (spec.features.includes('cheekRest')) {
      // The detachable cheek piece: a wedge clamped to the upper member.
      const cheek = blob(0.028, 0.026, 0.082, 0.007, 3);
      body.add(cheek, M.woodDark, { y: spec.bore + 0.018, z: spec.stockRear - 0.062, rx: -0.06 });
      cheek.dispose();
      const strap = box(0.03, 0.005, 0.012, 0.0009, 1);
      body.add(strap, M.bright, { y: spec.bore + 0.004, z: spec.stockRear - 0.096 });
      strap.dispose();
    }
    return;
  }

  if (spec.features.includes('fixedStock')) {
    /**
     * AK: a one-piece wooden stock, and the shape is the whole point.
     *
     * The old version was `box(0.03, 0.058, len)` plus an 88 MM TALL butt pad,
     * which in profile is a rectangle with a taller rectangle stuck on the end —
     * measured on screen as a featureless slab occupying a quarter of the
     * weapon. A real AK stock TAPERS: it leaves the receiver deep, thins toward
     * the middle, and flares again at the toe, with the comb sloping down about
     * 5 degrees and the butt raked back. That silhouette is the reason a
     * Kalashnikov reads as a wedge and an AR reads as a tube.
     *
     * Built from three tapering segments plus the plate, because a single box
     * cannot taper and the taper is the identity.
     */
    const segs = 3;
    for (let i = 0; i < segs; i++) {
      const t = (i + 0.5) / segs;
      // Deep at the receiver (58 mm), waisted at 0.55, flaring to 66 mm at the toe.
      const h = 0.058 * (1 - t * 0.34) + 0.028 * t * t;
      const w = 0.031 * (1 - t * 0.1);
      const seg = box(w, h, (len / segs) * 1.06, 0.0035, 2);
      body.add(seg, furnitureMat(spec), {
        y: spec.bore - 0.022 - t * 0.014,
        z: spec.zUpperRear + len * ((i + 0.5) / segs),
        rx: -0.06,
      });
      seg.dispose();
    }
    // Sling slot through the stock: a real hole near the wrist, which is what
    // stops the taper reading as a solid wedge of nothing.
    const slot = box(0.034, 0.012, 0.026, 0.001, 1);
    body.add(slot, M.cavity, { y: spec.bore - 0.038, z: spec.zUpperRear + len * 0.3 });
    slot.dispose();
    // Steel butt plate with the trap door, not a rubber brick.
    const plate = box(0.032, 0.062, 0.008, 0.0022, 2);
    body.add(plate, M.steel, { y: spec.bore - 0.044, z: spec.stockRear - 0.002, rx: -0.06 });
    plate.dispose();
    const trap = box(0.02, 0.026, 0.003, 0.0007, 1);
    body.add(trap, M.soot, { y: spec.bore - 0.05, z: spec.stockRear + 0.003 });
    trap.dispose();
    return;
  }

  /**
   * A collapsing wire stock (MP5) is its own mechanism in detail.js, and an AR
   * buffer tube plus sliding collar is its own mechanism in signature.js. Either
   * one plus `addCarbineStock` would be two stocks occupying the same 170 mm.
   */
  const ownStock =
    spec.features.includes('collapsingStock') || spec.features.includes('bufferTube');
  if (!ownStock) {
    addCarbineStock(body, M.alu, furnitureMat(spec), M.rubber, {
      bore: spec.bore,
      zRear: spec.stockRear,
      zFront: spec.zUpperRear,
    });
  }

  if (spec.features.includes('foldingStock')) {
    // SCAR: the folding hinge, plus the latch it locks into.
    const hinge = latheZ(
      [
        [0, 0],
        [0, 0.0092],
        [0.016, 0.0092],
        [0.016, 0],
      ],
      14
    );
    body.add(hinge, M.alu, { x: 0.014, y: spec.bore - 0.012, z: spec.zUpperRear + 0.01, ry: Math.PI / 2 });
    hinge.dispose();
    addPin(body, M.bright, 0.014, spec.bore - 0.012, spec.zUpperRear + 0.01, 0.0026, 0.02);
  }
  if (spec.features.includes('adjustableCheek')) {
    const riser = box(0.028, 0.018, 0.062, 0.0035, 2);
    body.add(riser, furnitureMat(spec), { y: spec.bore + 0.026, z: spec.stockRear - 0.075 });
    riser.dispose();
  }
}

/* ------------------------------------------------------------------- sights */

function buildSights(body, spec) {
  const L = layoutOf(spec);

  if (spec.features.includes('beadSight')) {
    // Shotgun: a vented rib with a brass bead. No optic tube by default.
    const rib = box(0.0092, 0.0042, Math.abs(spec.zBarrelEnd - spec.zUpperFront) - 0.02, 0.0006, 1);
    body.add(rib, M.steel, {
      y: spec.bore + spec.rBarrel + 0.004,
      z: (spec.zBarrelEnd + spec.zUpperFront) / 2,
    });
    rib.dispose();
    const bead = dome(0.0022, 10);
    body.add(bead, M.brass, { y: spec.bore + spec.rBarrel + 0.0072, z: spec.zBarrelEnd + 0.02 });
    bead.dispose();
    return null;
  }

  if (spec.pattern === 'pistol') {
    // Pistol irons: a dovetailed rear notch and a front post, both on the slide.
    const rear = box(0.0132, 0.0052, 0.0048, 0.0006, 1);
    body.add(rear, M.soot, { y: L.railTop + 0.002, z: spec.zUpperRear - 0.008 });
    rear.dispose();
    const notch = box(0.0034, 0.0042, 0.005, 0.0004, 1);
    body.add(notch, M.cavity, { y: L.railTop + 0.0032, z: spec.zUpperRear - 0.008 });
    notch.dispose();
    const front = box(0.0026, 0.0054, 0.0036, 0.0004, 1);
    body.add(front, M.soot, { y: L.railTop + 0.0022, z: spec.zUpperFront + 0.01 });
    front.dispose();
    return null;
  }

  const up = true;
  addFrontSight(body, M.soot, M.alu, 0, L.railTop, spec.hgZ1 !== null ? spec.hgZ1 + 0.016 : spec.zUpperFront + 0.02, up);
  addRearSight(body, M.soot, M.alu, 0, L.railTop, spec.zUpperRear - 0.018, up);
  return null;
}

/* ---------------------------------------------------------------- accessories */

function buildAccessories(body, spec) {
  if (spec.features.includes('qdSocket')) {
    addQdSocket(body, M.alu, M.bright, spec.hgR + 0.002, spec.bore - 0.012, spec.hgZ0 - 0.03);
  }
  if (spec.features.includes('slingLoop')) {
    const z = spec.stockRear !== null ? spec.zUpperRear + 0.02 : spec.gripZ + 0.03;
    addSlingLoop(body, M.bright, 0.008, spec.bore - 0.03, z);
  }
  if (spec.features.includes('bipodLug')) {
    const lug = box(0.0132, 0.0092, 0.018, 0.001, 1);
    body.add(lug, M.steel, { y: spec.bore - spec.rBarrel - 0.008, z: spec.hgZ1 - 0.02 });
    lug.dispose();
  }
  if (spec.features.includes('accessoryRail')) {
    // Pistol dust-cover rail: the mount a laser or a light hangs from.
    addRail(body, M.poly, spec.zUpperFront + 0.052, spec.zUpperFront + 0.012, spec.bore - 0.0152, 0, {
      slots: 2,
    });
  }
  if (spec.features.includes('ventedRib')) {
    for (let i = 0; i < 4; i++) {
      const slot = box(0.0056, 0.0026, 0.0092, 0.0004, 1);
      body.add(slot, M.cavity, {
        y: spec.bore + spec.rBarrel + 0.0032,
        z: spec.zUpperFront - 0.03 - i * 0.019,
      });
      slot.dispose();
    }
  }
}

/* ------------------------------------------------------------ moving pieces */

function buildMovingParts(spec) {
  const magazine = new Assembly(`${spec.id}-magazine`);
  if (spec.mag.len > 0) {
    buildMagazine(magazine, { poly: magazineMat(spec), steel: M.steel, brass: M.brass }, {
      w: spec.mag.w,
      d: spec.mag.d,
      len: spec.mag.len,
      curve: spec.mag.curve,
      segs: spec.mag.segs,
      poly: magazineMat(spec),
    });
  }

  const charging = new Assembly(`${spec.id}-charging`);
  const ch = chargingHandlePart();
  charging.add(ch.geo ?? ch, M.alu, {});
  (ch.geo ?? ch).dispose?.();

  const bolt = new Assembly(`${spec.id}-bolt`);
  if (spec.slide) {
    buildSlide(bolt, {
      w: spec.slide.w,
      h: spec.slide.h,
      len: spec.slide.len,
      zRear: spec.slide.zRear,
      mat: M.steel,
    });
  } else {
    addBoltCarrier(bolt, M.bright, {
      r: spec.rUpper - 0.004,
      len: spec.pattern === 'smg' ? 0.082 : 0.092,
      z: 0,
    });
  }
  // A chambered round, pushed far enough forward that only the case head shows.
  const round = cartridge(spec.shell.caseLen, spec.shell.rimR, spec.shell.caseLen * 0.42);
  bolt.add(round.brass, M.brass, { z: -spec.shell.caseLen - 0.045, ry: Math.PI });
  round.brass.dispose();
  round.bullet.dispose();

  const trigger = new Assembly(`${spec.id}-trigger`);
  const trg = triggerPart(M.bright);
  trigger.add(trg.geo, M.bright, {});
  trg.geo.dispose();

  const selector = new Assembly(`${spec.id}-selector`);
  const sel = selectorPart(M.alu, M.steel);
  selector.add(sel.geo, M.alu, {});
  sel.geo.dispose();
  const selR = selectorPart(M.alu, M.steel);
  selector.add(selR.geo, M.alu, { sx: -1 });
  selR.geo.dispose();

  return { magazine, charging, bolt, trigger, selector };
}

/* ---------------------------------------------------------------- the optic */

/**
 * NOTHING IS WELDED TO THE RECEIVER ANY MORE.
 *
 * This function used to build a 52 mm optic tube (196 mm on the СВД) into the
 * weapon BODY, unconditionally, for every long gun. The consequences were both
 * visible on the gunsmith board:
 *
 *   1. every rifle wore a can floating above its rail even with `optic: 'iron'`
 *      selected — which is the default loadout, so this was the normal state;
 *   2. mounting a real optic from the hardware rig put a SECOND sight on top of
 *      the first, and taking one off left the welded one behind. "Ставлю модуль,
 *      а на доске не отображается" is partly this: the change was invisible
 *      because there was already a scope there.
 *
 * Optics are attachments. They come from `HardwareRig`, they mount and unmount,
 * and the body carries only what a real weapon carries with the optic removed:
 * iron sights, and on a pistol the mounting cut.
 *
 * The one thing that was genuinely load-bearing about the welded optic is that
 * `nodes.opticGlass` fed the viewmodel's collimated reticle. That is now supplied
 * dynamically by the mounted unit — see `opticGlass()` on the rig and
 * `viewmodel.opticProvider` — which is strictly better: the reticle is now the
 * reticle of the sight you actually mounted, at its real aperture.
 */
function buildDefaultOptic(body, spec) {
  const L = layoutOf(spec);
  if (spec.features.includes('miniReflexMount')) {
    // The optics CUT on a pistol slide: two lugs and a recoil shoulder. A real
    // slide keeps these whether or not anything is bolted to them.
    const plate = box(spec.slide.w * 0.86, 0.0026, 0.0242, 0.0006, 1);
    body.add(plate, M.soot, { y: L.railTop + 0.001, z: spec.opticZ });
    plate.dispose();
    for (const sx of [-1, 1]) {
      const lug = box(0.0026, 0.0034, 0.0042, 0.0004, 1);
      body.add(lug, M.bright, { x: sx * spec.slide.w * 0.3, y: L.railTop + 0.003, z: spec.opticZ - 0.008 });
      lug.dispose();
    }
  }
  return null;
}

/* ----------------------------------------------------------------- assemble */

/**
 * Build one weapon.
 *
 * @param {string} id  a key from MODEL_SPECS
 * @returns {{id:string,label:string,fxClass:string,body:Assembly,
 *   moving:Record<string,Assembly>,nodes:object,shell:object,magSize:object}}
 *   the same shape src/weapons/models/rifle.js returns, so WeaponSystem and the
 *   hand rig consume it without a special case.
 */
export function buildArsenalModel(id, opts = {}) {
  const spec = specFor(id);
  validateSpec(spec);

  const body = new Assembly(`${spec.id}-body`);

  buildReceiver(body, spec);
  const crownZ = buildBarrelGroup(body, spec);
  buildHandguardGroup(body, spec);
  buildGripAndStock(body, spec);
  buildSights(body, spec);
  buildAccessories(body, spec);
  // The declared-feature detail pass: bolt catches, brass deflectors, slide
  // serrations, M-LOK cutouts, the Deagle's squared barrel. See detail.js for
  // why these were declared in specs.js long before anything built them.
  addSpecDetail(body, spec, M, opts.lod ?? LOD_FULL);
  /**
   * The signature pass. Runs AFTER the detail pass and before the optic, because
   * it is allowed to put geometry where the generic architecture left a hole —
   * an AK's front sight tower stands where an AR has nothing at all — and
   * because the optic's own mount must be able to land on top of whatever the
   * family put on the receiver.
   */
  addSignature(body, spec, M);
  const optic = buildDefaultOptic(body, spec);
  const moving = buildMovingParts(spec);

  const nodes = nodesOf(spec);
  // The crown and the lens are only known once the geometry exists, so they
  // override the estimates from the spec rather than being guessed twice.
  nodes.muzzle = [0, spec.bore, crownZ];
  if (optic?.lensZ !== undefined) nodes.sight = [0, layoutOf(spec).opticY, optic.lensZ];
  nodes.opticGlass = optic;

  return {
    id: spec.id,
    label: spec.label,
    fxClass: spec.fxClass,
    body,
    moving,
    nodes,
    shell: { caseLen: spec.shell.caseLen, rimR: spec.shell.rimR },
    magSize: { len: spec.mag.len, w: spec.mag.w, d: spec.mag.d },
  };
}

/** Every model, in menu order. Used by the gunsmith board and the preview tool. */
export function buildAllArsenalModels(ids, opts = {}) {
  const out = {};
  for (const id of ids) out[id] = buildArsenalModel(id, opts);
  return out;
}

export { MOVING_PARTS };
