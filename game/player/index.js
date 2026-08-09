/**
 * PLAYER — movement state machine, camera feel, health.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT LIVES HERE
 *   movement.js   the state machine: stand/crouch/prone/sprint/tacsprint/slide/
 *                 jump/fall/mantle/vault (+ lean). 120 Hz, fully interruptible.
 *   camera.js     bob, landing dip, step shift, strafe/turn roll, breathing
 *                 sway, recoil + weapon kick channels, trauma shake, FOV.
 *   mantle.js     ledge detection via physics capsule sweeps + the rooted climb.
 *   health.js     health, regen, suppression, damage direction, heartbeat.
 *   load.js       carried mass + the stamina pool. Weapon weight finally costs
 *                 movement speed and sprint duration, not just recoil.
 *   lowhealth.js  the low-health screen treatment, registered with `render`.
 *   tuning.js     every number, with the CoD values it was calibrated against.
 *   springs.js    spring/damper + easing maths.
 *
 * Collision is *never* computed here — everything goes through
 * `physics.createCharacter()` capsule sweeps.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PUBLIC API — `const p = ctx.get('player')`
 * ────────────────────────────────────────────────────────────────────────────
 * TRANSFORM
 *   p.position        Vector3, FEET (bottom of the capsule), interpolated
 *   p.eyePosition     Vector3, the composed camera position
 *   p.velocity        Vector3, m/s
 *   p.forward         Vector3, unit view forward
 *   p.yaw / p.pitch   radians (yaw is the movement basis, camera adds feel)
 *   p.speed / p.horizontalSpeed
 *   p.character       the physics CharacterController (read-only)
 *   p.height          capsule height of the current stance
 *   p.hitbox          physics collider on LAYER.PLAYER — trace against the
 *                     player with `phys.MASK.BULLET | phys.LAYER.PLAYER`
 *
 * STATE
 *   p.state           'stand'|'crouch'|'prone'|'sprint'|'tacsprint'|'slide'|
 *                     'jump'|'fall'|'mantle'|'vault'|'lean'
 *   p.stance          'stand'|'crouch'|'prone'
 *   p.sprinting  p.tacticalSprint  p.sliding  p.grounded  p.airborne
 *   p.mantling   p.leanAmount (-1..1)   p.slideProgress (0..1)
 *
 * AIM
 *   p.adsRequested            true while the aim button is held
 *   p.adsProgress             0..1 blend actually in use
 *   p.setAdsProgress(v)       `weapons` owns the real curve — push it here and
 *                             the camera FOV, sway and move speed follow it
 *
 * CAMERA FEEL (for `weapons`, `fx`, `ai`)
 *   p.addRecoil(pitch, yaw, roll, punch)   camera-owned recoil impulse (radians)
 *   p.addKick(pitch, yaw, roll)            independent weapon kick channel
 *   p.addTrauma(a)                         0..1 noise shake (explosions, hits)
 *   p.viewKick                             { pitch, yaw, roll, punch } this frame
 *   p.cameraRig                            the rig, if you need the raw springs
 *
 * HEALTH
 *   p.health  p.maxHealth  p.healthFraction  p.lowHealth  p.dead
 *   p.suppression  p.damageIndicators
 *   p.applyDamage(amount, fromVector3, opts)   p.heal(a)   p.addSuppression(a)
 *
 * CONTROL
 *   p.setControlEnabled(bool)     shot harness / cutscenes
 *   p.teleport(eyePosition, rotationEulerOrYaw)
 *   p.respawn(index)
 *   p.debugState(name)            'sprint'|'slide'|'crouch'|'hurt'|'critical'|
 *                                 'air'|'reset'
 *
 * EVENTS EMITTED
 *   player:state      { stance, sprinting, sliding, ads, state, grounded, ... }
 *   player:land       { velocity, surface, position }
 *   player:footstep   { position, surface, running, left, speed, stance }
 *   damage:taken      { amount, from, health, direction }
 *   player:health     { health, fraction, low, critical, regenerating, ... }  *
 *   player:heartbeat  { strength, fraction }                                  *
 *   player:mantle     { kind, height }                                        *
 *   player:jump       { position }                                            *
 *   player:death      { position }                                            *
 *   (*) not in the canonical table in ARCHITECTURE.md — additive, optional, and
 *   safe to ignore. The canonical `player:state` payload carries `health` too so
 *   a listener that only knows the documented four fields still gets everything.
 */

import * as THREE from 'three';
import { Movement } from './movement.js';
import { CameraRig } from './camera.js';
import { Health } from './health.js';
import { LowHealthPass } from './lowhealth.js';
import { STANCE, MOVE, CAMERA, HEALTH, FOOTSTEP, JUMP_SPEED, ARMOUR } from './tuning.js';
import { clamp, clamp01, lerp, approach, DEG } from './springs.js';
import { carriedLoad, REFERENCE_LOAD } from './load.js';

