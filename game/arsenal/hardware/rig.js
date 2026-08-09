/**
 * ARSENAL / HARDWARE — the runtime rig.
 *
 * Owns the lifetime of every mounted part on one weapon:
 *   mount / unmount / swap  — geometry is built once and cached, then shown
 *   toggle                  — laser and torch flip an intensity, never a count
 *   update                  — zero allocations; only writes into existing objects
 *   dispose                 — every geometry and every material handed back
 *
 * The cache is per weapon, because an optic built for an AK sits on a side
 * dovetail and the same optic on an M416 sits on the top deck: the same id is
 * genuinely different geometry.
 */

import * as THREE from 'three';
import { specFor } from '../models/specs.js';
import { ATTACHMENTS, SLOT_ORDER, canMount, defaultLoadout, resolveStats } from '../attachments.js';
import { LIGHT_POOL, clearanceIssues, placementsFor } from './specs.js';
import { buildAttachmentUnit, addMountingRails } from './build.js';
import { meshifyAssembly } from '../mesh.js';

const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _target = new THREE.Vector3();
const _mat = new THREE.Matrix4();

/** Rated values, so a toggle is a lerp between two known numbers. */
const OFF = 0;

export class HardwareRig {
  /**
   * @param {object} o
   * @param {string} o.weaponId
   * @param {THREE.Object3D} o.root the viewmodel node the weapon hangs from
   * @param {(name:string)=>THREE.Material} o.material the weapons material bank
   */
  constructor(o) {
    this.weaponId = o.weaponId;
    this.spec = specFor(o.weaponId);
    this.root = o.root;
    this.materialFor = o.material;

    /** slot -> mounted unit (or null). */
    this.mounted = { optic: null, muzzle: null, tactical: null, underbarrel: null, magazine: null };
    /** `${slot}:${id}` -> built unit, kept for instant re-mount. */
    this.cache = new Map();

    this.group = new THREE.Group();
    this.group.name = `hardware_${o.weaponId}`;
    this.root.add(this.group);

    /**
     * THE LIGHT POOL.
     *
     * Created here, once, whether or not the player ever mounts a torch. A light
     * that appears later forces the renderer to recompile every material it
     * touches, which is a stall measured in tenths of a second — and it always
     * happens at the worst moment, because the player mounts a torch when it has
     * just got dark and something is shooting at them.
     */
    this.lights = [];
    for (let i = 0; i < LIGHT_POOL.spot; i += 1) {
      const spot = new THREE.SpotLight(0xffffff, OFF, 40, 0.34, 0.45, 1.4);
      spot.name = `hardware_spot_${i}`;
      spot.castShadow = false;
      spot.target.name = `hardware_spot_target_${i}`;
      this.group.add(spot);
      this.group.add(spot.target);
      this.lights.push(spot);
    }

    /** Laser beam + dot, also built up front and simply hidden. */
    this.beam = null;
    this.dot = null;

    this.state = { laserOn: false, lightOn: false, bipodDeployed: false, swapT: 1 };

    /**
     * MOUNT ANIMATION.
     *
     * `swapT` existed already and nothing read it, so mounting was a hard cut: a
     * scope teleported onto the rail between two frames. Reported as part of "все
     * это должно быть с анимациями" — and it is not decoration. A hard cut gives
     * the player no evidence that their click did anything, which is the other
     * half of "ставлю модуль, а на доске не отображается": even when the geometry
     * DID change, nothing on screen moved to say so.
     *
     * Each slot animates along the direction the part is physically fitted from,
     * because that is what makes the motion legible as fitting rather than as a
     * wobble:
     *
     *   optic        lifts off the rail, upward — you drop a scope onto a rail
     *   muzzle       threads off the crown, forward
     *   tactical     comes off the side rail, sideways
     *   underbarrel  drops off the bottom rail, downward
     *   magazine     falls out of the well, downward and tilted
     *
     * Removal runs the same path backwards and the object stays VISIBLE until it
     * has travelled — hiding it on the click would be the same hard cut in
     * reverse.
     */
    this._anim = new Map();

    /**
     * Resolved-stats memo. `stats()` re-folds every mounted part and allocates a
     * fresh loadout object, which was fine when only the gunsmith board called it
     * once per click. The camera now reads `zoom` every frame, so cache the result
     * and bump `_rev` wherever the build or a toggle changes. Anything that can
     * alter the numbers must bump it, so the invalidation lives next to each
     * mutation rather than in one list that drifts.
     */
    this._rev = 0;
    this._statsRev = -1;
    this._stats = null;
    this.disposed = false;
  }

