/**
 * Carried load and stamina.
 *
 * Two things the movement system did not model, both of which the rest of the
 * project already had the data for:
 *
 * STAMINA. Sprint was free and infinite. `_updateSprint` gated on stance, ADS
 * and stick direction, and on nothing else — you could hold sprint from spawn to
 * the end of a match. There was no `stamina` anywhere in the codebase.
 *
 * WEIGHT. Every weapon in arsenal/defs.js carries a real `weight` in kilograms
 * (3.3 for an AK-74, 4.3 for an SVD), and `recoilFrom()` used it for spring
 * frequency and damping. Movement never read it, so an SVD and a Glock ran at
 * exactly the same speed and tired the player at exactly the same rate.
 *
 * This file is pure arithmetic — no three.js, no ctx, no side effects — so the
 * whole stamina curve and every load figure is checkable in node.
 *
 * REFERENCE FIGURES. The baseline is a 3.5 kg carbine with two spare magazines,
 * which is the load the existing speeds in tuning.js were tuned against. That
 * matters: the scale below must return exactly 1.0 for the reference load, or
 * this change would silently retune every speed in the game.
 */

/** The load the existing movement speeds were balanced at, in kilograms. */
export const REFERENCE_LOAD = 4.6;

export const STAMINA = {
  max: 100,

  /**
   * Sprint costs. A fit soldier under load holds a hard run for well under a
   * minute; 12/s gives about 8 s of sprint from full, which is roughly 55 m —
   * long enough to cross a street, short enough that you think about when.
   */
  sprintDrain: 12,
  /** Tactical sprint is the all-out one, so it costs about twice as much. */
  tacSprintDrain: 21,

  /** One-off costs. A slide is cheap; a jump under load is not. */
  slideCost: 9,
  jumpCost: 7,
  mantleCost: 11,

  /** Recovery only begins after a breath, then ramps rather than stepping. */
  regenDelay: 0.7,
  regenRate: 16,
  regenRamp: 1.2,
  /** Standing still recovers faster than walking it off. */
  restBonus: 1.55,
  /** Crouching and prone let the diaphragm work; a real and useful choice. */
  crouchBonus: 1.25,

  /**
   * Once emptied you are winded: sprint stays locked until this fraction is back.
   * Without a hysteresis band the player stutters in and out of sprint one frame
   * at a time at zero, which reads as a bug rather than as exhaustion.
   */
  exhaustedRecovery: 0.3,

  /** Below this fraction, breathing sway and weapon settle degrade. */
  fatigueThreshold: 0.35,
};

