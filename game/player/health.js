/**
 * Health, regeneration, suppression and the damage-direction model.
 *
 * Behaviour matches the CoD contract: no health pickups, a delay after the last
 * hit, then a fast refill. Damage arriving from a direction produces an
 * indicator (angle in *view* space, so the HUD can draw it without knowing
 * anything about the player's transform) and a matching camera impulse, so a hit
 * is felt before it is read.
 *
 * Suppression is a separate 0..1 pool fed by near misses, hits and blasts. It
 * widens the breathing sway and adds a little shake — the same trick CoD uses to
 * make being shot at feel dangerous without taking control away.
 */

import * as THREE from 'three';
import { HEALTH, ARMOUR } from './tuning.js';
import { clamp01, approach, lerp, DEG } from './springs.js';

export class Health {
  constructor(ctx, rig) {
    this.ctx = ctx;
    this.rig = rig;
    this.max = HEALTH.max;
    this.value = HEALTH.max;
    this.dead = false;
    this.regenerating = false;
    this.lastDamageTime = -100;
    this.suppression = 0;
    /** 0..1 disorientation from being hit hard. See HEALTH.shock. */
    this.shock = 0;
    this.hitFlash = 0;

    /**
     * Body armour. Damage always eats into the outermost intact plate, so the
     * HUD's three segments drain in the order they are drawn.
     */
    this.maxArmour = ARMOUR.plates * ARMOUR.perPlate;
    this.armour = this.maxArmour;

    /**
     * Open wounds. Preallocated like the indicators below, because this pool is
     * touched every frame and must not allocate mid-match.
     */
    this.wounds = [];
    for (let i = 0; i < HEALTH.bleed.maxStacks; i++) {
      this.wounds.push({ active: false, life: 0, scale: 1 });
    }

    /** Direction indicators, oldest first. angle is radians, 0 = straight ahead. */
    this.indicators = [];
    for (let i = 0; i < HEALTH.indicatorMax; i++) {
      this.indicators.push({ active: false, angle: 0, amount: 0, life: 0, worldX: 0, worldY: 0, worldZ: 0 });
    }

    // Heartbeat: phase 0..1 per beat, with a double-thump envelope.
    this.beatPhase = 0;
    this.pulse = 0;
    this.effect = 0; // 0..1 overall low-health treatment weight

    this._payload = {
      amount: 0, from: new THREE.Vector3(), health: 0, direction: 0,
      critical: false, armour: false, armourLeft: 0,
      wounded: false, bleedStacks: 0,
    };
    this._statePayload = {
      health: HEALTH.max, fraction: 1, low: false, critical: false,
      regenerating: false, suppression: 0, shock: 0, dead: false,
      armour: ARMOUR.plates * ARMOUR.perPlate,
      maxArmour: ARMOUR.plates * ARMOUR.perPlate,
      bleeding: false, bleedStacks: 0,
    };
    this._emitTimer = 0;
    this._lastEmitHealth = HEALTH.max;
    this._beat = { strength: 0, fraction: 1 };
  }

  get fraction() {
    return clamp01(this.value / this.max);
  }

  get low() {
    return this.fraction < HEALTH.lowThreshold;
  }

  get critical() {
    return this.fraction < HEALTH.criticalThreshold;
  }

  /** Number of open wounds. */
  get bleedStacks() {
    let n = 0;
    for (let i = 0; i < this.wounds.length; i++) if (this.wounds[i].active) n++;
    return n;
  }

  get bleeding() {
    return this.bleedStacks > 0;
  }

  /** Current HP drain per second from all open wounds together. */
  get bleedRate() {
    let r = 0;
    for (let i = 0; i < this.wounds.length; i++) {
      const w = this.wounds[i];
      if (w.active) r += HEALTH.bleed.ratePerStack * w.scale;
    }
    return r;
  }

