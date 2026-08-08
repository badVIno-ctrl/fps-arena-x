import * as THREE from 'three';
import { Registry, EventBus } from './registry.js';
import { FIXED_DT, MAX_SUBSTEPS } from './config.js';
import { Input } from './input.js';
import { Rng } from './rng.js';

/**
 * The Engine owns the frame loop and the shared context handed to every
 * subsystem. It does NOT know what any subsystem does — it only sequences them.
 *
 * Frame order:
 *   1. input.beginFrame()
 *   2. fixedUpdate(FIXED_DT) xN   — physics, deterministic gameplay
 *   3. update(dt)                 — animation, cameras, AI decisions
 *   4. lateUpdate(dt)             — anything that must observe final transforms
 *   5. render subsystem draws
 *   6. input.endFrame()
 */
export class Engine {
  constructor({ canvas, config }) {
    this.canvas = canvas;
    this.config = config;
    this.registry = new Registry();
    this.events = new EventBus();
    this.input = new Input(canvas, config);
    this.rng = new Rng(config.deterministic ? 0x5eed1234 : (Math.random() * 2 ** 32) >>> 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(config.fov, 1, 0.05, 1200);
    this.camera.rotation.order = 'YXZ';

    /** Separate scene+camera for the first-person viewmodel, drawn with its own
     *  near plane so hands/weapon never clip into world geometry. */
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(60, 1, 0.005, 12);

    this.time = {
      /** Seconds since start, scaled. */ elapsed: 0,
      /** Unscaled wall-clock seconds since start. */ raw: 0,
      /** Last frame delta, scaled and clamped. */ dt: 0,
      /** Fixed step. */ fixed: FIXED_DT,
      /** Interpolation alpha between the last two physics steps, 0..1. */ alpha: 0,
      scale: 1,
      frame: 0,

      /**
       * Owners currently holding the clock frozen.
       *
       * Freezing used to be each caller doing `prev = scale; scale = 0` and
       * restoring `prev` on the way out. With two independent freezers — the
       * pause menu and the gunsmith board — that corrupts as soon as they
       * overlap: the second one to open captures the already-zeroed scale, so
       * whichever closes last restores 0. The match then sits frozen with no
       * menu on screen and no way back, which is the "after pausing it just
       * never loads again" report.
       *
       * Reference counting by owner makes the order irrelevant: only the first
       * freeze records the live scale and only the last thaw restores it.
       */
      _freezes: new Set(),
      _scaleBeforeFreeze: 1,

      /** @param {string} owner  stable id, e.g. 'pause-menu' */
      freeze(owner) {
        if (this._freezes.has(owner)) return;
        // Capture before the first owner zeroes it, and never capture a 0 —
        // otherwise a stray freeze while already frozen would make 0 the
        // "resting" scale and the thaw would be a no-op.
        if (this._freezes.size === 0) this._scaleBeforeFreeze = this.scale || 1;
        this._freezes.add(owner);
        this.scale = 0;
      },

      /** Idempotent: thawing an owner that never froze does nothing. */
      thaw(owner) {
        if (!this._freezes.delete(owner)) return;
        if (this._freezes.size === 0) this.scale = this._scaleBeforeFreeze ?? 1;
      },

      get frozen() {
        return this._freezes.size > 0;
      },
    };

    this.ctx = {
      engine: this,
      scene: this.scene,
      camera: this.camera,
      viewScene: this.viewScene,
      viewCamera: this.viewCamera,
      canvas,
      config,
      events: this.events,
      input: this.input,
      time: this.time,
      rng: this.rng,
      get: (id) => this.registry.get(id),
      peek: (id) => this.registry.peek(id),
      has: (id) => this.registry.has(id),
    };

    this._accum = 0;
    this._last = 0;
    this._running = false;
    this._onResize = () => this.resize();
  }

  add(SystemClass, opts) {
    this.registry.add(new SystemClass(opts));
    return this;
  }

  /**
   * @param {(frac: number, label: string) => void} [onProgress]
   *   Called before each system initialises, with a 0..1 fraction and the
   *   system's id. Optional: the pixel gate and the node gates pass nothing.
   */
  async init(onProgress) {
    const order = this.registry.resolve();
    for (let i = 0; i < order.length; i++) {
      const sys = order[i];
      const t0 = performance.now();
      const id = sys.constructor.id ?? sys.constructor.name;
      onProgress?.(i / order.length, id);
      /**
       * Yield to the event loop between systems so the loading screen can
       * actually repaint.
       *
       * Reporting progress is not enough on its own: `await` on an already
       * resolved promise stays inside the same task, so the whole ~20 system
       * chain used to run without the browser ever getting a chance to paint.
       * The text would update in memory and the user would still stare at one
       * frozen frame for the entire boot, which is precisely the "looks hung"
       * symptom. A double rAF puts a real paint between systems.
       */
      if (onProgress && typeof requestAnimationFrame === 'function') {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      try {
        await sys.init?.(this.ctx);
      } catch (err) {
        // Without this the stack is just a minified frame inside the bundle and
        // says nothing about WHICH of the ~20 systems threw. Tag the failure
        // with the system id and rethrow so boot still aborts.
        err.message = `system "${id}" failed to init: ${err.message}`;
        throw err;
      }
      const ms = performance.now() - t0;
      if (ms > 50) console.info(`[engine] ${id} init ${ms.toFixed(0)}ms`);
    }
    onProgress?.(1, 'ready');
    this.input.attach();
    addEventListener('resize', this._onResize);
    this.resize();
    return this;
  }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth || innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
    for (const sys of this.registry.with('resize')) sys.resize(w, h, this.ctx);
    this.events.emit('resize', { width: w, height: h });
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  stop() {
    this._running = false;
  }

  _loop(now) {
    if (!this._running) return;
    requestAnimationFrame(this._loop);
    this.step(now);
  }

  /** Advance one frame. Exposed so the capture harness can pump frames by hand. */
  step(now = performance.now()) {
    const t = this.time;
    // Clamp so a tab-switch or a breakpoint doesn't teleport the simulation.
    const rawDt = Math.min(0.1, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    t.raw += rawDt;
    t.dt = rawDt * t.scale;
    t.elapsed += t.dt;
    t.frame++;

    this.input.beginFrame();

    this._accum += t.dt;
    let steps = 0;
    const fixedSystems = this.registry.with('fixedUpdate');
    while (this._accum >= FIXED_DT && steps < MAX_SUBSTEPS) {
      for (const sys of fixedSystems) sys.fixedUpdate(FIXED_DT, this.ctx);
      this._accum -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this._accum = 0; // shed backlog rather than spiral
    t.alpha = this._accum / FIXED_DT;

    for (const sys of this.registry.with('update')) sys.update(t.dt, this.ctx);
    for (const sys of this.registry.with('lateUpdate')) sys.lateUpdate(t.dt, this.ctx);

    const renderSystem = this.registry.peek('render');
    if (typeof renderSystem?.render === 'function') renderSystem.render(this.ctx);

    this.input.endFrame();
  }

  dispose() {
    this.stop();
    removeEventListener('resize', this._onResize);
    this.input.detach();
    for (const sys of [...this.registry.ordered].reverse()) sys.dispose?.();
    this.events.clear();
  }
}
