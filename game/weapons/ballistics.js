import * as THREE from 'three';
import {
  RHO_0,
  MACH_1,
  GRAVITY,
  dragDecel,
  energy as kineticEnergy,
} from '../ballistics/cartridges.js';

/**
 * Projectile ballistics — the live simulation.
 *
 * Rounds are simulated, not hitscanned: each shot is a body with a muzzle
 * velocity, gravity, aerodynamic drag and wind, stepped at the physics rate.
 * Terminal effects (penetration, spall, damage) are handed to
 * `physics.fireBullet()` at the moment of contact so wall penetration and
 * multi-layer hits stay in one place.
 *
 * WHAT CHANGED, AND WHY IT MATTERS
 *
 * 1. DRAG IS AERODYNAMIC, NOT LINEAR.
 *    This used to be `v *= 1 - dragK*dt`, which is the drag law for a body moving
 *    through treacle: force proportional to speed. Real drag goes with the SQUARE
 *    of speed, and the drag coefficient itself rises 42% as the round crosses
 *    Mach 1. The old model could be tuned to be right at one distance and was
 *    then wrong at every other one — and the transonic knee, which is where a
 *    rifle bullet spends the interesting part of a 300-500 m shot, did not exist
 *    at all. The curve now comes from the G7 standard drag function scaled by
 *    each bullet's published form factor; see game/ballistics/cartridges.js.
 *
 * 2. DAMAGE FOLLOWS ENERGY.
 *    `dropoff` was a fudge factor: damage decayed with a hand-picked quadratic in
 *    range. Now the round carries kinetic energy, energy falls out of the drag
 *    integration for free, and damage at the target is the energy that arrives
 *    times the fraction of it the bullet actually deposits (an FMJ that exits
 *    deposits far less than a hollow point that stops). A pistol round is weak at
 *    80 m because it genuinely has 320 J left, not because a curve says so.
 *
 * 3. WIND EXISTS.
 *    Drag acts on velocity RELATIVE TO THE AIR, so a crosswind pushes the round
 *    sideways by itself — there is no separate "wind force" term to invent. At
 *    5 m/s across a 400 m shot that is roughly a torso width, which is the point
 *    at which a marksman has to think about it.
 *
 * 4. RICOCHETS.
 *    A round striking a hard surface at a shallow angle does not stop and does not
 *    punch through: it skips. Handled here rather than in the penetration solver
 *    because a ricochet keeps flying and therefore stays a projectile.
 *
 * Legacy callers that pass `dragK` and `dropoff` and no cartridge still work
 * exactly as before — the old path is preserved, not emulated.
 */

const MAX_LIVE = 128;
/** Rounds slower than this have no useful energy left; retire them. */
const MIN_SPEED = 40;
/**
 * Below this angle to the SURFACE a hard material skips the round instead of
 * taking it. Steel and concrete skip readily, wood and drywall do not.
 */
const RICOCHET_ANGLE = {
  concrete: 0.28, // ~16 deg
  brick: 0.24,
  metal: 0.36, // ~21 deg: steel is the classic skipper
  stone: 0.30,
  asphalt: 0.26,
  tile: 0.26,
  glass: 0.12,
  wood: 0.10,
  drywall: 0.0,
  plaster: 0.06,
  sand: 0.14,
  dirt: 0.12,
  water: 0.40,
  flesh: 0.0,
  cloth: 0.0,
};
const DEFAULT_RICOCHET = 0.16;
/** Fraction of speed kept through a skip. */
const RICOCHET_RETAIN = 0.62;
/** A round that has skipped this many times is retired to bound the work. */
const MAX_RICOCHETS = 2;

class Projectile {
  constructor() {
    this.alive = false;
    this.pos = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.dir = new THREE.Vector3();

    /** Cartridge definition, or null for the legacy path. */
    this.cart = null;
    /** Legacy linear-drag coefficient, used only when `cart` is null. */
    this.dragK = 0.3;
    /** Legacy damage model. */
    this.damage = 30;
    this.dropoff = 0.5;

    this.penetration = 1;
    this.travelled = 0;
    this.maxRange = 400;
    this.age = 0;
    this.weapon = null;
    this.mask = undefined;
    this.ricochets = 0;
    /** Energy at the muzzle, J — the reference damage is scaled against. */
    this.energy0 = 0;
    /** Damage the shot would do at the muzzle, for the energy model. */
    this.damage0 = 0;
  }
}

export class ProjectileSim {
  constructor(ctx) {
    this.ctx = ctx;
    this.pool = [];
    for (let i = 0; i < MAX_LIVE; i++) this.pool.push(new Projectile());
    this.live = [];

    this._seg = new THREE.Vector3();
    this._hitDir = new THREE.Vector3();
    this._rel = new THREE.Vector3();
    this._normal = new THREE.Vector3();
    this._tracerFrom = new THREE.Vector3();
    this._tracerTo = new THREE.Vector3();
    this._tracerPayload = { from: this._tracerFrom, to: this._tracerTo, speed: 800, weapon: null };

    /**
     * Air the rounds fly through. The world or a weather system may write to
     * these; nothing has to, and the defaults are the sea-level reference the
     * published ballistic tables are computed at.
     */
    this.air = { rho: RHO_0, mach1: MACH_1 };
    this.wind = new THREE.Vector3(0, 0, 0);

    this.stats = { fired: 0, impacts: 0, live: 0, ricochets: 0 };
  }