export class PlayerSystem {
  static id = 'player';
  static deps = ['physics', 'world', 'render'];

  constructor() {
    /** Lets `ai` / `physics` recognise the local player from an owner pointer. */
    this.isPlayer = true;
    this.movement = null;
    this.rig = null;
    this.health = null;
    this.lowHealthPass = null;
    this.hitbox = null;
    /** head / torso / legs colliders on LAYER.PLAYER. See init(). */
    this.zones = null;

    this.controlEnabled = true;
    this.adsAmount = 0;
    this._adsExternal = false;
    this._adsExternalAge = 0;
    this.adsRequested = false;

    this._lookFrame = -1;
    this._prevYaw = 0;

    // preallocated event payloads
    this._statePayload = {
      stance: 'stand', sprinting: false, sliding: false, ads: false,
      state: 'stand', grounded: true, airborne: false, mantling: false,
      lean: 0, speed: 0, health: HEALTH.max, healthFraction: 1, crouched: false,
    };
    this._landPayload = { velocity: 0, surface: 'concrete', position: new THREE.Vector3() };
    this._stepPayload = {
      position: new THREE.Vector3(), surface: 'concrete', running: false,
      left: false, speed: 0, stance: 'stand',
    };
    this._mantlePayload = { kind: 'none', height: 0 };
    this._jumpPayload = { position: new THREE.Vector3() };
    // Preallocated HUD snapshot polled by `ui` (see getHudState).
    this._hudState = {
      health: HEALTH.max, maxHealth: HEALTH.max, regen: false, dead: false,
      move: 0, sprint: false, crouch: false, ads: false, airborne: false,
      suppression: 0, shock: 0, position: null,
      stamina: 1, exhausted: false, carriedKg: REFERENCE_LOAD,
      armour: ARMOUR.plates * ARMOUR.perPlate,
      maxArmour: ARMOUR.plates * ARMOUR.perPlate,
      bleeding: false, bleedStacks: 0,
      shielded: false, shieldLeft: 0,
    };

    this._tmp = new THREE.Vector3();
    /** Last emitted discrete state, compared field-wise so no string is built. */
    this._prev = {
      state: '', stance: '', sprinting: false, tacticalSprint: false,
      sliding: false, grounded: true, ads: false, mantling: false,
    };
    this._offEvents = [];
  }

  /* ==================================================================== */
  /* init                                                                 */
  /* ==================================================================== */