  /* ------------------------------------------------------------ animation */

  /**
   * Where a part travels from, in metres, and how long it takes.
   *
   * Distances are the ones a hand actually moves the part through when fitting
   * it — a scope lifts a couple of centimetres off the rail, a suppressor threads
   * off the muzzle by more than that — and the durations are all inside 0.3 s
   * because this is feedback, not a cutscene.
   */
  static ANIM = {
    optic: { from: [0, 0.05, 0.006], rot: [0.16, 0, 0], time: 0.24 },
    muzzle: { from: [0, 0, -0.07], rot: [0, 0, 1.9], time: 0.28 },
    tactical: { from: [0.052, 0, 0], rot: [0, 0.22, 0], time: 0.22 },
    underbarrel: { from: [0, -0.05, 0.008], rot: [-0.2, 0, 0], time: 0.24 },
    magazine: { from: [0, -0.09, -0.012], rot: [0.24, 0, 0], time: 0.22 },
  };

  /* ---------------------------------------------------------------- rails */

  /** Called once by the weapon builder so empty rails still read as mounts. */
  static rails(asm, spec) {
    addMountingRails(asm, spec);
  }

  /* --------------------------------------------------------------- mount */

  /**
   * Build (or fetch) a unit and hang it on the weapon.
   *
   * @param {string} attId
   * @param {{animate?: boolean}} [o]  `false` seats it instantly, for restoring a
   *   saved build. A restore is not a player action and must not look like one.
   */
  mount(attId, o = {}) {
    const att = ATTACHMENTS[attId];
    if (!att) throw new Error(`unknown attachment ${attId}`);
    const check = canMount(this.defs ?? this.def(), attId);
    if (!check.ok) return { ok: false, reason: check.reason };

    const key = `${att.slot}:${attId}`;
    let unit = this.cache.get(key);
    if (!unit) {
      unit = buildAttachmentUnit(this.spec, attId);
      unit.object = meshifyAssembly(unit.assembly, this.materialFor);
      if (unit.legs) {
        for (const leg of unit.legs) {
          leg.object = meshifyAssembly(leg.assembly, this.materialFor);
          leg.object.position.set(leg.pivot[0], leg.pivot[1], leg.pivot[2]);
          leg.object.rotation.z = leg.stowedAngle;
          unit.object.add(leg.object);
        }
      }
      this.cache.set(key, unit);
      this.group.add(unit.object);
    }

    const previous = this.mounted[att.slot];
    if (previous && previous.id !== attId) previous.object.visible = false;
    unit.object.visible = true;
    this.mounted[att.slot] = unit;
    this._rev += 1;

    if (att.slot === 'tactical') this.#wireTactical(unit);
    // A fresh optic starts un-zeroed for the swap animation, then settles.
    if (att.slot === 'optic') this.state.swapT = 0;
    if (o.animate === false) {
      this._anim.delete(att.slot);
      unit.object.visible = true;
      this.#applyAnim(unit.object, HardwareRig.ANIM[att.slot], 1);
    } else {
      this.#animate(att.slot, unit, 1);
    }
    return { ok: true, unit };
  }

  /** Take a part off. Geometry stays cached; only visibility changes. */
  unmount(slot, o = {}) {
    const unit = this.mounted[slot];
    if (!unit) return false;
    if (o.animate === false) {
      this._anim.delete(slot);
      unit.object.visible = false;
      this.mounted[slot] = null;
      this._rev += 1;
      if (slot === 'tactical') {
        this.#lightsOff();
        if (this.beam) this.beam.visible = false;
        if (this.dot) this.dot.visible = false;
      }
      return true;
    }
    // Visible until it has travelled: hiding it on the click is the same hard cut
    // the mount animation exists to remove, just in reverse.
    this.#animate(slot, unit, 0);
    this.mounted[slot] = null;
    this._rev += 1;
    if (slot === 'tactical') {
      this.#lightsOff();
      if (this.beam) this.beam.visible = false;
      if (this.dot) this.dot.visible = false;
    }
    return true;
  }

  /** Quick-swap: unmount whatever is in the slot and mount `attId` instead. */
  swap(slot, attId, o = {}) {
    if (attId === null) return this.unmount(slot, o);
    this.unmount(slot, o);
    return this.mount(attId, o);
  }

