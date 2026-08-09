/**
 * ARSENAL / HARDWARE — geometry and runtime for detachable parts.
 *
 * Everything here is built ONCE per weapon+attachment pair and then shown or
 * hidden, because a player swaps an optic mid-firefight and a rebuild at that
 * moment is a visible hitch. `HardwareRig` owns the lifetime: mount, unmount,
 * quick-swap, toggle, dispose.
 *
 * Two hard rules, both of which the gate checks:
 *   1. the number of real lights never changes — toggling a torch moves an
 *      intensity between 0 and its rated value, it does not add a SpotLight;
 *   2. nothing allocates per frame — the update path only writes into vectors
 *      and matrices that already exist.
 */

import * as THREE from 'three';
import { Assembly, box, blob, latheZ, rodZ, tubeZ, ring, knurlBand, mergeAll } from '../../weapons/geometry.js';
import {
  addRail,
  addMuzzleDevice,
  addScrew,
  addPin,
  addForeGrip,
  buildOptic,
  buildMiniReflex,
} from '../../weapons/parts.js';
import { MODEL_SPECS, specFor } from '../models/specs.js';
import { ATTACHMENTS, SLOT_ORDER } from '../attachments.js';
import {
  placementFor,
  placementsFor,
  interfacesOf,
  clearanceIssues,
  laserSpec,
  LIGHT_POOL,
  OPTIC_BODY,
  DEVICE_LEN,
  deviceRadius,
} from './specs.js';

/* -------------------------------------------------------------------------- */
/*  scratch — allocated once, at module load, never in a frame                */
/* -------------------------------------------------------------------------- */
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

/* -------------------------------------------------------------------------- */
/*  mounting furniture                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The rails themselves are part of the WEAPON, not of the attachment: they are
 * there whether anything is bolted on or not, which is exactly why an empty rail
 * deck reads as "something goes here".
 */
