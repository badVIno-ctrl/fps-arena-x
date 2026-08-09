import * as THREE from 'three';
import { buildArsenalModel } from '../arsenal/models/build.js';
import { meshifyAssembly, disposeNode } from '../arsenal/mesh.js';
import { HardwareRig } from '../arsenal/hardware/rig.js';
import { defaultLoadout } from '../arsenal/attachments.js';
import { clamp, damp } from '../ui/util.js';

/**
 * SHELL / gunsmith preview.
 *
 * The gun on the board is the REAL weapon: the same `buildArsenalModel` output
 * and the same `HardwareRig` the player carries into the match. Nothing here is
 * a render of a render — mount a suppressor on the board and you are looking at
 * the geometry that will be on the muzzle in game, which is the whole point of
 * a gunsmith screen and the reason a pre-baked sprite sheet was not an option.
 *
 * It draws into a scissored rectangle of the main canvas rather than a second
 * WebGLRenderer, because a second context means a second copy of every material,
 * every shader program and every texture — tens of megabytes and a fresh round
 * of compile stalls, for the same pixels.
 *
 * Light budget: exactly three directional lights, created in the constructor and
 * never added or removed. Directional, not point — so this scene contributes
 * nothing to the point-light count the world materials are compiled against.
 */

const IDLE_SPIN = 0.17;
const DRAG_YAW = 0.0085;
const DRAG_PITCH = 0.006;
const PITCH_LIMIT = 0.6;

/** Tolerant node seating: `nodesOf` yields {pos,rot}, older specs yield [x,y,z]. */
function applyNode(obj, n) {
  if (!n) return;
  const pos = Array.isArray(n) ? n : n.pos;
  const rot = Array.isArray(n) ? null : n.rot;
  if (pos) obj.position.set(pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0);
  if (rot) obj.rotation.set(rot[0] ?? 0, rot[1] ?? 0, rot[2] ?? 0);
}

export class BenchPreview {
  /**
   * @param {object} o
   * @param {THREE.WebGLRenderer} o.renderer
   * @param {(key: string) => THREE.Material} o.material weapon material bank
   */
  constructor(o) {
    this.renderer = o.renderer;
    this.materialFor = o.material;

    this.scene = new THREE.Scene();
    this.scene.name = 'gunsmith-preview';

    this.camera = new THREE.PerspectiveCamera(26, 1, 0.02, 12);
    this.camera.position.set(0, 0.03, 0.92);
    this.camera.lookAt(0, 0, 0);

    /** Turntable: yaw/pitch live here, the gun itself is never re-parented. */
    this.spin = new THREE.Group();
    this.spin.name = 'preview-turntable';
    this.scene.add(this.spin);

    /** Recentring node — each weapon is a different length, see #frame(). */
    this.mount = new THREE.Group();
    this.mount.name = 'preview-mount';
    this.spin.add(this.mount);

    /**
     * THE STUDIO — three directional lights and an ambient term, and the count
     * is load-bearing rather than aesthetic.
     *
     * three.js folds the number of lights OF EACH PUNCTUAL TYPE into the shader
     * program cache key. This scene borrows the weapon material bank on purpose,
     * so that the gun on the board is shaded by exactly the materials that will be
     * in the player's hands — which means every light added here mints a fresh
     * program permutation for ~20 materials, and those programs compile on the
     * frame the board opens. That is a multi-second stall in the middle of the
     * game: the reported "ухожу на доску, и назад выйти не могу". So the gate in
     * tools/verify-gunsmith.mjs pins this at three directional and zero punctual,
     * and brightness has to come from intensity rather than from more lamps.
     *
     * AmbientLight is the exception and the reason it is used here: it is a single
     * `ambientLightColor` uniform that every lit program already carries, so it is
     * free. A HemisphereLight would NOT be — it adds `numHemiLights` to the key.
     *
     * The intensities are 3-4x what they were, which is a bug fix and not a taste
     * change. Every material in the weapon bank is calibrated about ten times
     * under physical albedo, deliberately, because the VIEWMODEL light rig
     * delivers roughly twenty times the world's irradiance per unit albedo (see
     * the long note on `glove` in weapons/materials.js). This preview lit those
     * crushed materials with three ordinary lamps at 2.7/0.8/1.5 and the result
     * was measured on screen: an М416 whose receiver sat at luminance 20-30
     * against a 0x0b0e13 backdrop at 14. The weapon was drawn correctly and was
     * simply too dark to see, which is the whole of "оружие на доске не
     * отображается".
     *
     * `fill` is also re-aimed much further toward the camera. The classic
     * three-point rig leaves everything facing the viewer squarely — the receiver
     * flat, the magazine's outer face, every rollmark — lit only at grazing
     * incidence, and that is precisely where the detail the player came to look
     * at lives.
     */
    this.key = new THREE.DirectionalLight(0xfff2e0, 10.5);
    this.key.position.set(0.62, 0.78, 0.72);
    this.fill = new THREE.DirectionalLight(0xbcd6f2, 5.6);
    this.fill.position.set(-0.62, 0.16, 0.88);
    this.rim = new THREE.DirectionalLight(0xffd7a8, 5.8);
    this.rim.position.set(-0.34, 0.42, -0.95);
    for (const l of [this.key, this.fill, this.rim]) {
      l.castShadow = false;
      this.scene.add(l);
    }
    /**
     * Fills the downward-facing surfaces — the magazine floor plate, the trigger
     * guard's underside, the whole belly of the weapon — which a directional-only
     * rig leaves at absolute zero, where they read as a hole cut in the gun
     * rather than as shadow.
     */
    this.ambient = new THREE.AmbientLight(0x8ea6bd, 1.15);
    this.scene.add(this.ambient);

    /** weaponId -> { model, node, rig } */
    this.built = new Map();
    this.current = null;

    this.yaw = -0.72;
    this.pitch = 0.1;
    this.targetYaw = -0.72;
    this.targetPitch = 0.1;
    this.dragging = false;

    // Preallocated scratch for render(): no per-frame allocation.
    this._vp = new THREE.Vector4();
    this._sc = new THREE.Vector4();
    this._box = new THREE.Box3();
    this._size = new THREE.Vector3();
    this._centre = new THREE.Vector3();
    this._aim = { hitDistance: 3.4, hitPoint: null };
    this.disposed = false;
  }