  get physics() {
    if (!this._physics) this._physics = this.ctx.peek('physics');
    return this._physics;
  }

  /**
   * Set the wind the rounds actually fly through, m/s in world space.
   *
   * Vertical component included on purpose: a thermal rising off a hot street is
   * a real effect at long range and costs nothing to carry.
   */
  setWind(x, y, z) {
    this.wind.set(x, y, z);
  }

  setAir({ rho, mach1 } = {}) {
    if (typeof rho === 'number') this.air.rho = rho;
    if (typeof mach1 === 'number') this.air.mach1 = mach1;
  }

  /**
   * @param {object} o
   *   origin, dir (unit), speed
   *   cartridge    CartridgeDef — the modern path; enables the energy model
   *   damage       damage at the muzzle
   *   penetration, maxRange, weapon, tracer, mask
   *   dragK, dropoff   legacy path, used only when `cartridge` is absent
   */
  spawn(o) {
    let p = null;
    for (let i = 0; i < this.pool.length; i++) {
      if (!this.pool[i].alive) {
        p = this.pool[i];
        break;
      }
    }
    if (!p) {
      // Oldest round yields its slot rather than dropping the shot: a dropped
      // shot is a bug the player feels, a truncated tracer is not.
      p = this.live[0];
      if (!p) return null;
      this._retire(p);
      this.live.shift();
    }
    const speed = o.speed ?? 800;
    p.alive = true;
    p.pos.copy(o.origin);
    p.prev.copy(o.origin);
    p.dir.copy(o.dir).normalize();
    p.vel.copy(p.dir).multiplyScalar(speed);

    p.cart = o.cartridge ?? null;
    p.dragK = o.dragK ?? 0.3;
    p.damage = o.damage ?? 30;
    p.damage0 = p.damage;
    p.dropoff = o.dropoff ?? 0.5;
    p.penetration = o.penetration ?? p.cart?.penetration ?? 1;
    p.maxRange = o.maxRange ?? 400;
    p.travelled = 0;
    p.age = 0;
    p.ricochets = 0;
    p.weapon = o.weapon ?? null;
    p.mask = o.mask;
    p.energy0 = p.cart ? kineticEnergy(p.cart, speed) : 0;

    this.live.push(p);
    this.stats.fired++;

    if (o.tracer) this._emitTracer(p, speed);
    return p;
  }

  /** One tracer per burst of rounds: muzzle to wherever the round will land. */
  _emitTracer(p, speed) {
    const phys = this.physics;
    this._tracerFrom.copy(p.pos);
    let dist = Math.min(p.maxRange, 260);
    if (phys) {
      const hit = phys.raycast(p.pos, p.dir, dist, phys.MASK?.BULLET);
      if (hit?.hit) dist = hit.distance;
    }
    this._tracerTo.copy(p.pos).addScaledVector(p.dir, dist);
    this._tracerPayload.speed = speed;
    this._tracerPayload.weapon = p.weapon;
    this.ctx.events.emit('bullet:tracer', this._tracerPayload);
  }

  /**
   * Damage this round would deal on contact, given how far it has flown.
   *
   * Two models, and which one is used depends on whether the shot came with a
   * cartridge:
   *
   *   energy   damage scales with the energy still in the round relative to the
   *            muzzle, times the fraction that bullet type deposits rather than
   *            carries out the far side. Nothing is tuned per distance.
   *   legacy   the old quadratic falloff towards `dropoff` at max range, kept so
   *            any caller that has not been converted behaves exactly as before.
   */
  _damageAt(p, speed) {
    if (!p.cart || p.energy0 <= 0) {
      const range01 = Math.min(1, p.travelled / p.maxRange);
      return p.damage * (1 - (1 - p.dropoff) * range01 * range01);
    }
    const e = kineticEnergy(p.cart, speed);
    // The transfer fraction is a property of the bullet, and it is already
    // baked into the muzzle-damage figure the weapon declares — so what is left
    // to apply here is purely the energy ratio. Applying `transfer` twice was the
    // obvious mistake to make and would have halved every rifle.
    return p.damage0 * Math.min(1, e / p.energy0);
  }

  /**
   * Should this contact skip instead of biting?
   *
   * The test is the angle between the round's path and the SURFACE (not the
   * normal), because that is how the physical threshold is expressed. Anything
   * steeper than the material's critical angle digs in and is handed to the
   * penetration solver as before.
   */
  _ricochets(p, surface, incidenceToSurface, speed) {
    if (p.ricochets >= MAX_RICOCHETS) return false;
    // Slow rounds do not skip, they stick. 180 m/s is roughly where a pistol
    // bullet stops behaving elastically against masonry.
    if (speed < 180) return false;
    const limit = RICOCHET_ANGLE[surface] ?? DEFAULT_RICOCHET;
    if (limit <= 0) return false;
    return incidenceToSurface < limit;
  }