export function addMountingRails(asm, spec) {
  const ifaces = interfacesOf(spec);
  if (ifaces.railTop) {
    const r = ifaces.railTop;
    addRail(asm, 'alu_fine', r.z0, r.z1, r.y, r.x);
  }
  if (ifaces.sideRail) {
    const r = ifaces.sideRail;
    // A side dovetail is a solid block with a rear lug, not a picatinny ladder.
    const body = box(0.0092, 0.0182, Math.abs(r.z1 - r.z0), 0.0009, 2);
    asm.add(body, 'alu', { x: r.x, y: r.y, z: (r.z0 + r.z1) / 2 });
    body.dispose();
    const lug = box(0.0072, 0.0064, 0.0075, 0.0007, 2);
    asm.add(lug, 'steel', { x: r.x - 0.0016, y: r.y + 0.0104, z: r.z0 - 0.006 });
    lug.dispose();
    // Same off-by-one as in buildTacticalUnit: 'x' has to land in `axis`, the
    // seventh parameter, not in `rHead`.
    addScrew(asm, 'steel', r.x - 0.0052, r.y + 0.004, r.z1 + 0.008, 0.0022, 'x');
  }
  if (ifaces.railBottom) {
    const r = ifaces.railBottom;
    addRail(asm, 'alu_fine', r.z0, r.z1, r.y, r.x, { baseH: 0.0036, topH: 0.0028 });
  }
  if (ifaces.railSide) {
    const r = ifaces.railSide;
    // Rotated a quarter turn: the teeth face outward at 3 o'clock.
    const strip = box(0.0052, 0.0186, Math.abs(r.z1 - r.z0), 0.0008, 2);
    asm.add(strip, 'alu_fine', { x: r.x, y: r.y, z: (r.z0 + r.z1) / 2 });
    strip.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/*  optics                                                                    */
/* -------------------------------------------------------------------------- */

/** Quick-detach lever + mount foot, shared by every removable optic. */
function addQdMount(asm, placement, height) {
  const w = 0.0242;
  const foot = box(w, height, 0.036, 0.0011, 2);
  asm.add(foot, 'alu', { y: placement.railTop + height * 0.5, z: placement.pos[2] });
  foot.dispose();
  const clampG = box(w + 0.0064, 0.0072, 0.0132, 0.0009, 2);
  asm.add(clampG, 'alu', { y: placement.railTop - 0.0018, z: placement.pos[2] + 0.011 });
  clampG.dispose();
  // The throw lever: the one cue that says "this comes off in two seconds".
  const lever = box(0.0068, 0.0182, 0.0042, 0.0008, 2);
  asm.add(lever, 'steel', { x: -(w * 0.5 + 0.006), y: placement.railTop - 0.0026, z: placement.pos[2] + 0.011, rz: 0.22 });
  lever.dispose();
  const pivot = rodZ(0.0018, 0.0018, 0.0112, 10);
  asm.add(pivot, 'steel_bright', { x: -(w * 0.5 + 0.004), y: placement.railTop - 0.0026, z: placement.pos[2] + 0.011, ry: Math.PI / 2 });
  pivot.dispose();
  addPin(asm, 'steel', 0, placement.railTop + height * 0.5, placement.pos[2] - 0.014);
}

/**
 * Build one optic as its own assembly, returning the data the viewmodel needs
 * to put a reticle on the optical axis.
 */
export function buildOpticUnit(spec, attId) {
  const att = ATTACHMENTS[attId];
  const p = placementFor(spec, attId);
  const asm = new Assembly(`${spec.id}_${attId}`);
  const body = OPTIC_BODY[att.kind] ?? OPTIC_BODY.reflex;
  let glass;

  if (att.kind === 'irons') {
    /**
     * Irons are not an attachment you bolt on — they are milled into the
     * receiver by buildArsenalModel, and `NEEDS.irons` is null to say exactly
     * that. So this unit contributes NO geometry; it exists only to report the
     * sight line the viewmodel aims down.
     *
     * Falling through to the branches below was a real bug: `OPTIC_BODY` has no
     * `irons` entry, so irons silently borrowed the reflex body and landed in
     * the tube-scope branch, which called addQdMount with `p.railTop` — a field
     * the irons placement deliberately does not set. undefined went into a
     * position, and the resulting NaN poisoned the merged buffer for the whole
     * sight. Every weapon ships with irons by default, so this one line broke
     * the default loadout of all nine.
     */
    return {
      id: attId,
      slot: 'optic',
      assembly: asm,
      placement: p,
      axis: [p.pos[0], p.axisY, p.pos[2]],
      glass: null,
      zoom: att.zoom,
      kind: att.kind,
    };
  }

  if (att.kind === 'reflex') {
    addQdMount(asm, p, p.axisY - p.railTop - body.h * 0.5);
    glass = buildMiniReflex(asm, { w: body.w, h: body.h, len: body.len, y: p.axisY - body.h * 0.5, z: p.pos[2] });
  } else if (att.kind === 'holo') {
    addQdMount(asm, p, p.axisY - p.railTop - body.h * 0.5);
    // A holographic sight is a boxy hood, not a tube: square window, big shade.
    glass = buildMiniReflex(asm, { w: body.w, h: body.h, len: body.len, y: p.axisY - body.h * 0.5, z: p.pos[2], tilt: 0.05 });
    const hood = box(body.w + 0.0038, body.h + 0.0034, body.len * 0.52, 0.0012, 2);
    asm.add(hood, 'alu', { y: p.axisY, z: p.pos[2] - body.len * 0.26 });
    hood.dispose();
    const batt = box(body.w * 0.62, 0.0092, 0.0182, 0.001, 2);
    asm.add(batt, 'polymer', { y: p.axisY - body.h * 0.42, z: p.pos[2] + body.len * 0.36 });
    batt.dispose();
  } else {
    // Tube scope: rings, tube, turrets, and its own ocular bell.
    const rise = p.axisY - p.railTop;
    addQdMount(asm, p, Math.max(0.006, rise - body.rTube - 0.004));
    glass = buildOptic(asm, {
      rTube: body.rTube,
      len: body.len,
      y: p.axisY,
      z: p.pos[2],
      railTop: p.railTop,
      matBody: 'alu',
    });
    for (const dz of [-0.026, 0.026]) {
      const r = ring(body.rTube + 0.0026, 0.0032, 20, 6);
      asm.add(r, 'alu', { y: p.axisY, z: p.pos[2] + dz, ry: Math.PI / 2 });
      r.dispose();
    }
    const knurl = knurlBand(body.rTube + 0.0042, 0.0122, 26, 0.0004, 3);
    asm.add(knurl, 'alu_fine', { y: p.axisY + body.rTube + 0.006, z: p.pos[2] - 0.006, rx: Math.PI / 2 });
    knurl.dispose();
  }

  return {
    id: attId,
    slot: 'optic',
    assembly: asm,
    placement: p,
    axis: [p.pos[0], p.axisY, p.pos[2]],
    glass,
    zoom: att.zoom,
    kind: att.kind,
  };
}

/* -------------------------------------------------------------------------- */
/*  muzzle devices                                                            */
/* -------------------------------------------------------------------------- */

export function buildMuzzleUnit(spec, attId) {
  const att = ATTACHMENTS[attId];
  const p = placementFor(spec, attId);
  const asm = new Assembly(`${spec.id}_${attId}`);

  if (att.kind === 'suppressor') {
    const len = DEVICE_LEN.suppressor;
    const rOut = deviceRadius(spec, 'suppressor');
    const tube = tubeZ(rOut, rOut - 0.0022, len, 44, 0.0008);
    asm.add(tube, 'steel_soot', { y: spec.bore, z: p.pos[2] - len * 0.5 });
    tube.dispose();
    // Baffle stack, visible down the bore: the cue that it is not a paper towel.
    for (let i = 0; i < 7; i += 1) {
      const baffle = latheZ(
        [
          [0, spec.rBarrel * 0.72],
          [0.0022, rOut - 0.0034],
          [0.0092, rOut - 0.0034],
          [0.0122, spec.rBarrel * 0.86],
        ],
        22
      );
      asm.add(baffle, 'cavity', { y: spec.bore, z: p.pos[2] - 0.014 - i * 0.0208 });
      baffle.dispose();
    }
    const collar = latheZ(
      [
        [0, spec.rBarrel + 0.0022],
        [0.004, rOut * 0.96],
        [0.016, rOut * 0.96],
        [0.018, rOut],
      ],
      28
    );
    asm.add(collar, 'steel', { y: spec.bore, z: p.pos[2] - 0.001 });
    collar.dispose();
    const grip = knurlBand(rOut * 0.97, 0.0182, 34, 0.00035, 3);
    asm.add(grip, 'steel_soot', { y: spec.bore, z: p.pos[2] - 0.03, rx: Math.PI / 2 });
    grip.dispose();
  } else {
    // Brakes and compensators are the parts kit's own, so a swapped device looks
    // exactly like the one the weapon shipped with.
    addMuzzleDevice(asm, 'steel', 'cavity', att.kind === 'comp' ? 'comp' : 'brake', p.pos[2], spec.rBarrel, spec.bore);
  }

  return {
    id: attId,
    slot: 'muzzle',
    assembly: asm,
    placement: p,
    /** Where the flash, the smoke and the first tracer segment now start. */
    muzzleNode: [0, spec.bore, p.crownZ],
    flashScale: att.mul?.flashScale ?? 1,
    silent: !!att.silent,
  };
}

/* -------------------------------------------------------------------------- */
/*  tactical: laser, light, combo                                             */
/* -------------------------------------------------------------------------- */

export function buildTacticalUnit(spec, attId) {
  const att = ATTACHMENTS[attId];
  const p = placementFor(spec, attId);
  const asm = new Assembly(`${spec.id}_${attId}`);
  const w = att.kind === 'combo' ? 0.038 : 0.026;
  const h = 0.024;

  const shell = blob(w, h, p.len, 0.0032, 3);
  asm.add(shell, 'polymer', { x: p.pos[0], y: p.pos[1] - h * 0.5, z: p.pos[2], rz: p.rot[2] });
  shell.dispose();
  const clamp = box(w * 0.86, 0.0076, 0.0152, 0.0009, 2);
  asm.add(clamp, 'alu', { x: p.pos[0], y: p.pos[1] + 0.0022, z: p.pos[2] + p.len * 0.28, rz: p.rot[2] });
  clamp.dispose();
  // addScrew is (asm, mat, x, y, z, rHead, axis, len) — `axis` is the SEVENTH
  // argument. Passing 'y' in sixth position made it the head RADIUS, so every
  // dimension of the screw was derived from a string and came out NaN.
  addScrew(asm, 'steel', p.pos[0], p.pos[1] - h - 0.001, p.pos[2] + p.len * 0.28, 0.0022, 'y');

  const hasLaser = att.kind === 'laser' || att.kind === 'combo';
  const hasLight = !!att.light;
  let lensR = 0;

  if (hasLaser) {
    const port = latheZ(
      [
        [0, 0.0028],
        [0.0012, 0.0036],
        [0.004, 0.0036],
      ],
      16
    );
    asm.add(port, 'cavity', { x: p.pos[0] - (att.kind === 'combo' ? 0.0096 : 0), y: p.pos[1] - h * 0.42, z: p.emitZ, rz: p.rot[2] });
    port.dispose();
  }
  if (hasLight) {
    lensR = 0.0092;
    const bezel = latheZ(
      [
        [0, lensR * 0.55],
        [0.0018, lensR],
        [0.0062, lensR],
        [0.0072, lensR * 0.9],
      ],
      26
    );
    asm.add(bezel, 'alu', { x: p.pos[0] + (att.kind === 'combo' ? 0.0088 : 0), y: p.pos[1] - h * 0.42, z: p.emitZ, rz: p.rot[2] });
    bezel.dispose();
    // A reflector, not a flat disc: an unlit torch still has to read as a torch.
    const reflector = latheZ(
      [
        [0, 0.0012],
        [0.0058, lensR * 0.88],
      ],
      26
    );
    asm.add(reflector, 'steel_bright', { x: p.pos[0] + (att.kind === 'combo' ? 0.0088 : 0), y: p.pos[1] - h * 0.42, z: p.emitZ + 0.006, rz: p.rot[2] });
    reflector.dispose();
  }
  const pad = box(w * 0.5, 0.0062, 0.0092, 0.0012, 2);
  asm.add(pad, 'rubber', { x: p.pos[0], y: p.pos[1] - h * 0.86, z: p.pos[2] - p.len * 0.3, rz: p.rot[2] });
  pad.dispose();

  return {
    id: attId,
    slot: 'tactical',
    assembly: asm,
    placement: p,
    hasLaser,
    hasLight,
    lensR,
    laser: hasLaser ? laserSpec(spec, p) : null,
    light: att.light ?? null,
    toggleKey: att.toggleKey ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/*  underbarrel: foregrip, bipod                                              */
/* -------------------------------------------------------------------------- */

export function buildUnderbarrelUnit(spec, attId) {
  const att = ATTACHMENTS[attId];
  const p = placementFor(spec, attId);
  const asm = new Assembly(`${spec.id}_${attId}`);

  if (att.kind === 'foregrip') {
    addForeGrip(asm, 'polymer', 'rubber', { y: p.pos[1], z: p.pos[2], angle: p.rot[0], len: p.len });
    const clamp = box(0.026, 0.0082, 0.0182, 0.001, 2);
    asm.add(clamp, 'alu', { y: p.pos[1] + 0.004, z: p.pos[2] + 0.006 });
    clamp.dispose();
    return { id: attId, slot: 'underbarrel', assembly: asm, placement: p, legs: null, deployable: false };
  }

  // Bipod: a yoke plus two legs, each its own node so they can fold.
  const yoke = box(0.03, 0.0142, p.len, 0.0012, 2);
  asm.add(yoke, 'alu', { y: p.pos[1], z: p.pos[2] });
  yoke.dispose();
  const legs = [];
  for (const side of [-1, 1]) {
    const legAsm = new Assembly(`${spec.id}_bipod_leg${side > 0 ? 'R' : 'L'}`);
    const leg = rodZ(0.0042, 0.0036, p.legLen, 12);
    legAsm.add(leg, 'steel', { z: -p.legLen * 0.5 });
    leg.dispose();
    const foot = blob(0.0106, 0.0062, 0.0142, 0.0022, 3);
    legAsm.add(foot, 'rubber', { z: -p.legLen });
    foot.dispose();
    const spring = ring(0.0056, 0.0012, 12, 5);
    legAsm.add(spring, 'steel_bright', { z: -0.014 });
    spring.dispose();
    legs.push({
      side,
      assembly: legAsm,
      pivot: [side * 0.0132, p.pos[1] - 0.004, p.pos[2]],
      stowedAngle: p.stowedAngle * side,
      deployedAngle: p.deployedAngle * side,
    });
  }
  addPin(asm, 'steel', 0, p.pos[1] - 0.004, p.pos[2]);
  return { id: attId, slot: 'underbarrel', assembly: asm, placement: p, legs, deployable: true };
}

/* -------------------------------------------------------------------------- */
/*  magazines                                                                 */
/* -------------------------------------------------------------------------- */

export function buildMagazineUnit(spec, attId) {
  const att = ATTACHMENTS[attId];
  const p = placementFor(spec, attId);
  const asm = new Assembly(`${spec.id}_${attId}`);
  const mul = att.mul?.magLen ?? 1;

  /**
   * A MAGAZINE UNIT BUILDS NO MAGAZINE. That is the fix, and it is not a cop-out.
   *
   * This function used to build a complete magazine body and hang it off the
   * weapon — while the weapon MODEL also built one, as a moving part, because the
   * magazine has to drop out during a reload. So every weapon in the game carried
   * TWO magazines. Measured on the АКМ with tools/lab/census.mjs:
   *
   *   akm-magazine-steel          y -172..8    z  -58..35
   *   akm_magStandard-polymer     y -176..2    z -151..-38
   *
   * Two bodies, 26 mm apart in z, in slightly different materials. On the board
   * that reads as a magazine hanging off the front of the magwell at the wrong
   * angle — the "detached, floating magazine" — and in game the animated one slid
   * out of the static one during every reload.
   *
   * There can only be one, and it has to be the MOVING one: the mounted magazine
   * is the magazine you drop. So the rig contributes no geometry here and instead
   * publishes a length SCALE (`rig.magScale()`), which the viewmodel applies to
   * the model's animated magazine. An extended magazine is then 34% longer, on the
   * real part, and it still falls out of the gun.
   *
   * Same class of defect as the optic that was welded into the receiver, and the
   * same resolution: a mountable thing must be exactly one thing.
   */
  return {
    id: attId,
    slot: 'magazine',
    assembly: asm,
    placement: p,
    len: spec.mag.len * mul,
    /** What the animated magazine has to be scaled by along its own axis. */
    magScale: mul,
  };
}

/** One entry point: build whatever the slot needs. */
export function buildAttachmentUnit(spec, attId) {
  const att = ATTACHMENTS[attId];
  if (!att) throw new Error(`unknown attachment ${attId}`);
  if (att.slot === 'optic') return buildOpticUnit(spec, attId);
  if (att.slot === 'muzzle') return buildMuzzleUnit(spec, attId);
  if (att.slot === 'tactical') return buildTacticalUnit(spec, attId);
  if (att.slot === 'underbarrel') return buildUnderbarrelUnit(spec, attId);
  return buildMagazineUnit(spec, attId);
}