  /**
   * Apply a whole loadout at once (used on spawn and by the gunsmith board).
   *
   * ONLY SLOTS THAT ACTUALLY CHANGED ARE TOUCHED, and that is what makes the mount
   * animation usable at all. The board commits a whole loadout object on every
   * click, so unconditionally unmounting and remounting all five slots meant that
   * fitting a suppressor also re-seated the optic, the light, the grip and the
   * magazine — four animations the player did not ask for, all restarting the one
   * they did. It was also four rebuild lookups per click for no change.
   *
   * @param {object} loadout
   * @param {{animate?: boolean}} [o] `false` restores a saved build instantly.
   */
  setLoadout(loadout, o = {}) {
    const rejected = [];
    const before = this.loadout();
    for (const slot of SLOT_ORDER) {
      const id = loadout[slot] ?? null;
      const was = before[slot] ?? null;
      if (was === id) continue;
      if (!id) {
        this.unmount(slot, o);
        continue;
      }
      const r = this.swap(slot, id, o);
      if (r && r.ok === false) rejected.push({ id, reason: r.reason });
    }
    return rejected;
  }

  /* ------------------------------------------------------------- toggles */

  /** Laser: FPS Arena's L key. */
  toggleLaser() {
    const tac = this.mounted.tactical;
    if (!tac || !tac.hasLaser) return false;
    this.state.laserOn = !this.state.laserOn;
    // A live laser is a visible giveaway, so resolveStats reads it. `lightOn` is
    // deliberately NOT invalidated: it changes nothing the stats fold looks at.
    this._rev += 1;
    if (this.beam) this.beam.visible = this.state.laserOn;
    if (this.dot) this.dot.visible = this.state.laserOn;
    return this.state.laserOn;
  }

  /** Torch: FPS Arena's F key. Intensity only — the light itself never moves. */
  toggleLight() {
    const tac = this.mounted.tactical;
    if (!tac || !tac.hasLight) return false;
    this.state.lightOn = !this.state.lightOn;
    const spot = this.lights[0];
    spot.intensity = this.state.lightOn ? tac.light.intensity : OFF;
    return this.state.lightOn;
  }

  /** Bipod: only meaningful prone or against a ledge; the caller decides that. */
  setBipod(deployed) {
    const under = this.mounted.underbarrel;
    if (!under || !under.deployable) return false;
    this.state.bipodDeployed = !!deployed;
    this._rev += 1;
    for (const leg of under.legs) {
      leg.object.rotation.z = deployed ? leg.deployedAngle : leg.stowedAngle;
    }
    return this.state.bipodDeployed;
  }

  /* -------------------------------------------------------------- update */

