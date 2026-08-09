import * as THREE from 'three';

/**
 * ===========================================================================
 * GEAR — grenades, melee, interaction, medical
 * ===========================================================================
 *
 * WHY THIS SUBSYSTEM EXISTS
 *
 * `core/input.js` has declared these bindings since the first commit:
 *
 *   grenade: ['KeyG']   melee: ['KeyV']   use: ['KeyF']
 *
 * and nothing read any of them. Reported, correctly, as "клавиши G/V/F
 * по-прежнему мертвы". The verbs were not half-implemented; they did not exist.
 * The AI could throw grenades — `ai.throwGrenade` has been there all along — so
 * the bots had a capability the player did not.
 *
 * Everything here goes through the canonical events the rest of the engine
 * already speaks, and that is the whole reason it can be a small file:
 *
 *   `explosion`      physics applies the impulse, fx draws it, ai hears it, the
 *                    player takes blast damage. All four already listen.
 *   `damage:dealt`   ai routes it to the agent it names; player routes it to
 *                    itself. Melee needs no new damage path.
 *
 * PUBLIC API — `const gear = ctx.get('gear')`
 *   gear.throwLethal(cook)      / gear.throwTactical()
 *   gear.melee()                a swing; returns the hit or null
 *   gear.useHeld()              the F verb, resolved against the registry
 *   gear.registerInteractable(o) -> off()   { id, prompt, sub, radius, at, onUse }
 *   gear.applyMedical()         bandage: stops bleeding, then heals over time
 *   gear.state                  counts + cook progress, for the HUD
 */

/** Frag: real M67 figures — 4-5 s fuse, ~5 m effective, ~15 m casualty. */
export const LETHAL = {
  fuse: 4.0,
  radius: 7.0,
  damage: 125,
  /** Throw speed at a full arm, m/s, and the upward share of it. */
  speed: 18,
  lift: 0.42,
  mass: 0.4,
  restitution: 0.24,
  friction: 0.72,
  /**
   * COOKING. Holding G runs the fuse down before the grenade leaves your hand,
   * which is the difference between a grenade and a thrown rock — it is how you
   * stop the enemy walking away from it. It is also how you kill yourself, and
   * that has to be possible or the mechanic is free.
   */
  minCook: 0.0,
  /** Below this much fuse left, it goes off in your hand. */
  cookOut: 0.35,
};

/** Flashbang: no damage, a lot of consequence. */
export const TACTICAL = {
  fuse: 1.6,
  radius: 9.0,
  damage: 0,
  speed: 17,
  lift: 0.4,
  mass: 0.28,
  restitution: 0.42,
  friction: 0.55,
};

/**
 * MELEE. A knife, not a rifle butt: 1.9 m of reach because that is roughly a
 * lunging arm plus a blade, and a swing you commit to for a third of a second.
 */
export const MELEE = {
  reach: 1.9,
  damage: 55,
  /** A hit from behind is a kill, which is what makes flanking worth doing. */
  backstabMultiplier: 3.0,
  swingTime: 0.34,
  /** The window inside the swing during which the trace happens. */
  hitAt: 0.14,
  cooldown: 0.62,
};

/** Bandage-then-heal, which is why it takes time you have to find. */
export const MEDICAL = {
  applyTime: 3.2,
  /** HP restored, delivered over `healTime` rather than instantly. */
  heal: 55,
  healTime: 4.5,
  /** Interrupted by taking a hit: field medicine under fire does not work. */
  interruptOnDamage: true,
};

/** How close you have to be for an F prompt to appear, if one is not given. */
const USE_RADIUS = 2.4;

export class GearSystem {
  static id = 'gear';
  static deps = ['physics', 'ui'];

  constructor() {
    this.state = {
      lethal: 2,
      tactical: 1,
      medical: 1,
      /** 0..1 while G is held; 1 means the fuse is nearly out. */
      cook: 0,
      cooking: false,
      /** 0..1 while a swing is in progress. */
      swing: 0,
      /** 0..1 while a medkit is being applied. */
      healing: 0,
      /** What F would do right now, or null. */
      prompt: null,
    };
    /** Live thrown objects. */
    this._live = [];
    /** id -> interactable */
    this._interactables = new Map();
    this._off = [];
    this._swingT = -1;
    this._cooldown = 0;
    this._healT = -1;
    this._healLeft = 0;
    this._healRate = 0;
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }

