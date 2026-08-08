/**
 * MODES \u2014 the subsystem.
 *
 * Turns the rules tables and the match state machine into an actual match: it
 * garrisons the map, tunes every bot to the chosen difficulty, runs the flag,
 * respawns the player, feeds the HUD and calls the end.
 *
 * PUBLIC API \u2014 `const modes = ctx.get('modes')`
 *   modes.match              the live Match (scores, standings, mvp)
 *   modes.snapshot()         plain object for the HUD and the results screen
 *   modes.configure(o)       set mode/submode/difficulty BEFORE init
 *   modes.aliveBots()        how much of the garrison is left
 *
 * IT TALKS TO OTHER SUBSYSTEMS THROUGH ctx ONLY \u2014 `ctx.get('ai')`,
 * `ctx.peek('world')`, `ctx.peek('player')`, `ctx.peek('ui')`. No cross-imports:
 * that is what keeps this file testable and the engine contract intact.
 *
 * EVENTS consumed: actor:death
 * EVENTS emitted: modes:start, modes:capture, modes:over
 */

import * as THREE from 'three';
import {
  MODES, CTF, BOT_VARIANTS,
  modeFor, submodeFor, difficultyFor, botForce, roleFor, validateRules,
} from './rules.js';
import { Match } from './match.js';

/** Player id inside the match. The relay uses real ids; solo play needs one. */
const YOU = 'you';

const FLAG_HOME_TAG = 'gate';
const HUD_PERIOD = 0.2;

export class ModesSystem {
  static id = 'modes';
  static deps = ['ai', 'world', 'ui'];

  constructor() {
    this.match = null;
    this.bots = [];
    this.reserve = [];
    this._config = null;
  }

  /** Called by the menu before the engine starts the system. */
  configure(o = {}) {
    this._config = { ...(this._config ?? {}), ...o };
    return this;
  }

  async init(ctx) {
    this.ctx = ctx;
    validateRules();
    this.rng = ctx.rng.fork();

    const q = this.#params();
    const cfg = this._config ?? {};
    const wanted = cfg.mode ?? q.get('mode') ?? 'bots';
    this.modeId = MODES[wanted] ? wanted : 'bots';
    this.mode = modeFor(this.modeId);
    this.submode = submodeFor(this.modeId, cfg.submode ?? q.get('submode'));
    this.difficulty = difficultyFor(cfg.difficulty ?? q.get('diff')).key;

    this.match = new Match({
      mode: this.modeId,
      submode: this.submode,
      difficulty: this.difficulty,
      rng: () => this.rng.float(),
    });
    this.match.addPlayer({ id: YOU, name: '\u0412\u042b', team: 0 });

    this.root = new THREE.Group();
    this.root.name = 'modes';
    ctx.scene.add(this.root);

    this._owned = [];
    this._unsubs = [];
    this._byAgent = new Map();
    this._hudTimer = 0;
    this._wasDead = false;
    this._reserveReleased = false;
    this._ended = false;
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this.flag = null;

    const on = (type, fn) => this._unsubs.push(ctx.events.on(type, fn));
    on('actor:death', (e) => this.#onActorDeath(e));

    if (this.modeId === 'bots') {
      this.#garrison();
      if (this.submode === 'ctf') this.#buildFlag();
    }

    this.match.start();
    ctx.events.emit('modes:start', this.snapshot());
  }

  #params() {
    try {
      return new URLSearchParams(globalThis.location?.search ?? '');
    } catch {
      return new URLSearchParams('');
    }
  }

  /* =================================================================== */
  /* garrison                                                            */
  /* =================================================================== */