  fixedUpdate(h) {
    const phys = this.physics;
    const { rho, mach1 } = this.air;

    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.prev.copy(p.pos);

      // ---- forces -------------------------------------------------------
      // Drag acts on velocity relative to the AIR. That single detail is what
      // makes a crosswind push the round sideways without any extra term: the
      // relative-velocity vector is tilted, so the drag that opposes it has a
      // lateral component.
      this._rel.copy(p.vel).sub(this.wind);
      const relSpeed = this._rel.length();

      if (relSpeed > 1e-3) {
        let decel;
        if (p.cart) {
          decel = dragDecel(p.cart, relSpeed, rho, mach1);
        } else {
          // Legacy linear term, expressed as an acceleration so both paths share
          // the same integrator.
          decel = p.dragK * relSpeed;
        }
        const k = -decel / relSpeed;
        p.vel.addScaledVector(this._rel, k * h);
      }
      p.vel.y += GRAVITY * h;

      p.pos.addScaledVector(p.vel, h);
      p.age += h;

      this._seg.copy(p.pos).sub(p.prev);
      const segLen = this._seg.length();
      p.travelled += segLen;

      // ---- contact ------------------------------------------------------
      if (segLen > 1e-6 && phys) {
        this._hitDir.copy(this._seg).divideScalar(segLen);
        const hit = phys.raycast(p.prev, this._hitDir, segLen, phys.MASK?.BULLET);
        if (hit?.hit) {
          const speed = p.vel.length();
          const surface = hit.surface ?? phys.surfaceName?.(hit.surfaceIndex) ?? 'concrete';

          // Angle between the path and the surface plane. dot with the normal
          // gives the angle to the normal; the complement is what we want, and
          // asin of the absolute dot is that complement directly.
          this._normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
          const cosToNormal = Math.abs(this._hitDir.dot(this._normal));
          const toSurface = Math.asin(Math.min(1, cosToNormal));

          if (this._ricochets(p, surface, toSurface, speed)) {
            // Reflect, bleed energy, and add a little scatter — a skip off a
            // rough surface is not a mirror. Scatter comes from ctx.rng so a
            // capture reproduces exactly.
            p.pos.copy(hit.point).addScaledVector(this._normal, 0.01);
            p.prev.copy(p.pos);
            p.vel.reflect(this._normal).multiplyScalar(RICOCHET_RETAIN);
            const rng = this.ctx.rng;
            if (rng?.signed) {
              const jitter = 0.06;
              p.vel.x += rng.signed() * jitter * speed * RICOCHET_RETAIN;
              p.vel.y += rng.signed() * jitter * speed * RICOCHET_RETAIN;
              p.vel.z += rng.signed() * jitter * speed * RICOCHET_RETAIN;
            }
            p.dir.copy(p.vel).normalize();
            p.ricochets++;
            this.stats.ricochets++;

            // Still announce the strike: the mark, the spark and the whine are
            // the whole reason a ricochet is worth simulating.
            phys.emitImpact?.(
              hit.point.x, hit.point.y, hit.point.z,
              hit.normal.x, hit.normal.y, hit.normal.z,
              this._hitDir.x, this._hitDir.y, this._hitDir.z,
              hit.surfaceIndex, this._damageAt(p, speed) * 0.15, false, hit,
            );
            this.ctx.events.emit('bullet:ricochet', {
              point: hit.point,
              normal: hit.normal,
              speed,
              surface,
              weapon: p.weapon,
            });
            continue;
          }

          // Contact: hand the round to the penetration solver, which emits
          // `bullet:impact` for every entry and exit face it goes through.
          phys.fireBullet({
            origin: p.prev,
            dir: this._hitDir,
            maxDist: Math.min(24, Math.max(1.5, p.maxRange - p.travelled + segLen)),
            damage: this._damageAt(p, speed),
            penetration: p.penetration,
            // Damage attenuation with distance already happened above, via the
            // energy the round has left. Telling the solver to attenuate again
            // would apply the falloff twice.
            dropoff: 1,
            mask: p.mask,
          });
          this.stats.impacts++;
          this._retire(p);
          this.live.splice(i, 1);
          continue;
        }
      }

      // ---- retirement ---------------------------------------------------
      if (
        p.travelled > p.maxRange ||
        p.age > 6 ||
        p.pos.y < -80 ||
        p.vel.lengthSq() < MIN_SPEED * MIN_SPEED
      ) {
        this._retire(p);
        this.live.splice(i, 1);
      }
    }
    this.stats.live = this.live.length;
  }

  _retire(p) {
    p.alive = false;
    p.weapon = null;
    p.cart = null;
  }

  clear() {
    for (const p of this.live) this._retire(p);
    this.live.length = 0;
  }
}
