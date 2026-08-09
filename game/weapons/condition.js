/**
 * WEAPON CONDITION — heat, wear, and the cycle it feeds.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS MISSING
 * ---------------------------------------------------------------------------
 * The fire path was stateless between magazines. `tryFire()` set a rate-limit
 * timer, added a spread cone and moved on, so the thirtieth round of a held
 * trigger was mechanically identical to the first apart from the recoil pattern.
 * That is the whole reason sustained automatic fire in this game had no cost:
 * there was nothing that got worse.
 *
 * Two quantities fix that, and they are deliberately different in KIND:
 *
 *   HEAT   fast, recoverable, and about right now. It builds over a burst and
 *          bleeds away in seconds. It is what makes a player let go of the
 *          trigger.
 *   WEAR   slow, persistent for the whole match, and about the weapon rather
 *          than the moment. It is what makes a player reload from the bench
 *          rather than run the same barrel all game.
 *
 * If they were one number, the mechanic would be either a stutter (fast) or
 * invisible (slow). Two is the minimum that gives both a moment-to-moment
 * decision and a match-long one.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE NUMBERS COME FROM
 * ---------------------------------------------------------------------------
 * A rifle barrel's continuous-fire limit is roughly 150-200 rounds before the
 * point where accuracy visibly degrades and the barrel starts to glow; sustained
 * doctrine for a section weapon is on the order of a magazine a minute. So:
 *
 *   heatPerShot = 1 / 90         one full magazine of continuous fire lands
 *                                around a third of the scale
 *   heatCool    = 0.22 / s       ~4.5 s from full to cold, hands-off
 *
 * The CONSEQUENCES are chosen to be honest about what heat actually does. It does
 * NOT reduce damage — that is a video-game fiction and it makes weapons feel
 * broken. What a hot barrel really costs is precision and cadence:
 *
 *   spread    up to +140%, because a hot barrel walks
 *   cadence   down to 94%, because the action is dragging
 *   sway      up 35%, because your hands are working harder
 *   mirage    a visible shimmer over the barrel, which is the honest tell
 *
 * Wear is the same idea over a longer clock: a fouled chamber and a worn crown
 * cost accuracy, reload smoothness, and — at the extreme — reliability. A JAM is
 * the one hard consequence in the file, and it exists because a weapon that can
 * never fail has no reason to be maintained.
 *
 * ---------------------------------------------------------------------------
 * PURE, ON PURPOSE
 * ---------------------------------------------------------------------------
 * No three.js, no ctx, no events. `WeaponCondition` is a plain object the weapon
 * system owns per weapon, so the whole curve is exercised in node by
 * tools/verify-condition.mjs. That matters more here than almost anywhere else,
 * because heat and wear are exactly the sort of thing where a sign error is
 * invisible for a week and then someone reports "the gun gets BETTER as it heats".
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const HEAT = {
  /** Fraction of the scale added per shot, before the weapon's own mass scaling. */
  perShot: 1 / 75,
  /** Fraction shed per second while not firing. */
  cool: 0.2,
  /**
   * Cooling is slower for the first moment after a burst, because the barrel is
   * still soaking heat out of the chamber. Without this, tapping the trigger in
   * two-round bursts would be thermally free, which is the exact exploit heat is
   * meant to price.
   */
  soakTime: 0.9,
  soakScale: 0.25,

  /**
   * Where the consequences begin. Below this, heat is invisible.
   *
   * 0.22, not 0.35, and the gate is what moved it. At 0.35 a full magazine of
   * continuous fire ended at 0.17 heat and a spread multiplier of exactly 1.00 —
   * i.e. the entire mechanic was unreachable in normal play, because nobody fires
   * two magazines without stopping. The pair (perShot, onset) has to be chosen
   * together against one question: does dumping ONE magazine start to bloom the
   * cone? It now does, gently (x1.06), and two magazines back to back are
   * genuinely bad (x1.5).
   */
  onset: 0.22,
  /** Multipliers at heat = 1, interpolated from `onset`. */
  spreadMul: 2.4,
  cadenceMul: 0.94,
  swayMul: 1.35,
  /** Above this the HUD warns; the player has to be able to see it coming. */
  warn: 0.7,
};

export const WEAR = {
  /** Fraction of the scale added per shot fired. 6000 rounds to fully worn. */
  perShot: 1 / 6000,
  /**
   * Heat accelerates wear, which is the link between the two quantities and the
   * reason they are not independent: abusing the barrel today costs you the whole
   * match, not just the next four seconds.
   */
  heatFactor: 2.5,

  onset: 0.25,
  spreadMul: 1.45,
  reloadMul: 1.12,
  /**
   * Chance per shot of a malfunction, at wear = 1. 1.2% is chosen to be felt over
   * a magazine and not over a burst: with a 30-round magazine that is a ~30%
   * chance of a stoppage somewhere in it at full wear, and effectively zero below
   * `jamOnset`.
   */
  jamChance: 0.012,
  jamOnset: 0.45,
  /** Clearing a stoppage costs this long, and cannot be cancelled. */
  clearTime: 1.35,
};