  /**
   * Open a wound, if there is a free slot. Re-wounding while already at the cap
   * refreshes the youngest wound instead of being silently dropped, so sustained
   * fire keeps the bleed alive without letting it exceed maxStacks.
   */
  _openWound(part) {
    const scale = HEALTH.bleed.zoneScale[part] ?? 1;
    for (let i = 0; i < this.wounds.length; i++) {
      const w = this.wounds[i];
      if (!w.active) {
        w.active = true;
        w.life = 0;
        w.scale = scale;
        return true;
      }
    }
    // At the cap: refresh whichever wound is closest to clotting.
    let youngest = null;
    for (let i = 0; i < this.wounds.length; i++) {
      const w = this.wounds[i];
      if (!youngest || w.life > youngest.life) youngest = w;
    }
    if (youngest) {
      youngest.life = 0;
      youngest.scale = Math.max(youngest.scale, scale);
    }
    return false;
  }

  reset(full = true) {
    if (full) this.value = this.max;
    if (full) this.armour = this.maxArmour;
    this.dead = false;
    this.suppression = 0;
    this.shock = 0;
    this.hitFlash = 0;
    this.lastDamageTime = -100;
    for (let k = 0; k < this.indicators.length; k++) this.indicators[k].active = false;
    // A respawn must not inherit the wounds that killed you.
    for (let k = 0; k < this.wounds.length; k++) this.wounds[k].active = false;
  }

  /* ==================================================================== */

  /**
   * @param {number} amount
   * @param {THREE.Vector3|null} from  world position of the attacker/blast
   * @param {object} opts { yaw, type, suppress }
   */
  damage(amount, from, opts = {}) {
    if (this.dead || amount <= 0) return 0;

    // ---- armour --------------------------------------------------------
    // Plates cover the torso only, so a headshot is never soaked. `absorb` is
    // the share a plate takes, so some damage always bleeds through and armour
    // buys time instead of immunity. High-penetration rounds bypass a growing
    // share of the plate, which is what separates a rifle from a pistol against
    // an armoured target. Falls and other typeless damage ignore armour.
    let incoming = amount;
    let hitArmour = false;
    const cover = opts.type === 'fall' ? 0 : (ARMOUR.covers[opts.part ?? 'torso'] ?? 0);
    if (this.armour > 0 && cover > 0 && incoming > 0) {
      const pen = Math.max(0, (opts.penetration ?? 1) - ARMOUR.penetrationFloor);
      const bypass = clamp01(pen * ARMOUR.penetrationBypass);
      // Share the plate is willing to take, after cover and penetration.
      const share = ARMOUR.absorb * cover * (1 - bypass);
      const wanted = incoming * share;
      const taken = Math.min(this.armour, wanted);
      this.armour -= taken;
      incoming -= taken;
      hitArmour = taken > 0;
    }

    const before = this.value;
    this.value = Math.max(0, this.value - incoming);
    this.lastDamageTime = this.ctx.time.elapsed;
    this.regenerating = false;
    const dealt = before - this.value;

    // ---- wounds ---------------------------------------------------------
    // Threshold is on the POST-armour figure, so a plate that soaks a hit also
    // stops the wound — which is most of the reason to wear one.
    let wounded = false;
    if (!this.dead && dealt >= HEALTH.bleed.threshold) {
      wounded = this._openWound(opts.part ?? 'torso');
    }

    // ---- direction in view space ---------------------------------------
    let angle = 0;
    if (from) {
      const yaw = opts.yaw ?? this.ctx.camera.rotation.y;
      const dx = from.x - this.ctx.camera.position.x;
      const dz = from.z - this.ctx.camera.position.z;
      // Forward at yaw is (-sin, -cos); right is (cos, -sin).
      const f = -Math.sin(yaw) * dx - Math.cos(yaw) * dz;
      const r = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
      angle = Math.atan2(r, f);
      // Full amount, for the same reason as severity above — a plated hit must
      // still raise a direction indicator.
      this._pushIndicator(angle, amount, from);
    }

    // ---- felt response --------------------------------------------------
    // Severity comes from the FULL incoming hit, not the post-armour figure: a
    // round stopped by a plate still has to be felt, or armour would read as
    // simply not being shot at.
    const severity = clamp01(amount / 45);
    this.hitFlash = clamp01(this.hitFlash + HEALTH.effect.hitFlash * (0.4 + severity));
    this.addSuppression(HEALTH.suppression.perHit * (0.5 + severity));

    // Shock keys off the POST-armour figure, unlike severity above: a plate that
    // stops a round has to be felt, but it should not leave you disoriented —
    // that is the difference between being shot and being shot THROUGH.
    if (dealt >= HEALTH.shock.threshold) {
      const S = HEALTH.shock;
      this.shock = Math.min(S.max, this.shock + S.perHit * clamp01(dealt / (this.max * 0.45)));
    }
    if (this.rig) {
      // Punch the camera away from the hit: pitch up, yaw and roll off-axis.
      const s = 0.6 + severity * 1.9;
      this.rig.addRecoil(
        (1.1 + severity) * DEG * s * 0.7,
        -Math.sin(angle) * (1.4 * DEG) * s,
        -Math.sin(angle) * (2.2 * DEG) * s,
        0.008 * s
      );
      this.rig.addTrauma(0.22 * s);
    }

    const p = this._payload;
    p.amount = dealt;
    p.health = this.value;
    p.direction = angle;
    p.critical = this.critical;
    // The feedback layer already understands an 'armour' hit — it just never
    // received one before.
    p.armour = hitArmour;
    p.armourLeft = this.armour;
    p.wounded = wounded;
    p.bleedStacks = this.bleedStacks;
    if (from) p.from.copy(from);
    else p.from.set(this.ctx.camera.position.x, this.ctx.camera.position.y, this.ctx.camera.position.z);
    this.ctx.events.emit('damage:taken', p);

    if (this.value <= 0) {
      this.dead = true;
      this.ctx.events.emit('player:death', { position: this.ctx.camera.position });
      // (one allocation on death is fine — it happens once)
    }
    this._emitState(true);
    return dealt;
  }