  async init(ctx) {
    this.ctx = ctx;
    this.phys = ctx.get('physics');
    this.root = new THREE.Group();
    this.root.name = 'gear';
    ctx.scene.add(this.root);

    /**
     * One geometry and two materials for every grenade ever thrown.
     *
     * Built here, in init(), and not on the first throw — a material created
     * mid-firefight compiles a shader on that frame, which is a stall exactly
     * when the player is least able to forgive one. This is the same lesson the
     * board's prewarm hook came from.
     */
    this._geo = new THREE.IcosahedronGeometry(0.048, 1);
    this._mats = {
      lethal: new THREE.MeshStandardMaterial({ color: 0x2f3a2a, roughness: 0.58, metalness: 0.8 }),
      tactical: new THREE.MeshStandardMaterial({ color: 0x9aa2a8, roughness: 0.4, metalness: 0.9 }),
    };
    // Patch into the world's lighting the same way ai's grenade does, so a thrown
    // object is not the one unlit thing in the frame.
    const render = ctx.peek('render');
    for (const m of Object.values(this._mats)) render?.patcher?.patch?.(m);

    const on = (t, fn) => this._off.push(ctx.events.on(t, fn));
    // The kit decides how many grenades you have — see arsenal/rules.js, which
    // already charges the pack mass and volume for them.
    on('arsenal:kit', (e) => this.#syncKit(e?.kit));
    // A hit interrupts field medicine. See MEDICAL.interruptOnDamage.
    on('damage:taken', () => {
      if (MEDICAL.interruptOnDamage && this._healT >= 0) this.#abortMedical('hit');
    });
    this.#syncKit(ctx.peek('arsenal')?.kit);

    console.info(
      `[gear] lethal ${this.state.lethal} · tactical ${this.state.tactical} · ` +
        `medical ${this.state.medical} · melee ${MELEE.reach} m`,
    );
  }

  #syncKit(kit) {
    if (!kit) return;
    this.state.lethal = kit.lethal ?? this.state.lethal;
    this.state.tactical = kit.tactical ?? this.state.tactical;
    this.state.medical = kit.medical === false ? 0 : 1;
  }

  /* ==================================================================== */
  /* interaction (F)                                                      */
  /* ==================================================================== */

  /**
   * Register something F can act on.
   *
   * A REGISTRY rather than each subsystem watching KeyF itself, because the
   * previous arrangement had exactly one owner (the gunsmith bench, in
   * shell/index.js) reading the raw key, and a second owner would have meant two
   * things happening on one press with no way to say which. With a registry the
   * nearest interactable wins, deterministically, and there is one prompt.
   *
   * @param {object} o
   * @param {string} o.id
   * @param {() => THREE.Vector3|{x,y,z}|null} o.at  where it is, evaluated per frame
   * @param {number} [o.radius]
   * @param {string} o.prompt  short verb, e.g. 'ДОСКА ОРУЖИЯ'
   * @param {string} [o.sub]
   * @param {(ctx) => void} o.onUse
   * @param {() => boolean} [o.enabled]
   * @returns {() => void} unregister
   */
  registerInteractable(o) {
    if (!o?.id) throw new Error('an interactable needs an id');
    this._interactables.set(o.id, { radius: USE_RADIUS, ...o });
    return () => this._interactables.delete(o.id);
  }

  /** The nearest enabled interactable in range, or null. */
  nearest() {
    const eye = this.#eye(this._tmp);
    if (!eye) return null;
    let best = null;
    let bestD = Infinity;
    for (const it of this._interactables.values()) {
      if (it.enabled && !it.enabled()) continue;
      const at = it.at?.();
      if (!at) continue;
      const d = Math.hypot(at.x - eye.x, (at.y ?? eye.y) - eye.y, at.z - eye.z);
      if (d > (it.radius ?? USE_RADIUS) || d >= bestD) continue;
      best = it;
      bestD = d;
    }
    return best;
  }

  useHeld() {
    const it = this.nearest();
    if (!it) return false;
    it.onUse?.(this.ctx);
    this.ctx.events.emit('gear:use', { id: it.id });
    return true;
  }

  /* ==================================================================== */
  /* grenades (G)                                                         */
  /* ==================================================================== */