  async init(ctx) {
    this.ctx = ctx;
    this.physics = ctx.get('physics');
    this.rng = ctx.rng.fork();

    /** Memo for carriedKg, keyed on the weapon def object identity. */
    this._loadDef = null;
    this._loadKg = REFERENCE_LOAD;
    this.movement = new Movement(ctx, this);
    this.rig = new CameraRig(ctx);
    this.health = new Health(ctx, this.rig);

    // ---- spawn -----------------------------------------------------------
    const spawn = this._resolveSpawn();
    this.movement.init(this.physics, spawn.feet);
    this.movement.yaw = spawn.yaw;
    this.movement.pitch = 0;
    this._prevYaw = spawn.yaw;
    this.rig.reset(STANCE.stand.eye);
    this.rig.update(1 / 60, this.movement, this.health);
    this.rig.applyTo(ctx.camera);

    // ---- hitbox ----------------------------------------------------------
    // A capsule on the PLAYER layer so `ai` has something to shoot at. PLAYER is
    // deliberately absent from MASK.BULLET and MASK.CHARACTER, so it can never
    // be hit by the player's own muzzle ray and never blocks the player's own
    // movement sweeps: an AI that wants to hit us traces with
    //   phys.MASK.BULLET | phys.LAYER.PLAYER
    // Three zones, not one. The player used to be a single capsule hard-coded to
    // part:'torso', so an AI shot to the head did exactly as much damage as one
    // to the shin — while agents have carried per-bone capsules with a 4x head
    // since they were written. Incoming fire was the only unaimed thing left.
    // damageScale is applied generically by physics on the raycast, and these
    // values match HITBOXES in ai/agent.js so both directions read the same.
    const zone = (part, damageScale, radius) =>
      this.physics.addCollider({
        shape: 'capsule',
        layer: this.physics.LAYER.PLAYER,
        surface: 'flesh',
        owner: this,
        part,
        damageScale,
        radius,
      });
    this.zones = {
      // Radii here are placeholders; _syncHitbox sets the real ones each frame.
      head: zone('head', 4.0, 0.105),
      torso: zone('torso', 1.0, 0.22),
      legs: zone('leg', 0.7, 0.16),
    };
    /** Kept as the torso zone: `p.hitbox` is documented API. */
    this.hitbox = this.zones.torso;
    this._syncHitbox();

    // ---- low-health treatment -------------------------------------------
    const render = ctx.peek('render');
    if (render?.registerPass) {
      this.lowHealthPass = new LowHealthPass();
      this._unregisterPass = render.registerPass(this.lowHealthPass);
    }

    // ---- incoming damage / suppression ----------------------------------
    const on = (type, fn) => this._offEvents.push(ctx.events.on(type, fn));
    on('damage:dealt', (e) => this._onDamageDealt(e));
    on('explosion', (e) => this._onExplosion(e));
    on('bullet:impact', (e) => this._onBulletImpact(e));
    /**
     * Firing gives spawn protection up. Listening for the canonical event rather
     * than reaching into the weapon system keeps the rule in one place and makes
     * it true for every future way of putting a round downrange — grenades and
     * melee included, once those emit.
     */
    on('weapon:fire', () => {
      if (HEALTH.spawnShield.breakOnFire) this.health.dropShield('fired');
    });
    on('grenade:thrown', () => this.health.dropShield('thrown'));
    on('melee:hit', () => this.health.dropShield('melee'));

    /**
     * The match begins the same way a respawn does, so it gets the same grace.
     * Before this, only respawn() granted the shield, which meant the ONE spawn
     * everybody experiences — the first — was the one with no protection at all.
     */
    this.health.grantShield();

    console.info(
      `[player] spawn ${spawn.feet.x.toFixed(1)}, ${spawn.feet.y.toFixed(2)}, ` +
      `${spawn.feet.z.toFixed(1)} · walk ${STANCE.stand.speed} sprint ${MOVE.sprintSpeed} ` +
      `tac ${MOVE.tacSprintSpeed} m/s · jump ${JUMP_SPEED.toFixed(2)} m/s (apex 0.60 m)`
    );
  }

  _resolveSpawn() {
    const world = this.ctx.peek('world');
    const out = { feet: new THREE.Vector3(0, 0.2, 0), yaw: 0 };
    const sp = world?.spawn?.(0);
    if (sp?.position) {
      out.feet.copy(sp.position);
      out.yaw = sp.yaw ?? 0;
    }
    // Physics owns the exact floor; drop onto it so we never start embedded.
    const gy = this.physics.groundHeight(out.feet.x, out.feet.z, out.feet.y + 6);
    out.feet.y = Number.isFinite(gy) ? gy + 0.03 : out.feet.y + 0.2;
    return out;
  }

  /* ==================================================================== */
  /* look                                                                 */
  /* ==================================================================== */

  /**
   * Mouse/stick look is consumed once per rendered frame. It happens in the
   * first fixed step when there is one (so movement uses this frame's yaw with
   * zero latency) and in update() otherwise — above 120 fps a frame can contain
   * no fixed step at all and dropping the delta there would feel like a hitch.
   */
  _consumeLook(dt) {
    const frame = this.ctx.time.frame;
    if (frame === this._lookFrame) return;
    this._lookFrame = frame;
    const m = this.movement;
    if (!this.controlEnabled) {
      m.yawRate = 0;
      return;
    }
    const input = this.ctx.input;
    const cfg = this.ctx.config;
    const sens = lerp(1, cfg.adsSensScale, clamp01(this.adsAmount));

    let dYaw = -input.look.x * sens;
    let dPitch = -input.look.y * sens;

    // Gamepad: rate-based, already curved by Input.
    const stick = input.stick;
    if (stick.lookX || stick.lookY) {
      const rate = 3.1 * sens; // rad/s at full deflection
      dYaw -= stick.lookX * rate * dt;
      dPitch -= stick.lookY * rate * dt;
    }
    // Mantles are rooted: you keep your head, but the shoulders are committed.
    if (m.mantleMotion.active) {
      dYaw *= 0.55;
      dPitch *= 0.55;
    }

    m.yaw += dYaw;
    m.pitch = clamp(m.pitch + dPitch, -CAMERA.pitchLimit, CAMERA.pitchLimit);
    // Keep yaw bounded so long sessions never lose float precision.
    if (m.yaw > Math.PI) m.yaw -= Math.PI * 2;
    else if (m.yaw < -Math.PI) m.yaw += Math.PI * 2;

    m.yawRate = dt > 1e-5 ? dYaw / dt : 0;
    this._prevYaw = m.yaw;
  }

  /* ==================================================================== */
  /* frame                                                                */
  /* ==================================================================== */