  /**
   * Spawn rings, derived from the world's own spawn points rather than
   * hard-coded coordinates: the map can move and this still works.
   *
   * The player holds the nearest point; the garrison gets the far half, ranked
   * by distance, so the front line starts away from the spawn pad.
   */
  #rings() {
    const world = this.ctx.peek('world');
    const pts = world?.spawnPoints ?? [];
    if (!pts.length) return null;
    const home = pts[0];
    const ranked = pts
      .map((p) => ({ p, d: p.position.distanceTo(home.position) }))
      .sort((a, b) => a.d - b.d)
      .map((e) => e.p);
    const far = ranked[ranked.length - 1];
    const gate = pts.find((p) => p.tag === FLAG_HOME_TAG) ?? far;
    return {
      home,
      field: ranked[Math.max(1, Math.floor(ranked.length / 2))] ?? far,
      gate,
      reserve: far,
      defend: ranked[Math.max(1, ranked.length - 2)] ?? far,
    };
  }

  #garrison() {
    const rings = this.#rings();
    const ai = this.ctx.get('ai');
    if (!rings || !ai) {
      console.warn('[modes] no spawn points or no ai system: the field stays empty');
      return;
    }
    const force = botForce(this.difficulty);
    this.releaseAt = force.releaseAt;
    let n = 0;
    for (const wave of force.waves) {
      const anchor = rings[wave.spawn] ?? rings.field;
      for (let i = 0; i < wave.count; i++) {
        const spot = this.#scatter(anchor, wave.spawn === 'field' ? 14 : 6);
        const role = wave.role === 'mixed' ? roleFor(n) : wave.role;
        const descriptor = {
          variant: BOT_VARIANTS[n % BOT_VARIANTS.length],
          position: spot,
          yaw: anchor.yaw + this.rng.signed() * 0.7,
          wave: wave.n,
          role,
          delay: wave.stagger[0] + this.rng.float() * (wave.stagger[1] - wave.stagger[0]),
          id: `bot${n}`,
        };
        // Wave 3 is held back rather than parked on the map: an idle body still
        // costs a skinned draw, a shadow and a nav query every frame.
        if (wave.role === 'reserve') this.reserve.push(descriptor);
        else this.#deploy(descriptor);
        n += 1;
      }
    }
    console.info(`[modes] garrison: ${this.bots.length} on the field, ${this.reserve.length} in reserve (${this.difficulty})`);
  }

  #scatter(anchor, radius) {
    const ai = this.ctx.get('ai');
    const a = this.rng.range(0, Math.PI * 2);
    const r = this.rng.range(1.2, radius);
    const x = anchor.position.x + Math.cos(a) * r;
    const z = anchor.position.z + Math.sin(a) * r;
    const y = ai?.groundAt ? ai.groundAt(x, z, anchor.position.y + 6) : anchor.position.y;
    return new THREE.Vector3(x, Number.isFinite(y) ? y : anchor.position.y, z);
  }

  #deploy(d) {
    const ai = this.ctx.get('ai');
    const agent = ai.spawn(d.variant, d.position, d.yaw, { team: 1, patrol: null });
    if (!agent) return null;
    this.#tune(agent);
    const rec = { id: d.id, agent, wave: d.wave, role: d.role };
    this.bots.push(rec);
    this._byAgent.set(agent, rec);
    this.match.addPlayer({ id: d.id, name: `\u0411\u041e\u0422 ${d.id.slice(3)}`, team: 1, bot: true });
    return rec;
  }

  /**
   * Apply the difficulty to one live agent.
   *
   * UNIT TRAP, and the reason this is not a one-liner: FPS Arena's `fireRate`
   * was a DELAY between shots, so easy multiplied it by 1.40 to make bots
   * slower. The base engine's `fireRate` is shots per SECOND. Multiplying here
   * would have made the easy bots fire 40% faster than normal, so fireMul
   * divides. `spread` is aim error, which is what accMul was always scaling.
   */
  #tune(agent) {
    const d = difficultyFor(this.difficulty);
    agent.spread *= d.accMul;
    agent.fireRate /= d.fireMul;
    agent.burstCooldown *= d.fireMul;
    agent.team = 1;
    const hp = Math.round(100 * d.hpMul);
    agent.health = hp;
    agent.maxHealth = hp;
  }

  aliveBots() {
    let n = 0;
    for (const b of this.bots) if (b.agent.alive) n += 1;
    return n + this.reserve.length;
  }

  #maybeReleaseReserve() {
    if (this._reserveReleased || !this.reserve.length) return;
    if (this.aliveBots() > (this.releaseAt ?? 22)) return;
    this._reserveReleased = true;
    const pending = this.reserve;
    this.reserve = [];
    for (const d of pending) this.#deploy({ ...d, role: roleFor(d.wave + this.bots.length) });
    this.ctx.peek('ui')?.banner?.show('\u041f\u041e\u0414\u041a\u0420\u0415\u041f\u041b\u0415\u041d\u0418\u0415', `+${pending.length} \u043f\u0440\u043e\u0442\u0438\u0432\u043d\u0438\u043a\u043e\u0432`, 2.6);
  }

  /* =================================================================== */
  /* flag                                                                */
  /* =================================================================== */

  #buildFlag() {
    const rings = this.#rings();
    if (!rings) return;
    const group = new THREE.Group();
    group.name = 'ctf-flag';

    const poleGeo = new THREE.CylinderGeometry(0.035, 0.045, 2.3, 8);
    const clothGeo = new THREE.PlaneGeometry(0.9, 0.55);
    const auraGeo = new THREE.SphereGeometry(0.75, 16, 10);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.42, metalness: 0.85 });
    const clothMat = new THREE.MeshStandardMaterial({
      color: 0xb01c18, roughness: 0.78, metalness: 0,
      emissive: 0x40060a, emissiveIntensity: 0.7, side: THREE.DoubleSide,
    });
    const auraMat = new THREE.MeshBasicMaterial({ color: 0xff6a4a, transparent: true, opacity: 0.16, depthWrite: false });
    this._owned.push(poleGeo, clothGeo, auraGeo, poleMat, clothMat, auraMat);

    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.y = 1.15;
    pole.castShadow = true;
    const cloth = new THREE.Mesh(clothGeo, clothMat);
    cloth.position.set(0.47, 1.92, 0);
    const aura = new THREE.Mesh(auraGeo, auraMat);
    aura.position.y = 1.6;
    group.add(pole, cloth, aura);

    const homeTo = rings.gate.position.clone();
    group.position.copy(homeTo);
    this.root.add(group);

    this.flag = {
      group, cloth, aura,
      enemyBase: homeTo,
      ourBase: rings.home.position.clone(),
      state: 'base',
      droppedFor: 0,
      /** bot record currently walking the flag home, or null */
      recoverer: null,
      /** seconds the current bot carry has run; see CTF.botCarryTimeout */
      carriedFor: 0,
    };
  }

  #updateFlag(dt) {
    const f = this.flag;
    const player = this.ctx.peek('player');

    // Carrying is a commitment, so honour the speed penalty the CTF rules have
    // always declared. Derived from the flag's state every frame rather than
    // poked at each transition: capture, drop, death and round-end then all clear
    // it for free. Hooking the transitions one by one is exactly how a player
    // ends up permanently slowed after a round that ended mid-carry.
    const mv = player?.movement;
    if (mv) {
      const hauling = f?.state === 'carried' && this.match.state === 'live';
      mv.haulSpeedMul = hauling ? CTF.carrierSpeedMul : 1;
    }

    if (!f || this.match.state !== 'live') return;
    const pos = player?.position ?? null;

    f.cloth.rotation.y = Math.sin(this.match.clock * 2.0) * 0.16;
    f.aura.material.opacity = 0.12 + 0.08 * (0.5 + 0.5 * Math.sin(this.match.clock * 3.0));

    if (!pos) return;

    if (f.state === 'carried') {
      f.group.position.set(pos.x, pos.y + 1.05, pos.z);
      const d = this._v.set(pos.x, 0, pos.z).distanceTo(this._v2.copy(f.ourBase).setY(0));
      if (d < CTF.deliverRadius) {
        f.state = 'base';
        f.group.position.copy(f.enemyBase);
        this.match.capture(YOU);
        this.ctx.events.emit('modes:capture', { by: YOU });
        this.ctx.peek('ui')?.banner?.show('\u0424\u041b\u0410\u0413 \u0417\u0410\u0425\u0412\u0410\u0427\u0415\u041d', `+${500} \u043e\u0447\u043a\u043e\u0432`, 3.2);
      }
      return;
    }

    if (f.state === 'botCarried') {
      // Runs BEFORE the recoverer-release branch below on purpose: that branch
      // exists to void a stale errand, and letting it see 'botCarried' would
      // cancel the carry it is supposed to be running.
      this.#updateBotCarry(f, dt);
      // No early return - the player is allowed to chase the courier down and
      // take it off them, handled by the shared pickup check at the bottom.
    } else if (f.state === 'dropped') {
      f.droppedFor += dt;
      if (f.droppedFor >= CTF.dropResetTime) {
        f.state = 'base';
        f.droppedFor = 0;
        this.#releaseRecoverer(f);
        f.group.position.copy(f.enemyBase);
        this.ctx.peek('ui')?.banner?.show('\u0424\u041b\u0410\u0413 \u0412\u0415\u0420\u041d\u0423\u041b\u0421\u042f', '\u041d\u0430 \u0431\u0430\u0437\u0435 \u0432\u0440\u0430\u0433\u0430', 2.4);
      } else {
        this.#recoverFlag(f);
      }
    } else if (f.recoverer) {
      // Back at base or in the player's hands: any outstanding errand is void.
      this.#releaseRecoverer(f);
    }

    // Flag already home needs no pickup check, and running one would let the
    // player re-take it from inside their own base the instant it resets.
    if (f.state === 'carried') return;

    const dist = this._v.set(pos.x, 0, pos.z).distanceTo(this._v2.copy(f.group.position).setY(0));
    if (dist < CTF.pickupRadius) {
      const stolen = f.state === 'botCarried';
      f.state = 'carried';
      f.droppedFor = 0;
      f.carriedFor = 0;
      this.#releaseRecoverer(f);
      this.match.award(YOU, 'flagPickup');
      this.ctx.peek('ui')?.banner?.show(
        stolen ? '\u0424\u041b\u0410\u0413 \u041e\u0422\u0411\u0418\u0422' : '\u0424\u041b\u0410\u0413 \u0412\u0417\u042f\u0422',
        '\u041d\u0435\u0441\u0438 \u043d\u0430 \u0441\u0432\u043e\u044e \u0431\u0430\u0437\u0443', 2.8,
      );
    }
  }

  /** Let the current courier go back to fighting. Safe when there is none. */
  #releaseRecoverer(f) {
    if (!f.recoverer) return;
    if (f.recoverer.agent.alive) f.recoverer.agent.clearErrand();
    f.recoverer = null;
  }

  /**
   * The garrison contests a dropped flag: the nearest bot walks over, picks it up
   * and carries it home, which beats waiting out the 30s auto-return and makes
   * losing the flag mid-run actually cost something.
   *
   * The bot cannot SCORE with it - only the player captures - so this is purely
   * denial. That keeps the mode readable (one flag, one scorer) while removing
   * the old situation where dropping the flag was free.
   */
  #recoverFlag(f) {
    const flagPos = this._v.copy(f.group.position).setY(0);

    // Release the chosen courier if it died, or if it is pinned in a fight.
    // The second half matters more than it looks: assignErrand deliberately will
    // not yank a bot out of combat, so a courier that gets into a firefight stops
    // walking - and while it stays chosen, nobody else is considered either. The
    // flag would then just sit there until the 30s auto-return, which reads as
    // the garrison ignoring it. Letting it go lets a free bot take the job.
    const cur = f.recoverer;
    if (cur && !cur.agent.canErrand) {
      this.#releaseRecoverer(f);
    }

    if (!f.recoverer) {
      let best = null;
      let bestD = CTF.botRecoverRadius;
      for (const b of this.bots) {
        if (!b.agent.canErrand) continue;
        const d = this._v2.copy(b.agent.position).setY(0).distanceTo(flagPos);
        if (d < bestD) { bestD = d; best = b; }
      }
      if (!best) return;
      f.recoverer = best;
    }

    const rec = f.recoverer;
    const agent = rec.agent;

    // Close enough to take it. The bot then walks it back to the flag's own home
    // rather than to a bot spawn, so the destination matches where the flag would
    // have auto-returned to anyway.
    const d = this._v2.copy(agent.position).setY(0).distanceTo(flagPos);
    if (d < CTF.pickupRadius) {
      f.state = 'botCarried';
      f.droppedFor = 0;
      // Start the trip clock here, at the one place a carry can begin, so a
      // previous courier's elapsed time can never shorten this one.
      f.carriedFor = 0;
      agent.assignErrand(f.enemyBase);
      this.ctx.peek('ui')?.banner?.show('\u0424\u041b\u0410\u0413 \u041f\u0415\u0420\u0415\u0425\u0412\u0410\u0427\u0415\u041d', '\u041f\u0440\u043e\u0442\u0438\u0432\u043d\u0438\u043a \u043d\u0435\u0441\u0451\u0442 \u0435\u0433\u043e \u043d\u0430\u0437\u0430\u0434', 2.6);
      return;
    }

    // Re-assert every frame. assignErrand only re-enters ERRAND from the idle-ish
    // states, so this never interrupts a firefight; it just means a bot that
    // finishes one resumes the errand without the mode tracking that itself.
    agent.assignErrand(f.group.position);
  }

  /**
   * A bot is walking the flag home. If it dies the flag drops where it fell and
   * is contestable again; if it arrives, the flag is simply back at base.
   */
  #updateBotCarry(f, dt) {
    const rec = f.recoverer;

    // The only auto-return this state has. A courier that cannot finish - lost its
    // errand, cornered, wedged on geometry - must not keep the flag out of play
    // for the rest of the match, so the trip is time-boxed.
    f.carriedFor = (f.carriedFor ?? 0) + dt;
    if (f.carriedFor >= CTF.botCarryTimeout) {
      f.state = 'base';
      f.carriedFor = 0;
      f.droppedFor = 0;
      f.group.position.copy(f.enemyBase);
      this.#releaseRecoverer(f);
      this.ctx.peek('ui')?.banner?.show('\u0424\u041b\u0410\u0413 \u0412\u0415\u0420\u041d\u0423\u041b\u0421\u042f', '\u041d\u0430 \u0431\u0430\u0437\u0435 \u0432\u0440\u0430\u0433\u0430', 2.4);
      return;
    }

    if (!rec || !rec.agent.alive) {
      // Killed the courier: the flag falls here and the 30s clock restarts.
      f.state = 'dropped';
      f.droppedFor = 0;
      f.carriedFor = 0;
      f.recoverer = null;
      if (rec) f.group.position.set(rec.agent.position.x, 0.35, rec.agent.position.z);
      this.match.award(YOU, 'flagReturn');
      this.ctx.peek('ui')?.banner?.show('\u041a\u0423\u0420\u042c\u0415\u0420 \u0423\u0411\u0418\u0422', '\u0424\u043b\u0430\u0433 \u0441\u043d\u043e\u0432\u0430 \u043d\u0430 \u0437\u0435\u043c\u043b\u0435', 2.4);
      return;
    }

    const agent = rec.agent;
    f.group.position.set(agent.position.x, agent.position.y + 1.05, agent.position.z);
    agent.assignErrand(f.enemyBase);

    const home = this._v.copy(f.enemyBase).setY(0);
    // botDeliverRadius, not deliverRadius: the courier stops at the foot of the
    // plinth because the nav grid forbids the climb, so the player's tighter
    // radius would never be satisfied.
    if (this._v2.copy(agent.position).setY(0).distanceTo(home) < CTF.botDeliverRadius) {
      f.state = 'base';
      f.carriedFor = 0;
      f.droppedFor = 0;
      f.group.position.copy(f.enemyBase);
      agent.clearErrand();
      f.recoverer = null;
      this.ctx.peek('ui')?.banner?.show('\u0424\u041b\u0410\u0413 \u0412\u0415\u0420\u041d\u0423\u041b\u0421\u042f', '\u041f\u0440\u043e\u0442\u0438\u0432\u043d\u0438\u043a \u0434\u043e\u043d\u0451\u0441 \u0435\u0433\u043e', 2.6);
    }
  }

  #dropFlag() {
    const f = this.flag;
    if (!f || f.state !== 'carried') return;
    f.state = 'dropped';
    f.droppedFor = 0;
    f.group.position.y = Math.max(0, f.group.position.y - 0.9);
  }

  /* =================================================================== */
  /* deaths                                                              */
  /* =================================================================== */

  #onActorDeath(e) {
    const rec = e?.actor ? this._byAgent.get(e.actor) : null;
    if (!rec) return;
    // The HUD already draws its own killfeed row off actor:death; scoring is
    // ours. Registering it twice is how you end up with double kill counts.
    this.match.registerKill({ killer: YOU, victim: rec.id, headshot: !!e.headshot, weapon: e.weapon ?? null });
    const me = this.match.players.get(YOU);
    if (me && me.streak > 0 && me.streak % 3 === 0) {
      this.ctx.peek('ui')?.banner?.show(`\u0421\u0415\u0420\u0418\u042f \u00d7${me.streak}`, '\u0411\u0435\u0437 \u0441\u043c\u0435\u0440\u0442\u0435\u0439', 2.2);
    }
    if (this.modeId === 'bots' && this.submode === 'dm' && this.aliveBots() === 0) {
      this.match.fieldCleared();
    }
  }

  #playerDied() {
    this.#dropFlag();
    this.match.registerKill({ killer: null, victim: YOU });
  }

  #respawnPlayer() {
    const player = this.ctx.peek('player');
    if (!player) return;
    player.health?.reset?.(true);
    player.respawn?.(0);
    this._wasDead = false;
  }

  /* =================================================================== */
  /* frame                                                               */
  /* =================================================================== */

  update(dt, ctx) {
    const m = this.match;
    if (!m) return;

    const player = ctx.peek('player');
    const dead = !!player?.health?.dead;
    if (dead && !this._wasDead) {
      this._wasDead = true;
      this.#playerDied();
    }

    const due = m.tick(dt);
    for (const id of due) if (id === YOU) this.#respawnPlayer();

    if (this.modeId === 'bots') this.#maybeReleaseReserve();
    if (this.mode.autobalance) m.applyBalance();
    this.#updateFlag(dt);

    this._hudTimer -= dt;
    if (this._hudTimer <= 0) {
      this._hudTimer = HUD_PERIOD;
      this.#hud();
    }

    if (m.state === 'over' && !this._ended) {
      this._ended = true;
      this.#announceEnd();
    }
  }

  #hud() {
    const ui = this.ctx.peek('ui');
    if (!ui?.setMatch) return;
    const m = this.match;
    if (this.modeId === 'bots') {
      ui.setMatch({
        scoreUs: m.teams.get(0).kills,
        scoreThem: this.aliveBots(),
        timeLeft: m.timeLeft(),
        mode: this.submode === 'ctf' ? '\u0417\u0410\u0425\u0412\u0410\u0422 \u0424\u041b\u0410\u0413\u0410' : 'DEATHMATCH',
      });
      return;
    }
    ui.setMatch({
      scoreUs: this.modeId === 'duel' ? m.teams.get(0).rounds : m.teams.get(0).kills,
      scoreThem: this.modeId === 'duel' ? m.teams.get(1).rounds : m.teams.get(1).kills,
      timeLeft: m.timeLeft(),
      mode: this.mode.label,
    });
  }

  #announceEnd() {
    const m = this.match;
    const snap = this.snapshot();
    const won = m.winner === 0;
    const title = m.winner === null ? '\u041d\u0418\u0427\u042c\u042f' : won ? '\u041f\u041e\u0411\u0415\u0414\u0410' : '\u041f\u041e\u0420\u0410\u0416\u0415\u041d\u0418\u0415';
    const mvp = snap.mvp;
    this.ctx.peek('ui')?.banner?.show(title, mvp ? `\u041b\u0423\u0427\u0428\u0418\u0419: ${mvp.name} \u00b7 ${mvp.score}` : '', 6);
    this.ctx.events.emit('modes:over', snap);
  }

  /* ---------------- bridge from src/net ----------------
   * In duel and squad the RELAY is the authority: it counts the rounds, it
   * decides when the match is over and it may run a different format than
   * rules.js defaults to. These entry points let net/ write those verdicts
   * into the same Match object that bots mode drives locally, so the HUD,
   * the scoreboard and the end screen keep exactly one source of truth. */

  adoptRemoteFormat(o = {}) {
    if (Number.isFinite(o.roundsToWin) && o.roundsToWin > 0) {
      this.match.roundsToWin = o.roundsToWin;
    }
    if (o.team === 0 || o.team === 1) {
      const me = this.match.players.get(YOU);
      if (me) me.team = o.team;
    }
    return this.match.roundsToWin;
  }

  addRemotePlayer(o = {}) {
    if (!o.id || this.match.players.has(o.id)) return null;
    return this.match.addPlayer({ id: o.id, name: o.name || o.id, team: o.team ?? 1, bot: false });
  }

  /* Squad: the relay already de-duplicated the death with its own +2/+3
   * guard, so this is scored once and never re-derived from actor:death. */
  remoteKill(o = {}) {
    if (!o.victim || !this.match.players.has(o.victim)) return null;
    if (o.killer && !this.match.players.has(o.killer)) {
      const vt = this.match.players.get(o.victim)?.team ?? 0;
      this.addRemotePlayer({ id: o.killer, name: o.killer, team: 1 - vt });
    }
    return this.match.registerKill({ killer: o.killer || null, victim: o.victim });
  }

  /* Duel: a round ended. The relay sends ABSOLUTE scores, so we assign them
   * rather than incrementing - one dropped message would desync a counter. */
  remoteRoundOver(o = {}) {
    if (Number.isFinite(o.roundsToWin) && o.roundsToWin > 0) this.match.roundsToWin = o.roundsToWin;
    if (o.victim) this.remoteKill(o);
    const myName = this.match.players.get(YOU)?.name;
    for (const [nick, wins] of Object.entries(o.scores || {})) {
      const id = nick === myName ? YOU : nick;
      const team = this.match.players.get(id)?.team;
      const t = team === undefined ? null : this.match.teams.get(team);
      if (t) t.rounds = wins;
    }
    return this.match.round;
  }

  remoteMatchOver(o = {}) {
    const me = this.match.players.get(YOU);
    const mine = o.winner && me ? o.winner === me.name : null;
    this.match.state = 'over';
    this.match.endReason = 'remote';
    this.match.winner = mine === null ? null : mine ? me.team : 1 - me.team;
    this.#announceEnd();
    return this.match.winner;
  }

  snapshot() {
    const snap = this.match ? this.match.snapshot() : null;
    if (snap) snap.botsAlive = this.aliveBots();
    return snap;
  }

  dispose() {
    for (const off of this._unsubs ?? []) off();
    this._unsubs = [];
    if (this.flag) {
      this.root.remove(this.flag.group);
      this.flag = null;
    }
    for (const res of this._owned ?? []) res.dispose?.();
    this._owned = [];
    if (this.root) {
      this.ctx.scene.remove(this.root);
      this.root = null;
    }
    this._byAgent?.clear();
    this.bots = [];
    this.reserve = [];
  }
}