  /**
   * Throw one.
   *
   * @param {'lethal'|'tactical'} kind
   * @param {number} [cooked] seconds already burned off the fuse
   */
  throw_(kind = 'lethal', cooked = 0) {
    const spec = kind === 'tactical' ? TACTICAL : LETHAL;
    if (this.state[kind] <= 0) return false;
    const eye = this.#eye(this._tmp);
    if (!eye) return false;
    this.state[kind] -= 1;

    // Out of the muzzle-side hand, not out of the eye: a grenade that spawns at
    // the camera clips the viewmodel and looks like it came out of your face.
    const cam = this.ctx.camera;
    this._dir.set(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    const right = this._tmp2.set(1, 0, 0).applyQuaternion(cam.quaternion).normalize();
    const from = eye.clone().addScaledVector(this._dir, 0.34).addScaledVector(right, 0.16);
    from.y -= 0.1;

    const mesh = new THREE.Mesh(this._geo, this._mats[kind]);
    mesh.castShadow = false;
    this.root.add(mesh);

    // Aim along the view, with lift added: a flat throw is useless indoors and a
    // lobbed one is useless across a street, so the player's pitch does the work
    // and `lift` only stops a level throw from hitting the floor immediately.
    const v = this._dir.clone().multiplyScalar(spec.speed);
    v.y += spec.speed * spec.lift;

    const body = this.phys.addRigidBody({
      shape: 'sphere',
      radius: 0.05,
      mass: spec.mass,
      position: from,
      velocity: { x: v.x, y: v.y, z: v.z },
      restitution: spec.restitution,
      friction: spec.friction,
      lifetime: 20,
      object3D: mesh,
      surfaceType: 'metal',
    });

    const fuse = Math.max(0.05, spec.fuse - cooked);
    this._live.push({ kind, spec, body, mesh, fuse });
    // Spawn a HUD marker so a grenade at your feet is survivable information.
    this.ctx.peek('ui')?.spawnGrenade?.(from, fuse);
    this.ctx.events.emit('grenade:thrown', { kind, position: from, fuse });
    return true;
  }

  throwLethal(cooked = 0) {
    return this.throw_('lethal', cooked);
  }

  throwTactical() {
    return this.throw_('tactical', 0);
  }

  /** Detonate in the player's hand. Cooking too long has to cost something. */
  #cookOut() {
    const eye = this.#eye(this._tmp);
    this.state.lethal = Math.max(0, this.state.lethal - 1);
    this.state.cooking = false;
    this.state.cook = 0;
    this._cookT = 0;
    if (!eye) return;
    this.ctx.events.emit('explosion', {
      position: eye.clone(),
      radius: LETHAL.radius,
      damage: LETHAL.damage,
      source: 'player',
    });
  }

  /* ==================================================================== */
  /* melee (V)                                                            */
  /* ==================================================================== */

  /**
   * Swing. Returns immediately; the trace happens `MELEE.hitAt` into the
   * animation, because a melee that connects on the keypress reads as a hitscan
   * and cannot be dodged, and a melee that connects at the end feels broken.
   */
  melee() {
    if (this._swingT >= 0 || this._cooldown > 0) return false;
    this._swingT = 0;
    this._traced = false;
    this.ctx.events.emit('melee:swing', {});
    return true;
  }

  #meleeTrace() {
    const eye = this.#eye(this._tmp);
    if (!eye) return null;
    const cam = this.ctx.camera;
    this._dir.set(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    const hit = this.phys.raycast(eye, this._dir, MELEE.reach, this.phys.MASK.BULLET);
    if (!hit?.hit) return null;

    const owner = hit.collider?.owner ?? hit.owner ?? null;
    let amount = MELEE.damage;
    /**
     * BACKSTAB. Compared as headings rather than as a dot of full 3D vectors:
     * looking down at someone's back from a balcony is still their back, and the
     * pitch would otherwise wash the test out.
     */
    const facing = owner?.yaw;
    if (typeof facing === 'number') {
      const swingYaw = Math.atan2(this._dir.x, this._dir.z);
      const delta = Math.abs(Math.atan2(Math.sin(swingYaw - facing), Math.cos(swingYaw - facing)));
      if (delta < 1.05) amount *= MELEE.backstabMultiplier;
    }

    this.ctx.events.emit('damage:dealt', {
      target: owner ?? 'world',
      amount,
      point: hit.point.clone(),
      part: hit.collider?.part ?? 'torso',
      weapon: 'melee',
      penetration: 0.2,
    });
    this.ctx.events.emit('melee:hit', { point: hit.point.clone(), amount, target: owner });
    return hit;
  }

  /* ==================================================================== */
  /* medical                                                              */
  /* ==================================================================== */

  /**
   * Bandage, then heal.
   *
   * Two phases on purpose. The bandage is `applyTime` of standing still, which is
   * the cost; the heal is delivered over `healTime` afterwards, which is why
   * breaking contact first is the right play rather than topping up mid-gunfight.
   * Health regeneration already exists (player/health.js) and is HELD SHUT by an
   * open wound — so the medkit's real job is closing the wound, and the HP is the
   * lesser half of what it does.
   */
  applyMedical() {
    if (this.state.medical <= 0 || this._healT >= 0) return false;
    const hp = this.ctx.peek('player')?.health;
    if (!hp || hp.dead) return false;
    if (hp.value >= hp.max && !hp.bleeding) return false;
    this._healT = 0;
    this.ctx.events.emit('medical:start', {});
    return true;
  }