  fixedUpdate(h, ctx) {
    if (!this.movement) return;
    this._consumeLook(ctx.time.dt > 1e-5 ? ctx.time.dt : h);
    this.movement.latchInput(ctx.time.frame);
    if (!this.controlEnabled) return;
    this.movement.adsAmount = this.adsAmount;
    this.movement.step(h);
  }

  update(dt, ctx) {
    if (!this.movement) return;
    this._consumeLook(dt);
    this.movement.latchInput(ctx.time.frame);

    this._updateAds(dt);
    this._drainMovementEvents();
    this.health.update(dt);

    this.rig.update(dt, this.movement, this.health);
    if (this.controlEnabled) this.rig.applyTo(ctx.camera);
    else this.rig.forward.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);

    this.lowHealthPass?.sync(this.health);
    this._syncHitbox();
    this._publishState();
  }

  /** Keep the AI-facing hitbox on the interpolated capsule. */
  _syncHitbox() {
    const z = this.zones;
    if (!z) return;
    const m = this.movement;
    const p = m.renderPosition;
    const h = STANCE[m.stance].height;
    const alive = !this.health.dead;

    // Proportions of the capsule height, so the zones stay coherent as the
    // stance shrinks: crouching really does tuck the head down into cover
    // instead of leaving a full-value target floating at standing height.
    //
    // A capsule is a segment INFLATED by its radius, so it reaches radius
    // beyond each endpoint. Laying the segments end-to-end at the intended zone
    // boundaries therefore made every zone overlap its neighbour by a radius:
    // the torso's upper cap reached 0.3 m above the shoulders and swallowed the
    // head entirely, so a headshot still resolved as part:'torso'. Segment
    // endpoints are inset by the radius so the INFLATED extents tile instead.
    const headR = Math.min(0.105, h * 0.09);

    // Intended zone extents, as fractions of the stance height.
    const headBot = h - 2 * headR; // chin
    const legTop = h * 0.46; // hip crease

    // A zone's radius cannot exceed half its span, or the inset endpoints
    // invert and the inflated capsule spills back over its neighbour. Crouch
    // (1.2 m) sits right on that limit and prone (0.6 m) is well past it, which
    // is what let the prone torso swallow the head. Clamping keeps the three
    // zones tiling at every stance height instead of only when standing.
    const torsoR = Math.min(0.22, Math.max(0.04, (headBot - legTop) * 0.5));
    const legR = Math.min(0.16, Math.max(0.04, legTop * 0.5));

    // Inset endpoints so extent === intended boundary.
    const headC = h - headR; // sphere: crown at h, chin at headBot
    const torsoHi = headBot - torsoR;
    const torsoLo = legTop + torsoR;
    const legHi = legTop - legR;
    const legLo = legR;

    // A degenerate segment is how this engine spells "sphere at a point"; clamp
    // so a crouched or prone height can never invert an endpoint pair.
    z.head.setSegment(p.x, p.y + headC, p.z, p.x, p.y + headC, p.z, headR);
    z.torso.setSegment(
      p.x, p.y + Math.min(torsoLo, torsoHi), p.z,
      p.x, p.y + Math.max(torsoLo, torsoHi), p.z, torsoR
    );
    z.legs.setSegment(
      p.x, p.y + Math.min(legLo, legHi), p.z,
      p.x, p.y + Math.max(legLo, legHi), p.z, legR
    );
    z.head.enabled = alive;
    z.torso.enabled = alive;
    // Prone tucks the legs inside the torso capsule; leaving them on would let a
    // shot clip the 0.7x leg zone instead of the torso it visually overlaps.
    z.legs.enabled = alive && m.stance !== 'prone';
  }

  _updateAds(dt) {
    const input = this.ctx.input;
    const m = this.movement;
    this.adsRequested =
      this.controlEnabled && input.ads && !m.mantleMotion.active && !m.sliding && !this.health.dead;

    if (this._adsExternal) {
      // `weapons` is driving the blend; stop trusting it if it goes quiet.
      this._adsExternalAge += dt;
      if (this._adsExternalAge > 0.6) this._adsExternal = false;
    }
    if (!this._adsExternal) {
      this.adsAmount = approach(this.adsAmount, this.adsRequested ? 1 : 0, 0.075, dt);
    }
    m.adsAmount = this.adsAmount;
  }

  /** Turn the movement machine's one-shot flags into events + camera impulses. */
  _drainMovementEvents() {
    const m = this.movement;

    if (m.landEvent.pending) {
      m.landEvent.pending = false;
      const speed = m.landEvent.speed;
      const mag = this.rig.onLand(speed);
      this._landPayload.velocity = speed;
      this._landPayload.surface = m.landEvent.surface;
      this._landPayload.position.copy(m.position);
      this.ctx.events.emit('player:land', this._landPayload);
      // Fall damage — CoD only hurts you past a real drop.
      const L = CAMERA.land;
      if (speed > L.damageSpeed) {
        this.health.damage((speed - L.damageSpeed) * L.damagePerSpeed, null, { type: 'fall' });
      }
      if (mag > 0.35) this.movement._footHold = FOOTSTEP.landHold;
    }

    if (m.stepEvent.pending) {
      m.stepEvent.pending = false;
      const e = this._stepPayload;
      e.position.set(m.stepEvent.x, m.stepEvent.y, m.stepEvent.z);
      e.surface = m.stepEvent.surface;
      e.running = m.stepEvent.running;
      e.left = m.stepEvent.left;
      e.speed = m.horizontalSpeed;
      e.stance = m.stance;
      this.rig.onFootstep(e.running, m.stance);
      this.ctx.events.emit('player:footstep', e);
    }

    if (m.jumped) {
      m.jumped = false;
      this.rig.addRecoil(-0.35 * DEG, 0, 0, 0.004);
      this._jumpPayload.position.copy(m.position);
      this.ctx.events.emit('player:jump', this._jumpPayload);
    }

    if (m.slideStarted) {
      m.slideStarted = false;
      this.rig.onSlideStart(m._slideSide);
    }
    if (m.slideEnded) m.slideEnded = false;

    if (m.mantleEvent.pending) {
      m.mantleEvent.pending = false;
      this._mantlePayload.kind = m.mantleEvent.kind;
      this._mantlePayload.height = m.mantleEvent.height;
      this.rig.addTrauma(m.mantleEvent.kind === 'vault' ? 0.08 : 0.14);
      this.ctx.events.emit('player:mantle', this._mantlePayload);
    }
  }

  _publishState() {
    const m = this.movement;
    const s = this._statePayload;
    const leaning = Math.abs(m.leanAmount) > 0.35;
    const state = leaning && (m.state === 'stand' || m.state === 'crouch') ? 'lean' : m.state;
    s.state = state;
    s.stance = m.stance;
    s.crouched = m.stance !== 'stand';
    s.sprinting = m.sprinting;
    s.tacticalSprint = m.tacticalSprint;
    s.sliding = m.sliding;
    s.ads = this.adsAmount > 0.5;
    s.adsProgress = this.adsAmount;
    s.grounded = m.grounded;
    s.airborne = !m.grounded;
    s.mantling = m.mantleMotion.active;
    s.lean = m.leanAmount;
    s.speed = m.horizontalSpeed;
    s.health = this.health.value;
    s.healthFraction = this.health.fraction;
    // Emit only when something discrete actually changed. Field-wise compare,
    // because building a key string every frame would be a per-frame allocation.
    const q = this._prev;
    if (
      q.state !== s.state || q.stance !== s.stance || q.sprinting !== s.sprinting ||
      q.tacticalSprint !== s.tacticalSprint || q.sliding !== s.sliding ||
      q.grounded !== s.grounded || q.ads !== s.ads || q.mantling !== s.mantling
    ) {
      q.state = s.state; q.stance = s.stance; q.sprinting = s.sprinting;
      q.tacticalSprint = s.tacticalSprint; q.sliding = s.sliding;
      q.grounded = s.grounded; q.ads = s.ads; q.mantling = s.mantling;
      this.ctx.events.emit('player:state', s);
    }
  }

  /* ==================================================================== */
  /* incoming damage                                                      */
  /* ==================================================================== */

  _onDamageDealt(e) {
    if (!e) return;
    const t = e.target;
    if (t !== this && t !== 'player' && t?.isPlayer !== true) return;
    // Direction indicators need the *shooter*, not the impact point: `ai` sets
    // `point` to where the round landed (which is the player), and `from` to the
    // muzzle. Using `point` pinned every arc to dead ahead.
  const from = e.from ?? e.source?.position ?? e.point ?? null;
  // `ai` resolves which zone the round passed through and sends it as `part`;
  // the multiplier is applied here because this is the single funnel for all
  // incoming damage, and because it is the player's own damage model to own.
  // Without this the zone colliders existed but nothing ever read their scale.
  const part = e.part ?? 'torso';
  const scale = this._zoneScale(part);
  this.applyDamage((e.amount ?? 0) * scale, from, {
    type: 'bullet',
    part,
    penetration: e.penetration,
  });
  }

  /** Damage multiplier for a hit zone, read off the collider that defines it. */
  _zoneScale(part) {
    const z = this.zones;
    if (!z) return 1;
    const c = part === 'head' ? z.head : part === 'leg' || part === 'arm' ? z.legs : z.torso;
    return c?.damageScale ?? 1;
  }

  _onExplosion(e) {
    if (!e?.position) return;
    const eye = this.ctx.camera.position;
    const r = e.radius ?? 5;
    const d = this._tmp.copy(e.position).distanceTo(eye);
    if (d > r * 1.6) return;
    // Occluded blasts still shake you, they just do not wound you.
    const clear = this.physics.lineOfSight(e.position, eye, this.physics.MASK.EXPLOSION);
    const falloff = Math.pow(clamp01(1 - d / r), 1.6);
    this.rig.addTrauma(clamp01(falloff * 1.4));
    this.health.addSuppression(HEALTH.suppression.perExplosion * falloff);
    if (clear && falloff > 0.02) {
      this.applyDamage((e.damage ?? 90) * falloff, e.position, { type: 'explosion' });
    }
  }

  _onBulletImpact(e) {
    if (!e?.point || this.health.dead) return;
    const eye = this.ctx.camera.position;
    const dx = e.point.x - eye.x, dy = e.point.y - eye.y, dz = e.point.z - eye.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    const R = HEALTH.suppression.radius;
    if (d2 > R * R) return;
    // Heuristic: rounds we fired land where we are looking. Anything cracking in
    // beside or behind us is somebody shooting at us.
    const d = Math.sqrt(d2) || 1e-4;
    const f = this.rig.forward;
    if ((dx * f.x + dy * f.y + dz * f.z) / d > 0.55) return;
    this.health.addSuppression(HEALTH.suppression.perNearMiss * (1 - d / R));
  }

  /* ==================================================================== */
  /* public API                                                           */
  /* ==================================================================== */

  /**
   * HUD adapter polled by `ui` every lateUpdate. Shape is fixed by the contract
   * documented at the top of src/ui/index.js. Preallocated and mutated in place.
   */
  getHudState() {
    const h = this._hudState;
    const m = this.movement;
    const hp = this.health;
    h.health = hp.value;
    h.maxHealth = hp.max;
    h.regen = hp.regenerating;
    h.dead = hp.dead;
    h.suppression = hp.suppression;
    h.shock = hp.shock;
    h.shielded = hp.shielded;
    h.shieldLeft = hp.shield;
    // 0..1 against tactical sprint, which is the fastest the player can move —
    // `ui` uses this directly as the reticle-bloom weight.
    h.move = Math.min(1, m.horizontalSpeed / MOVE.tacSprintSpeed);
    h.sprint = m.sprinting || m.tacticalSprint;
    h.crouch = m.stance === 'crouch' || m.stance === 'prone';
    h.ads = this.adsAmount > 0.5;
    h.airborne = !m.grounded;
    h.position = this.position;
    // Stamina is a resource the player has to be able to see, or running out of
    // it reads as the controls breaking rather than as a cost.
    h.stamina = m.stamina.fraction;
    h.exhausted = m.stamina.exhausted;
    h.carriedKg = m.stamina.loadKg;
    // The HUD has always drawn three armour plates and `ui` has always copied
    // `armour` through; this is the value that was never being supplied.
    h.armour = hp.armour;
    h.maxArmour = hp.maxArmour;
    h.bleeding = hp.bleeding;
    h.bleedStacks = hp.bleedStacks;
    return h;
  }

  /**
   * Total carried mass in kilograms, read by Movement each fixed step.
   *
   * Every weapon in arsenal/defs.js has always carried a real `weight`, and only
   * the recoil solver ever read it. Summing it here is what finally makes an SVD
   * feel heavier to carry than a Glock instead of only heavier to shoot.
   */
  get carriedKg() {
    // `weapons.current` already IS the def, not a wrapper around one.
    const def = this.ctx.peek('weapons')?.current ?? null;
    if (!def || typeof def.weight !== 'number') return REFERENCE_LOAD;
    // Weigh what is actually MOUNTED, not the bare weapon. A can, a bipod and a
    // 4x add most of a kilogram, and every one of them already declares its mass
    // in attachments.js - but this read `def.weight`, so a fully kitted rifle
    // carried exactly like a stripped one. Falls back to the bare def when no
    // arsenal is registered.
    const wp = this.ctx.peek('weapons');
    const kg = wp?.resolvedStats?.()?.weight ?? def.weight;
    // Read every fixed step (120 Hz), so memoise. `def.class` is one of
    // rifle/smg/dmr/shotgun/pistol, which are exactly the keys of LOAD.magKg.
    // Keyed on the mass too, so swapping an attachment mid-match re-weighs;
    // rig.stats() is itself memoised, so this read is cheap enough per step.
    // Spare ammo is real and it drains: `wp.ammo.reserve` counts rounds and
    // reload() spends them, so a hardcoded `mags: 2` meant a player down to his
    // last round carried exactly as much as one who had just spawned full.
    // LOAD.magKg is per MAGAZINE, so convert rounds -> magazine-equivalents and
    // keep the partial (a half-full mag is still weight in a pouch, hence ceil on
    // the remainder). Defaults to 2 mags when there is no ammo state to read.
    const a = wp?.ammo;
    const mags =
      a && a.magSize > 0 ? Math.ceil(a.reserve / a.magSize) + (a.inMag > 0 ? 1 : 0) : 2;
    if (def !== this._loadDef || kg !== this._loadWeaponKg || mags !== this._loadMags) {
      this._loadDef = def;
      this._loadWeaponKg = kg;
      this._loadMags = mags;
      this._loadKg = carriedLoad({
        weaponKg: kg,
        magClass: def.class,
        mags,
      });
    }
    return this._loadKg;
  }

  get position() {
    return this.movement.renderPosition;
  }
  get feetPosition() {
    return this.movement.position;
  }
  get eyePosition() {
    return this.rig.eyePosition;
  }
  get velocity() {
    return this.movement.velocity;
  }
  get forward() {
    return this.rig.forward;
  }
  get yaw() {
    return this.movement.yaw;
  }
  get pitch() {
    return this.movement.pitch;
  }
  get speed() {
    return this.movement.speed;
  }
  get horizontalSpeed() {
    return this.movement.horizontalSpeed;
  }
  get character() {
    return this.movement.character;
  }
  get state() {
    return this._statePayload.state;
  }
  get stance() {
    return this.movement.stance;
  }
  get sprinting() {
    return this.movement.sprinting;
  }
  get tacticalSprint() {
    return this.movement.tacticalSprint;
  }
  get sliding() {
    return this.movement.sliding;
  }
  get slideProgress() {
    return this.movement.slideProgress;
  }
  get grounded() {
    return this.movement.grounded;
  }
  get airborne() {
    return !this.movement.grounded;
  }
  get mantling() {
    return this.movement.mantleMotion.active;
  }
  get leanAmount() {
    return this.movement.leanAmount;
  }
  get eyeHeight() {
    return this.rig.eye;
  }
  get adsProgress() {
    return this.adsAmount;
  }
  get viewKick() {
    return this.rig.viewKick;
  }
  get cameraRig() {
    return this.rig;
  }
  get height() {
    return STANCE[this.movement.stance].height;
  }
  get maxHealth() {
    return this.health.max;
  }
  get healthFraction() {
    return this.health.fraction;
  }
  get lowHealth() {
    return this.health.low;
  }
  get dead() {
    return this.health.dead;
  }
  get suppression() {
    return this.health.suppression;
  }
  get damageIndicators() {
    return this.health.indicators;
  }
  get heartbeatPulse() {
    return this.health.pulse;
  }
  get bobPhase() {
    return this.rig.bobPhase;
  }

  /** `weapons` owns the ADS curve; hand it over and everything else follows. */
  setAdsProgress(v) {
    this.adsAmount = clamp01(v);
    this._adsExternal = true;
    this._adsExternalAge = 0;
    this.movement.adsAmount = this.adsAmount;
  }

  addRecoil(pitch, yaw, roll, punch) {
    this.rig.addRecoil(pitch, yaw, roll, punch);
  }
  addKick(pitch, yaw, roll) {
    this.rig.addKick(pitch, yaw, roll);
  }
  addTrauma(a) {
    this.rig.addTrauma(a);
  }
  /** Alias some subsystems may reach for. */
  addCameraShake(a) {
    this.rig.addTrauma(a);
  }

  applyDamage(amount, from, opts) {
    return this.health.damage(amount, from ?? null, { yaw: this.movement.yaw, ...opts });
  }
  heal(a) {
    this.health.heal(a);
  }
  addSuppression(a) {
    this.health.addSuppression(a);
  }

  setControlEnabled(on) {
    this.controlEnabled = !!on;
    this.movement.controlEnabled = this.controlEnabled;
    if (!on) {
      this.movement.latchInput(-2); // flush held keys
      this.movement.velocity.set(0, 0, 0);
      this.movement.sprinting = false;
      this.movement.tacticalSprint = false;
      this.movement.sliding = false;
      this.movement.cancelMantle();
      this.adsAmount = 0;
      this._adsExternal = false;
    } else {
      this.movement._cmdFrame = -1;
    }
  }

  /**
   * Move the player. `eyeOrPos` is the EYE position (that is what the shot
   * harness hands us — it passes the camera transform); `rot` may be a
   * THREE.Euler, an object with `.y`, or a yaw in radians.
   */
  teleport(eyeOrPos, rot) {
    if (!eyeOrPos) return;
    const eyeH = STANCE.stand.eye;
    const feetY = eyeOrPos.y - eyeH;
    if (typeof rot === 'number') {
      this.movement.yaw = rot;
    } else if (rot) {
      this.movement.yaw = rot.y ?? this.movement.yaw;
      this.movement.pitch = clamp(rot.x ?? 0, -CAMERA.pitchLimit, CAMERA.pitchLimit);
    }
    this.movement.teleport(eyeOrPos.x, feetY, eyeOrPos.z);
    this.rig.reset(eyeH);
    this.rig.eyePosition.set(eyeOrPos.x, eyeOrPos.y, eyeOrPos.z);
    this.rig.fov = this.ctx.config.fov;
    this._lookFrame = this.ctx.time.frame;
    this._prev.state = '';
  }

  respawn(index = 0) {
    const world = this.ctx.peek('world');
    const sp = world?.spawn?.(index);
    this.health.reset(true);
    // Granted before the teleport, so the very first frame at the new position
    // is already protected — an ordering bug here is a death on arrival.
    this.health.grantShield();
    if (!sp?.position) return;
    const gy = this.physics.groundHeight(sp.position.x, sp.position.z, sp.position.y + 6);
    const feetY = Number.isFinite(gy) ? gy + 0.03 : sp.position.y;
    this.movement.yaw = sp.yaw ?? 0;
    this.movement.pitch = 0;
    this.movement.teleport(sp.position.x, feetY, sp.position.z);
    this.rig.reset(STANCE.stand.eye);
  }

  /** Named states for dev overlays and future shots. */
  debugState(name) {
    const m = this.movement;
    switch (name) {
      case 'sprint':
        m.stanceWant = 'stand';
        m.sprinting = true;
        m.velocity.set(-Math.sin(m.yaw), 0, -Math.cos(m.yaw)).multiplyScalar(MOVE.sprintSpeed);
        break;
      case 'tacsprint':
        m.sprinting = true;
        m.tacticalSprint = true;
        break;
      case 'crouch':
        m.stanceWant = 'crouch';
        break;
      case 'prone':
        m.stanceWant = 'prone';
        break;
      case 'slide':
        m.sprinting = true;
        m.velocity.set(-Math.sin(m.yaw), 0, -Math.cos(m.yaw)).multiplyScalar(MOVE.sprintSpeed);
        m._beginSlide(m.cmd, m._wish.set(-Math.sin(m.yaw), 0, -Math.cos(m.yaw)), 1, MOVE.sprintSpeed);
        m.slideStarted = false;
        this.rig.onSlideStart(1);
        break;
      case 'air':
        m.velocity.y = JUMP_SPEED;
        m.grounded = false;
        break;
      case 'hurt':
        this.health.value = this.health.max * 0.28;
        this.health.lastDamageTime = this.ctx.time.elapsed;
        this.health.effect = clamp01((HEALTH.lowThreshold - 0.28) / HEALTH.lowThreshold);
        break;
      case 'critical':
        this.health.value = this.health.max * 0.11;
        this.health.lastDamageTime = this.ctx.time.elapsed;
        this.health.effect = 1;
        this.health.hitFlash = 0.6;
        break;
      case 'reset':
        this.health.reset(true);
        this.health.effect = 0;
        break;
      default:
        break;
    }
    return {
      state: this.state, stance: m.stance, speed: m.horizontalSpeed,
      health: this.health.value, ads: this.adsAmount,
    };
  }

  /** Snapshot for the dev HUD / debugging. */
  get stats() {
    const m = this.movement;
    return {
      state: this.state,
      stance: m.stance,
      speed: m.horizontalSpeed,
      vertical: m.velocity.y,
      grounded: m.grounded,
      lean: m.leanAmount,
      fov: this.rig.fov,
      health: this.health.value,
      suppression: this.health.suppression,
    };
  }

  dispose() {
    for (const off of this._offEvents) off?.();
    this._offEvents.length = 0;
    // All three zones, not just the torso that `this.hitbox` aliases — leaking
    // the head and leg colliders would leave them in the broadphase, still
    // shootable, after the player is gone.
    if (this.zones) {
      for (const c of Object.values(this.zones)) this.physics?.removeCollider(c);
      this.zones = null;
    }
    this.hitbox = null;
    this._unregisterPass?.();
    this.lowHealthPass?.dispose();
    this.lowHealthPass = null;
    this.movement?.dispose();
  }
}