  /* ---------------------------------------------------------------- weapon */

  /**
   * Show `def`'s weapon, building it on first request and caching afterwards.
   * Switching back to a weapon the player already looked at is instant.
   */
  setWeapon(def) {
    const id = def.id;
    if (this.current && this.current.id === id) return this.current;

    if (this.current) this.current.node.visible = false;

    let entry = this.built.get(id);
    if (!entry) {
      const model = buildArsenalModel(id);
      const node = new THREE.Group();
      node.name = `preview-${id}`;

      const body = meshifyAssembly(model.body, this.materialFor, { receiveShadow: false });
      node.add(body);

      const parts = {};
      for (const [name, asm] of Object.entries(model.moving)) {
        const sub = meshifyAssembly(asm, this.materialFor, { receiveShadow: false });
        sub.name = `preview-${id}-${name}`;
        node.add(sub);
        parts[name] = sub;
      }
      const n = model.nodes;
      applyNode(parts.magazine, n.magSeat);
      applyNode(parts.charging, n.chargeRest);
      applyNode(parts.bolt, n.boltRest);

      this.mount.add(node);
      const rig = new HardwareRig({ weaponId: id, root: node, material: this.materialFor });
      rig.bind(def);
      // First sight of a weapon on the board shows it already built, not
      // assembling itself.
      rig.setLoadout(defaultLoadout(def), { animate: false });

      entry = { id, def, model, node, parts, rig };
      this.built.set(id, entry);
    }

    entry.node.visible = true;
    this.current = entry;
    this.#frame(entry);
    return entry;
  }

  /** Apply a loadout to the shown weapon. @returns {string[]} rejected ids */
  setLoadout(loadout) {
    if (!this.current) return [];
    const rejected = this.current.rig.setLoadout(loadout);
    this.#frame(this.current);
    return rejected;
  }

  /** Mount one part, for a single click on the board. */
  swap(slot, attId) {
    if (!this.current) return { ok: false, reason: 'no weapon' };
    const r = this.current.rig.swap(slot, attId);
    this.#frame(this.current);
    return r;
  }

  loadout() {
    return this.current ? this.current.rig.loadout() : {};
  }

  stats() {
    return this.current ? this.current.rig.stats() : null;
  }

  issues() {
    return this.current ? this.current.rig.issues() : [];
  }

  /**
   * Fit the weapon in the frame.
   *
   * Recomputed after every mount, because a 168 mm suppressor genuinely changes
   * the silhouette: without this the can hangs out of the panel, which looks
   * like a bug even though the geometry is right.
   */
  #frame(entry) {
    entry.node.position.set(0, 0, 0);
    entry.node.scale.setScalar(1);
    entry.node.updateMatrixWorld(true);

    this._box.setFromObject(entry.node);
    if (this._box.isEmpty()) return;
    this._box.getSize(this._size);
    this._box.getCenter(this._centre);