export const LOAD = {
  /**
   * Speed penalty per kilogram over the reference load. 0.035 means the heaviest
   * weapon in the roster (a 4.3 kg SVD) runs about 3 % slower than the lightest
   * rifle — small, but it is the difference between winning and losing a corner,
   * and it is the right order of magnitude for a kilogram on a loaded soldier.
   */
  speedPerKg: 0.035,
  /** Never let load alone take more than this much speed away. */
  maxSpeedPenalty: 0.14,

  /** Heavier kit empties the tank faster, on the same per-kilogram basis. */
  drainPerKg: 0.09,
  maxDrainBonus: 0.55,

  /** Bringing a heavy weapon up to the eye takes longer. */
  adsPerKg: 0.055,
  maxAdsPenalty: 0.3,

  /** Magazine masses, loaded, in kilograms. Used when summing a loadout. */
  magKg: { rifle: 0.52, smg: 0.42, shotgun: 0.06, pistol: 0.28, dmr: 0.62 },
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Total carried mass for a loadout, in kilograms.
 *
 * @param {object} o
 * @param {number} o.weaponKg     primary weapon, dry
 * @param {number} [o.sidearmKg]  carried sidearm, dry
 * @param {number} [o.attachKg]   fitted attachments
 * @param {number} [o.mags]       spare magazines for the primary
 * @param {string} [o.magClass]   key into LOAD.magKg
 * @param {number} [o.extraKg]    grenades, plates, anything else
 */
export function carriedLoad(o) {
  const magKg = LOAD.magKg[o.magClass ?? 'rifle'] ?? LOAD.magKg.rifle;
  return (
    (o.weaponKg ?? REFERENCE_LOAD) +
    (o.sidearmKg ?? 0) +
    (o.attachKg ?? 0) +
    (o.mags ?? 2) * magKg +
    (o.extraKg ?? 0)
  );
}

/** Kilograms over (or under) the reference load. Negative for a light kit. */
export function loadExcess(totalKg) {
  return totalKg - REFERENCE_LOAD;
}

/**
 * Movement speed multiplier for a carried mass. Exactly 1 at the reference load,
 * and allowed above 1 for a pistol-only kit — a lighter soldier really is
 * faster, and capping it at 1 would make every weapon choice a pure downside.
 */
export function loadSpeedScale(totalKg) {
  const excess = loadExcess(totalKg);
  const raw = -excess * LOAD.speedPerKg;
  const limited = Math.max(-LOAD.maxSpeedPenalty, Math.min(LOAD.maxSpeedPenalty * 0.5, raw));
  return 1 + limited;
}

/** Stamina drain multiplier for a carried mass. Never below 1 of the base rate. */
export function loadDrainScale(totalKg) {
  const excess = Math.max(0, loadExcess(totalKg));
  return 1 + Math.min(LOAD.maxDrainBonus, excess * LOAD.drainPerKg);
}

/** ADS time multiplier: heavier weapons come up slower. */
export function loadAdsScale(totalKg) {
  const excess = Math.max(0, loadExcess(totalKg));
  return 1 + Math.min(LOAD.maxAdsPenalty, excess * LOAD.adsPerKg);
}

/**
 * The stamina pool.
 *
 * Deliberately not an ECS system: movement needs to ask "may I sprint" inside
 * its fixed step, before it has computed a speed, and an event round-trip would
 * put that answer a frame late. So it is a plain object movement owns.
 */
export class Stamina {
  constructor() {
    this.max = STAMINA.max;
    this.value = STAMINA.max;
    /** True from the moment the pool empties until `exhaustedRecovery` is back. */
    this.exhausted = false;
    /** Seconds since the last drain, used to gate regeneration. */
    this.sinceDrain = 999;
    /** Carried mass, in kilograms. Set by the player system from the loadout. */
    this.loadKg = REFERENCE_LOAD;
  }

  get fraction() {
    return clamp01(this.value / this.max);
  }

  /** 0 when fresh, rising to 1 as the pool approaches empty. Drives sway. */
  get fatigue() {
    const f = this.fraction;
    if (f >= STAMINA.fatigueThreshold) return 0;
    return clamp01((STAMINA.fatigueThreshold - f) / STAMINA.fatigueThreshold);
  }

  get speedScale() {
    return loadSpeedScale(this.loadKg);
  }

  get adsScale() {
    return loadAdsScale(this.loadKg);
  }

  reset() {
    this.value = this.max;
    this.exhausted = false;
    this.sinceDrain = 999;
  }

  /** May the player start or continue a sprint right now? */
  canSprint() {
    return !this.exhausted && this.value > 0;
  }

  /** Spend a one-off cost. Returns false if there was not enough to spend. */
  spend(amount, { allowPartial = true } = {}) {
    if (amount <= 0) return true;
    if (!allowPartial && this.value < amount) return false;
    this.value = Math.max(0, this.value - amount);
    this.sinceDrain = 0;
    if (this.value <= 0) this.exhausted = true;
    return true;
  }

  /**
   * Advance one step.
   *
   * @param {number} dt
   * @param {object} s  { sprinting, tacticalSprint, stance, moving }
   */
  update(dt, s = {}) {
    const drainScale = loadDrainScale(this.loadKg);

    if (s.sprinting) {
      const rate = (s.tacticalSprint ? STAMINA.tacSprintDrain : STAMINA.sprintDrain) * drainScale;
      this.value = Math.max(0, this.value - rate * dt);
      this.sinceDrain = 0;
      if (this.value <= 0) this.exhausted = true;
    } else {
      this.sinceDrain += dt;
      if (this.value < this.max && this.sinceDrain > STAMINA.regenDelay) {
        // Ramp in, so recovery has a shape instead of snapping on — the same
        // treatment health.js gives regeneration, for the same reason.
        const ramp = clamp01((this.sinceDrain - STAMINA.regenDelay) / STAMINA.regenRamp);
        let rate = STAMINA.regenRate * ramp;
        if (!s.moving) rate *= STAMINA.restBonus;
        if (s.stance === 'crouch' || s.stance === 'prone') rate *= STAMINA.crouchBonus;
        this.value = Math.min(this.max, this.value + rate * dt);
      }
    }

    // Leave the winded state only once there is a usable amount back, so sprint
    // cannot flicker on for single frames at the bottom of the pool.
    if (this.exhausted && this.fraction >= STAMINA.exhaustedRecovery) this.exhausted = false;
  }
}