  #abortMedical(reason) {
    this._healT = -1;
    this.state.healing = 0;
    this.ctx.events.emit('medical:abort', { reason });
  }

  #finishMedical() {
    this._healT = -1;
    this.state.healing = 0;
    this.state.medical = Math.max(0, this.state.medical - 1);
    const hp = this.ctx.peek('player')?.health;
    if (hp) {
      // Close every open wound: this is the part that matters, because a wound
      // holds natural regeneration shut.
      for (const w of hp.wounds) w.active = false;
      this._healLeft = MEDICAL.heal;
      this._healRate = MEDICAL.heal / MEDICAL.healTime;
    }
    this.ctx.events.emit('medical:done', {});
  }

  /* ==================================================================== */
  /* frame                                                                */
  /* ==================================================================== */

  update(dt, ctx) {
    const input = ctx.input;
    const player = ctx.peek('player');
    const canAct = !!player?.controlEnabled && !player?.health?.dead;

    // ---- G: cook and throw ------------------------------------------------
    if (canAct && input?.action?.('grenade') && this.state.lethal > 0) {
      if (!this.state.cooking) {
        this.state.cooking = true;
        this._cookT = 0;
      }
      this._cookT += dt;
      this.state.cook = Math.min(1, this._cookT / (LETHAL.fuse - LETHAL.cookOut));
      if (this._cookT >= LETHAL.fuse - LETHAL.cookOut) this.#cookOut();
    } else if (this.state.cooking) {
      this.state.cooking = false;
      const cooked = this._cookT ?? 0;
      this._cookT = 0;
      this.state.cook = 0;
      if (canAct) this.throwLethal(cooked);
    }

    // ---- H: flashbang -----------------------------------------------------
    if (canAct && input?.actionPressed?.('tactical')) this.throwTactical();

    // ---- V: melee ---------------------------------------------------------
    if (canAct && input?.actionPressed?.('melee')) this.melee();
    if (this._cooldown > 0) this._cooldown = Math.max(0, this._cooldown - dt);
    if (this._swingT >= 0) {
      this._swingT += dt;
      if (!this._traced && this._swingT >= MELEE.hitAt) {
        this._traced = true;
        this.#meleeTrace();
      }
      this.state.swing = Math.min(1, this._swingT / MELEE.swingTime);
      if (this._swingT >= MELEE.swingTime) {
        this._swingT = -1;
        this.state.swing = 0;
        this._cooldown = MELEE.cooldown;
      }
    }

    // ---- F: interaction ---------------------------------------------------
    const it = canAct ? this.nearest() : null;
    const ui = ctx.peek('ui');
    if (it) {
      if (this.state.prompt !== it.id) {
        this.state.prompt = it.id;
        ui?.setPrompt?.({ key: 'F', text: it.prompt, sub: it.sub ?? '' });
      }
      if (input?.actionPressed?.('use')) this.useHeld();
    } else if (this.state.prompt) {
      this.state.prompt = null;
      ui?.clearPrompt?.();
    }

    // ---- medical ----------------------------------------------------------
    if (canAct && input?.actionPressed?.('heal')) this.applyMedical();
    if (this._healT >= 0) {
      this._healT += dt;
      this.state.healing = Math.min(1, this._healT / MEDICAL.applyTime);
      if (this._healT >= MEDICAL.applyTime) this.#finishMedical();
    }
    if (this._healLeft > 0) {
      const step = Math.min(this._healLeft, this._healRate * dt);
      this._healLeft -= step;
      player?.health?.heal?.(step);
    }

    // ---- live grenades ----------------------------------------------------
    for (let i = this._live.length - 1; i >= 0; i--) {
      const g = this._live[i];
      g.fuse -= dt;
      if (g.fuse > 0) continue;
      const p = g.body?.position ?? g.mesh.position;
      ctx.events.emit('explosion', {
        position: new THREE.Vector3(p.x, p.y, p.z),
        radius: g.spec.radius,
        damage: g.spec.damage,
        source: 'player',
        flash: g.kind === 'tactical',
      });
      this.phys.removeRigidBody(g.body);
      this.root.remove(g.mesh);
      this._live.splice(i, 1);
    }
  }

  #eye(out) {
    const cam = this.ctx.camera;
    out.setFromMatrixPosition(cam.matrixWorld);
    return out;
  }

  dispose() {
    for (const off of this._off) off?.();
    this._off.length = 0;
    for (const g of this._live) {
      this.phys?.removeRigidBody(g.body);
      this.root.remove(g.mesh);
    }
    this._live.length = 0;
    this._interactables.clear();
    this.root.parent?.remove(this.root);
    this._geo?.dispose();
    for (const m of Object.values(this._mats ?? {})) m.dispose();
  }
}