  /**
   * Per-frame. Allocates nothing: the spot light is aimed by writing into a
   * scratch vector that has existed since module load, and the beam is scaled
   * rather than rebuilt.
   *
   * @param {number} dt
   * @param {{ hitDistance:number }} aim distance to whatever the bore is pointing at
   */
  /**
   * Start (or reverse) a slot's fit animation.
   *
   * Keyed by SLOT rather than by unit, because swapping one optic for another has
   * to be a single motion: the old one leaves and the new one arrives on the same
   * timeline, and two independent animations on one rail would have them pass
   * through each other.
   */
  #animate(slot, unit, target) {
    const spec = HardwareRig.ANIM[slot];
    if (!spec || !unit?.object) return;
    const prev = this._anim.get(slot);
    /**
     * A DIFFERENT PART TAKING OVER THIS SLOT ENDS THE PREVIOUS ONE'S TRAVEL.
     *
     * Measured on the board (tools/lab/mount.mjs): swapping a red dot back to
     * irons left the red dot VISIBLE and the mesh count unchanged, so the weapon
     * kept both sights. `swap()` is `unmount()` then `mount()`, the unmount starts
     * the old unit travelling out, and the mount then overwrote the slot's single
     * animation record — so the outgoing part never reached its target and the
     * "hide it now" branch was never reached.
     *
     * One record per slot is the right shape (two independent animations on one
     * rail would pass through each other), so the outgoing part is retired here
     * instead: it disappears as the new one arrives, which reads as a swap.
     */
    if (prev && prev.unit !== unit && this.mounted[slot] !== prev.unit) {
      prev.unit.object.visible = false;
    }
    // Reversing mid-flight resumes from where it is rather than snapping.
    const t = prev && prev.unit === unit ? prev.t : target > 0 ? 0 : 1;
    this._anim.set(slot, { unit, t, target, spec });
    unit.object.visible = true;
    this.#applyAnim(unit.object, spec, t);
  }

  /**
   * Place a part `t` of the way home. `t = 1` is seated, and it must be EXACTLY
   * the identity transform at that point — the placement is baked into the
   * assembly's own geometry (see hardware/build.js), so any residue here is a
   * permanently misaligned attachment rather than a wobble that settles.
   */
  #applyAnim(obj, spec, t) {
    if (t >= 1) {
      obj.position.set(0, 0, 0);
      obj.rotation.set(0, 0, 0);
      return;
    }
    // Ease out: fast off the mark, settling in. A linear fit reads mechanical in
    // the wrong way — like a part sliding on ice rather than being placed.
    const k = 1 - (1 - t) * (1 - t);
    const u = 1 - k;
    obj.position.set(spec.from[0] * u, spec.from[1] * u, spec.from[2] * u);
    obj.rotation.set(spec.rot[0] * u, spec.rot[1] * u, spec.rot[2] * u);
  }

  /** True while any part is still travelling. The board dims its stats on it. */
  get animating() {
    return this._anim.size > 0;
  }

  update(dt, aim) {
    if (this.disposed) return;
    if (this.state.swapT < 1) this.state.swapT = Math.min(1, this.state.swapT + dt * 6);

    // ---- mount / unmount motion ------------------------------------------
    if (this._anim.size) {
      for (const [slot, a] of this._anim) {
        const step = dt / a.spec.time;
        a.t = a.target > a.t ? Math.min(1, a.t + step) : Math.max(0, a.t - step);
        this.#applyAnim(a.unit.object, a.spec, a.t);
        if (a.t !== a.target) continue;
        // Arrived. A part that travelled OUT is hidden only now, and only if
        // nothing has since been mounted in its place.
        if (a.target === 0 && this.mounted[slot] !== a.unit) a.unit.object.visible = false;
        this._anim.delete(slot);
      }
    }

    const tac = this.mounted.tactical;
    if (!tac) return;

    if (tac.hasLight && this.state.lightOn) {
      const spot = this.lights[0];
      const p = tac.placement;
      _pos.set(p.pos[0], p.pos[1], p.emitZ);
      spot.position.copy(_pos);
      _target.set(p.pos[0], p.pos[1], p.emitZ - 1);
      spot.target.position.copy(_target);
      spot.angle = tac.light.angle;
      spot.distance = tac.light.distance;
      spot.penumbra = tac.light.penumbra;
    }

    if (tac.hasLaser && this.state.laserOn && this.beam) {
      // The beam is one unit long and scaled to the hit distance, so the dot lands
      // on the surface instead of hanging in the air in front of it.
      const d = Math.min(tac.laser.range, aim?.hitDistance ?? tac.laser.range);
      this.beam.scale.z = d;
      if (this.dot) this.dot.position.z = tac.laser.origin[2] - d;
    }
  }

  /* ------------------------------------------------------------- queries */

  def() {
    // Imported lazily to keep this module free of a cycle with defs.js.
    return this._def;
  }

  /** Attach the weapon definition so mounting rules can be checked. */
  bind(def) {
    this._def = def;
    // The base weapon is what every modifier folds onto, so rebinding invalidates
    // harder than any attachment change.
    this._rev += 1;
    return this;
  }

  /** Current loadout as slot -> id, for saving and for the board. */
  loadout() {
    const out = {};
    for (const slot of SLOT_ORDER) {
      const unit = this.mounted[slot];
      if (unit) out[slot] = unit.id;
    }
    return out;
  }

  /**
   * Resolved stats for the current build, including runtime toggles.
   *
   * Memoized on `_rev`: safe to call every frame. The returned object is shared,
   * so treat it as read-only - mutating it would corrupt the next reader.
   */
  stats() {
    if (this._stats === null || this._statsRev !== this._rev) {
      this._stats = resolveStats(this._def, this.loadout(), {
        laserOn: this.state.laserOn,
        bipodDeployed: this.state.bipodDeployed,
      });
      this._statsRev = this._rev;
    }
    return this._stats;
  }

  /**
   * How much longer the mounted magazine is than the standard one.
   *
   * The rig deliberately builds no magazine geometry (see `buildMagazineUnit`):
   * there is exactly one magazine and it is the model's animated part, because a
   * magazine that does not drop out during a reload is not a magazine. So the
   * difference an extended magazine makes is published as a scale and applied to
   * the real part by the viewmodel.
   */
  magScale() {
    return this.mounted.magazine?.magScale ?? 1;
  }

  /**
   * The mounted optic's GLASS, for the collimated reticle.
   *
   * The viewmodel draws a red dot by projecting the tube axis from the eye and
   * vignetting it against the lens aperture (weapons/viewmodel.js
   * `_updateReticle`), and it used to read that description off a scope welded
   * into the weapon body. So the reticle was always the welded scope's, whatever
   * was actually bolted to the rail — a 4x PSO and a 1x red dot drew the same
   * dot at the same aperture, and with `optic: 'iron'` a dot appeared with no
   * sight in front of it at all.
   *
   * Returning the live unit's own glass makes the reticle a property of the sight
   * the player mounted, which is the entire point of a mountable sight. `null`
   * means irons: no reticle, and the viewmodel hides it.
   */
  opticGlass() {
    const optic = this.mounted.optic;
    return optic?.glass ?? null;
  }

  /** The sight line the camera should use: the mounted optic, or the irons. */
  sightAxis() {
    const optic = this.mounted.optic;
    if (optic && optic.axis) return optic.axis;
    return null;
  }

  /** Geometry sanity for the current build; empty array means clean. */
  issues() {
    return clearanceIssues(this.spec, placementsFor(this.spec, this.loadout()));
  }

  /* ------------------------------------------------------------- disposal */

  #wireTactical(unit) {
    const spot = this.lights[0];
    if (unit.hasLight) {
      spot.color.setHex(unit.light.colour);
      spot.intensity = this.state.lightOn ? unit.light.intensity : OFF;
    } else {
      spot.intensity = OFF;
    }
    if (unit.hasLaser && !this.beam) this.#buildLaser(unit);
    if (this.beam) {
      this.beam.visible = unit.hasLaser && this.state.laserOn;
      this.dot.visible = unit.hasLaser && this.state.laserOn;
    }
  }

  #buildLaser(unit) {
    const L = unit.laser;
    const beamGeo = new THREE.CylinderGeometry(L.beamR, L.beamR, 1, 6, 1, true);
    // Built along +Y, rotated to lie down the bore, translated so it starts at
    // the emitter: doing this in the geometry means the update path only scales.
    beamGeo.rotateX(Math.PI / 2);
    beamGeo.translate(0, 0, -0.5);
    const beamMat = new THREE.MeshBasicMaterial({
      color: L.colour,
      transparent: true,
      opacity: L.beamOpacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.beam = new THREE.Mesh(beamGeo, beamMat);
    this.beam.position.set(L.origin[0], L.origin[1], L.origin[2]);
    this.beam.frustumCulled = false;
    this.beam.visible = false;
    this.group.add(this.beam);

    const dotGeo = new THREE.SphereGeometry(L.dotR * 0.5, 8, 6);
    const dotMat = new THREE.MeshBasicMaterial({
      color: L.colour,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.dot = new THREE.Mesh(dotGeo, dotMat);
    this.dot.position.set(L.origin[0], L.origin[1], L.origin[2]);
    this.dot.visible = false;
    this.group.add(this.dot);
  }

  #lightsOff() {
    for (const spot of this.lights) spot.intensity = OFF;
    this.state.lightOn = false;
    this.state.laserOn = false;
    this._rev += 1;
  }

  /** Hand back every resource. Called on weapon change and on teardown. */
  dispose() {
    if (this.disposed) return;
    for (const unit of this.cache.values()) {
      if (unit.legs) {
        for (const leg of unit.legs) leg.assembly.dispose?.();
      }
      unit.assembly.dispose?.();
      unit.object?.traverse?.((child) => {
        if (child.isMesh) {
          child.geometry?.dispose();
        }
      });
    }
    this.cache.clear();
    if (this.beam) {
      this.beam.geometry.dispose();
      this.beam.material.dispose();
      this.beam = null;
    }
    if (this.dot) {
      this.dot.geometry.dispose();
      this.dot.material.dispose();
      this.dot = null;
    }
    for (const spot of this.lights) {
      spot.intensity = OFF;
      spot.parent?.remove(spot.target);
      spot.parent?.remove(spot);
    }
    this.lights.length = 0;
    this.group.parent?.remove(this.group);
    this.mounted = { optic: null, muzzle: null, tactical: null, underbarrel: null, magazine: null };
    this.disposed = true;
  }
}

/** Convenience: a rig already wearing the weapon's factory loadout. */
export function rigFor(def, o) {
  const rig = new HardwareRig({ ...o, weaponId: def.id }).bind(def);
  rig.setLoadout(defaultLoadout(def));
  return rig;
}