/**
 * One weapon's condition.
 *
 * Owned per weapon rather than per player, because the state belongs to the
 * OBJECT: switching to your pistol has to let the rifle cool, and coming back to
 * a rifle you emptied has to find it still hot. A per-player scalar would make
 * weapon switching a free coolant.
 */
export class WeaponCondition {
  /**
   * @param {object} [o]
   * @param {number} [o.mass]  weapon mass in kg; heavier barrels soak more heat
   * @param {number} [o.rpm]   cadence, used only for the doc string below
   */
  constructor(o = {}) {
    /** 0..1 */
    this.heat = 0;
    /** 0..1, monotonic within a match */
    this.wear = 0;
    /** Seconds since the last shot. Drives the soak delay. */
    this.since = 999;
    /** > 0 while a stoppage is being cleared. */
    this.jam = 0;
    /**
     * A heavier weapon has more steel to soak the same energy, so it heats more
     * slowly for the same cadence. 3.5 kg is the reference (a service carbine),
     * and the exponent is deliberately gentle: an СВД at 4.3 kg heats about 20%
     * slower than an MP5 at 2.5 kg, not twice as slowly. The exponent was 0.6
     * until the gate measured what that actually produced over a magazine — 1.87x
     * between those two weapons, once the cooling term is included, which is far
     * more than mass should decide. 0.4 lands it at about 1.4x.
     */
    this.massScale = (3.5 / Math.max(0.9, o.mass ?? 3.5)) ** 0.4;
  }

  /** Fire one round. Returns true if the weapon jammed on this shot. */
  shoot(rand = Math.random) {
    this.heat = clamp01(this.heat + HEAT.perShot * this.massScale);
    this.wear = clamp01(this.wear + WEAR.perShot * (1 + this.heat * WEAR.heatFactor));
    this.since = 0;
    if (this.wear > WEAR.jamOnset) {
      const t = (this.wear - WEAR.jamOnset) / (1 - WEAR.jamOnset);
      if (rand() < WEAR.jamChance * t) {
        this.jam = WEAR.clearTime;
        return true;
      }
    }
    return false;
  }

  /** @param {number} dt seconds */
  update(dt) {
    /**
     * Soak is read BEFORE the clock advances, and that ordering is the whole
     * mechanic.
     *
     * Reading it after meant a single 0.8 s step taken 0.1 s after a burst was
     * charged the FULL cooling rate, because `since` had already crossed the soak
     * window by the time the branch ran. Measured by the gate: five-round bursts
     * with 0.8 s between them ended at zero heat while continuous fire reached
     * 0.34, i.e. burst-tapping was not merely cheaper, it was thermally free —
     * the exact exploit the soak window exists to price.
     *
     * Sampling the state at the start of the interval is also the honest
     * integration: heat cannot cool at a rate the barrel has not reached yet.
     */
    const soak = this.since < HEAT.soakTime ? HEAT.soakScale : 1;
    this.since += dt;
    if (this.jam > 0) this.jam = Math.max(0, this.jam - dt);
    if (this.heat <= 0) return;
    this.heat = Math.max(0, this.heat - HEAT.cool * soak * dt);
  }

  /** Reset for a fresh match. Wear survives a reload; it does not survive a spawn. */
  reset({ wear = true } = {}) {
    this.heat = 0;
    this.jam = 0;
    this.since = 999;
    if (wear) this.wear = 0;
  }

  /** 0..1 above the onset, which is what every consequence is scaled by. */
  get heatEffect() {
    return clamp01((this.heat - HEAT.onset) / (1 - HEAT.onset));
  }

  get wearEffect() {
    return clamp01((this.wear - WEAR.onset) / (1 - WEAR.onset));
  }

  get jammed() {
    return this.jam > 0;
  }

  /**
   * The multipliers the weapon system applies. One object, computed on demand and
   * NOT cached: it is four multiplies, and a stale condition would be far worse
   * than the arithmetic.
   */
  get modifiers() {
    const h = this.heatEffect;
    const w = this.wearEffect;
    return {
      /** Multiplies the live spread cone. */
      spread: 1 + (HEAT.spreadMul - 1) * h + (WEAR.spreadMul - 1) * w,
      /** Multiplies the interval between shots — below 1 would be FASTER. */
      cadence: 1 + (1 / HEAT.cadenceMul - 1) * h,
      /** Multiplies breathing sway amplitude. */
      sway: 1 + (HEAT.swayMul - 1) * h,
      /** Multiplies reload duration. */
      reload: 1 + (WEAR.reloadMul - 1) * w,
      /** 0..1, for the barrel-mirage shimmer and the HUD bar. */
      mirage: h,
      warn: this.heat >= HEAT.warn,
    };
  }
}