    // Longest axis decides the fit; 0.62 leaves margin for the rotation sweep
    // so the muzzle never clips the panel edge mid-spin.
    const span = Math.max(this._size.x, this._size.y, this._size.z) || 1;
    const scale = 0.62 / span;
    entry.node.scale.setScalar(scale);
    entry.node.position.set(
      -this._centre.x * scale,
      -this._centre.y * scale,
      -this._centre.z * scale
    );
  }

  /* --------------------------------------------------------------- prewarm */

  /**
   * Compile this scene's programs before the player ever opens the board.
   *
   * WHY IT IS NEEDED. three.js compiles a program the first time a given
   * (material, light counts, shadow, fog, ...) permutation is actually drawn. The
   * weapon materials are drawn during play under the WORLD's lighting — a CSM
   * directional plus however many point lights are visible — and here under three
   * directional lights and no punctual lights at all. Different key, different
   * program. So every material on the weapon compiled on the frame the board
   * opened, which on a mid-range laptop is 15-25 programs on one frame and
   * hundreds of milliseconds to seconds of frozen screen.
   *
   * That is the mechanism behind "ухожу на доску, и назад выйти не могу. Игра
   * зависает": nothing was deadlocked, the main thread was inside the GL driver
   * compiling shaders, twice — once opening and once returning. The pause menu is
   * plain DOM and never had the problem, which is exactly why the board did.
   *
   * ONE weapon is enough. All nine share the same material bank, and the
   * permutation key does not include geometry.
   *
   * Called from `ShellSystem.prewarmMaterials()`, which core/prewarm.js discovers
   * by duck typing, so this runs behind the loading bar with the other ~120
   * programs instead of in the middle of a firefight.
   */
  async prewarm(def) {
    if (this.disposed || !def) return { ok: false, reason: 'disposed' };
    const r = this.renderer;
    const before = r.info.programs?.length ?? 0;
    this.setWeapon(def);
    // The canvas variant is the right one: render() draws with the default
    // framebuffer bound, and three folds output colour space and tone mapping —
    // both read off the bound target — into the cache key.
    const prev = r.getRenderTarget();
    r.setRenderTarget(null);
    try {
      await r.compileAsync(this.scene, this.camera);
    } catch {
      try {
        r.compile(this.scene, this.camera);
      } catch {
        /* a driver without parallel compile and without compile(): nothing left
           to try, and a failed prewarm must never block boot. */
      }
    } finally {
      r.setRenderTarget(prev);
    }
    return { ok: true, compiled: (r.info.programs?.length ?? 0) - before };
  }

  /* ------------------------------------------------------------------ input */

  beginDrag() {
    this.dragging = true;
  }

  drag(dx, dy) {
    if (!this.dragging) return;
    this.targetYaw -= dx * DRAG_YAW;
    this.targetPitch = clamp(this.targetPitch + dy * DRAG_PITCH, -PITCH_LIMIT, PITCH_LIMIT);
  }

  endDrag() {
    this.dragging = false;
  }

  /* ----------------------------------------------------------------- frame */

  /** Unscaled dt: the board freezes the game clock but the turntable still turns. */
  update(rawDt) {
    if (this.disposed) return;
    if (!this.dragging) this.targetYaw += IDLE_SPIN * rawDt;
    this.yaw = damp(this.yaw, this.targetYaw, 9, rawDt);
    this.pitch = damp(this.pitch, this.targetPitch, 9, rawDt);
    this.spin.rotation.set(this.pitch, this.yaw, 0);
    this.current?.rig.update(rawDt, this._aim);
  }

  /**
   * Draw into a CSS-pixel rectangle of the main canvas.
   *
   * Renderer state is saved and restored around the call: the render system
   * hands out its WebGLRenderer with autoClear disabled and warns against
   * changing state mid-frame, so this runs after the composite, clears only
   * depth, and puts the viewport and scissor back exactly as they were.
   */
  render(rect) {
    if (this.disposed || !this.current || !rect || rect.width < 4 || rect.height < 4) return;
    const r = this.renderer;
    /**
     * These are CSS pixels, NOT device pixels.
     *
     * three.js multiplies whatever it is given by the renderer's pixel ratio
     * before handing it to gl.viewport/gl.scissor (see `state.viewport(
     * ...multiplyScalar(_pixelRatio))` in WebGLRenderer). Scaling by the DPR here
     * as well applied it twice, so on any retina display the panel was drawn at
     * double the offset and double the size and missed its rectangle entirely —
     * the board looked empty on exactly the machines most people use, while
     * testing fine at dpr 1. The DOM rect is already in CSS pixels, so it can go
     * straight through; only the canvas height needs converting back.
     */
    const h = r.domElement.height / r.getPixelRatio();

    const x = rect.left;
    const w = rect.width;
    const hh = rect.height;
    // WebGL's origin is bottom-left, the DOM rect's is top-left.
    const y = h - rect.top - hh;

    const aspect = w / hh;
    if (Math.abs(this.camera.aspect - aspect) > 1e-4) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }

    r.getViewport(this._vp);
    r.getScissor(this._sc);
    const hadScissor = r.getScissorTest();
    const prevTarget = r.getRenderTarget();

    r.setRenderTarget(null);
    r.setViewport(x, y, w, hh);
    r.setScissor(x, y, w, hh);
    r.setScissorTest(true);
    r.clearDepth();
    r.render(this.scene, this.camera);

    r.setScissorTest(hadScissor);
    r.setScissor(this._sc.x, this._sc.y, this._sc.z, this._sc.w);
    r.setViewport(this._vp.x, this._vp.y, this._vp.z, this._vp.w);
    r.setRenderTarget(prevTarget);
  }

  /* --------------------------------------------------------------- teardown */

  dispose() {
    if (this.disposed) return;
    for (const entry of this.built.values()) {
      entry.rig.dispose();
      disposeNode(entry.node);
    }
    this.built.clear();
    this.current = null;
    for (const l of [this.key, this.fill, this.rim, this.ambient]) l.parent?.remove(l);
    this.scene.remove(this.spin);
    this.disposed = true;
  }
}