  heal(amount) {
    this.value = Math.min(this.max, this.value + amount);
  }

  addSuppression(a) {
    this.suppression = clamp01(this.suppression + a);
  }

  _pushIndicator(angle, amount, from) {
    // Reuse the slot pointing the most similar way, else the oldest.
    let slot = null;
    let oldest = null;
    for (let k = 0; k < this.indicators.length; k++) {
      const i = this.indicators[k];
      if (!i.active) { slot = i; break; }
      if (Math.abs(angle - i.angle) < 0.5) { slot = i; break; }
      if (!oldest || i.life > oldest.life) oldest = i;
    }
    slot = slot ?? oldest ?? this.indicators[0];
    slot.active = true;
    slot.angle = angle;
    slot.amount = Math.max(slot.active ? slot.amount * 0.5 : 0, amount);
    slot.life = 0;
    slot.worldX = from.x; slot.worldY = from.y; slot.worldZ = from.z;
  }

  /* ==================================================================== */

  update(dt) {
    const H = HEALTH;

    // ---- bleeding -------------------------------------------------------
    // Runs before regen so an open wound holds recovery shut: you have to break
    // contact AND wait out the clot, not just break contact.
    let bleeding = false;
    for (let i = 0; i < this.wounds.length; i++) {
      const w = this.wounds[i];
      if (!w.active) continue;
      w.life += dt;
      if (w.life >= H.bleed.clotTime) { w.active = false; continue; }
      bleeding = true;
    }
    if (bleeding && !this.dead) {
      // Floors well above zero: bleeding applies pressure, it never kills.
      const floor = this.max * H.bleed.floor;
      if (this.value > floor) {
        this.value = Math.max(floor, this.value - this.bleedRate * dt);
      }
    }

    // ---- regeneration ---------------------------------------------------
    const since = this.ctx.time.elapsed - this.lastDamageTime;
    if (!this.dead && !bleeding && this.value < this.max && since > H.regenDelay) {
      this.regenerating = true;
      // Ramp in so the recovery has a shape rather than a step.
      const ramp = clamp01((since - H.regenDelay) / H.regenRamp);
      this.value = Math.min(this.max, this.value + H.regenRate * ramp * dt);
    } else if (bleeding || this.value >= this.max) {
      // `bleeding` matters here: the flag drives the HUD's regen tick, and
      // without it a wound taken mid-regen would leave it stuck on, showing
      // recovery while HP was actually draining.
      this.regenerating = false;
    }

    // ---- pools ----------------------------------------------------------
    this.suppression = Math.max(0, this.suppression - H.suppression.decay * dt);
    this.hitFlash = approach(this.hitFlash, 0, H.effect.hitFlashTau, dt);

    for (let k = 0; k < this.indicators.length; k++) {
      const i = this.indicators[k];
      if (!i.active) continue;
      i.life += dt;
      if (i.life > H.indicatorTime) i.active = false;
    }

    // ---- shock ------------------------------------------------------------
    this.shock = Math.max(0, this.shock - H.shock.decay * dt);

    // ---- low-health treatment weight ------------------------------------
    // Shock rides the SAME pass as dying rather than adding a second fullscreen
    // effect, weighted down so a hard hit at full health never looks like being
    // at death's door. Max, not sum, so the two cannot overdrive each other.
    const f = this.fraction;
    const lowTarget = clamp01((H.lowThreshold - f) / H.lowThreshold);
    const target = Math.max(lowTarget, this.shock * H.shock.effectScale);
    this.effect = approach(this.effect, target, 0.25, dt);

    // ---- heartbeat ------------------------------------------------------
    // Gated on the LOW-HEALTH weight, not on `effect`: now that shock also drives
    // `effect`, keying off it would start a pounding heartbeat after any hard hit
    // at full health, which reads as near-death when you are perfectly fine.
    if (lowTarget > 0.02) {
      const freq = lerp(H.effect.heartbeatMin, H.effect.heartbeatMax, clamp01(1 - f / H.lowThreshold));
      this.beatPhase += dt * freq;
      if (this.beatPhase >= 1) {
        this.beatPhase -= Math.floor(this.beatPhase);
        this._beat.strength = this.effect;
        this._beat.fraction = f;
        this.ctx.events.emit('player:heartbeat', this._beat);
      }
      // lub-dub: two gaussian thumps 0.16 of a cycle apart
      const t = this.beatPhase;
      const thump = (c, w, g) => g * Math.exp(-((t - c) * (t - c)) / (2 * w * w));
      this.pulse = (thump(0.06, 0.035, 1) + thump(0.22, 0.045, 0.62)) * this.effect;
    } else {
      this.beatPhase = 0;
      this.pulse = 0;
    }

    // ---- suppression feel ------------------------------------------------
    if (this.rig && this.suppression > 0.02) {
      this.rig.addTrauma(this.suppression * H.suppression.shakeScale * dt);
    }

    this._emitTimer -= dt;
    if (this._emitTimer <= 0) {
      this._emitTimer = 0.1;
      if (Math.abs(this.value - this._lastEmitHealth) > 0.4) this._emitState(false);
    }
  }

  _emitState(force) {
    const s = this._statePayload;
    const wasLow = s.low;
    s.health = this.value;
    s.fraction = this.fraction;
    s.low = this.low;
    s.critical = this.critical;
    s.regenerating = this.regenerating;
    s.suppression = this.suppression;
    s.shock = this.shock;
    s.dead = this.dead;
    s.armour = this.armour;
    s.maxArmour = this.maxArmour;
    s.bleeding = this.bleeding;
    s.bleedStacks = this.bleedStacks;
    this._lastEmitHealth = this.value;
    s.changedLowState = wasLow !== s.low;
    s.forced = !!force;
    this.ctx.events.emit('player:health', s);
  }
}
