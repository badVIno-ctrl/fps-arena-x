import * as THREE from 'three';

/**
 * ===========================================================================
 * WEATHER
 * ===========================================================================
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS FILE IS BUILT AROUND
 * ---------------------------------------------------------------------------
 * Weather that only changes pixels is a filter. Weather that changes what the
 * ENEMY can do is a mechanic. So every preset below states four consequences,
 * and three of them are not visual:
 *
 *   `visibility`  metres at which the AI loses sight of you. Fog is cover.
 *   `soundMask`   how much of a footstep or a shot the rain swallows. Rain is
 *                 concealment for movement and a penalty for hearing.
 *   `wetness`     surfaces darken and gain a specular sheen — and this is what
 *                 makes a wet street READ as wet rather than as a blue filter.
 *   `rain`        the particle field, which is the part you notice first and the
 *                 least important of the four.
 *
 * A player who cannot tell that fog is helping them has been given a filter.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DRIVES, AND WHY NONE OF IT IS NEW MACHINERY
 * ---------------------------------------------------------------------------
 * Almost everything needed already existed and was static:
 *
 *   sky.setWeather()        turbidity, cloud coverage, fog density and height,
 *                           wind, god-ray gain. Documented, and nothing called
 *                           it with anything but the boot defaults.
 *   materials.tune(m,{weather})  every surface recipe carries a `weather` vector
 *                           — [dust, streak, splashHeight, cavityGrime] — and the
 *                           streak and splash channels are a rain-wetness model
 *                           that had never once been driven at runtime.
 *   ai.viewRangeScale / hearingScale   new, two numbers, read where the agent
 *                           already computes its own view range and loudness.
 *
 * So this subsystem is mostly a scheduler and a lerp. The rain field is the only
 * geometry it owns.
 *
 * PUBLIC API — `const w = ctx.get('weather')`
 *   w.set(name, { fade })   'clear' | 'overcast' | 'rain' | 'storm' | 'fog' | 'dust'
 *   w.current               the resolved live state (lerped, not the preset)
 *   w.preset                the name being blended toward
 *   w.visibility            metres — read by ai
 *   w.soundMask             0..1  — read by ai
 */

/**
 * The presets.
 *
 * Pure data with no three.js in it, so tools/verify-weather.mjs can assert the
 * relationships between them in node: that fog really does cut visibility below
 * clear, that rain really does mask more sound than overcast, and that no preset
 * is missing a field. A table where one entry quietly lacks `soundMask` is a
 * table where one weather type silently has no gameplay effect.
 */
export const PRESETS = {
  clear: {
    label: 'ЯСНО',
    sky: { turbidity: 1.35, cloudCoverage: 0.3, cirrus: 0.35, fogDensity: 1, fogHeight: 120, windSpeed: 2.5, shaftGain: 1 },
    wetness: 0,
    rain: 0,
    /** Metres. The AI's own `viewRange` is scaled so that it lands here. */
    visibility: 260,
    soundMask: 0,
    /** Multiplies the player's outgoing footstep loudness as heard by the AI. */
    ambientNoise: 0,
  },
  overcast: {
    label: 'ПАСМУРНО',
    sky: { turbidity: 2.1, cloudCoverage: 0.78, cirrus: 0.2, fogDensity: 1.6, fogHeight: 95, windSpeed: 5, shaftGain: 0.45 },
    wetness: 0.15,
    rain: 0,
    visibility: 200,
    soundMask: 0.05,
    ambientNoise: 0.1,
  },
  rain: {
    label: 'ДОЖДЬ',
    sky: { turbidity: 2.8, cloudCoverage: 0.92, cirrus: 0.1, fogDensity: 2.6, fogHeight: 70, windSpeed: 8, shaftGain: 0.2 },
    wetness: 0.85,
    rain: 0.6,
    visibility: 140,
    /**
     * Rain is the loudest thing in this table by design. A downpour is 55-65 dB
     * of broadband noise at head height, which is the same order as a footstep on
     * gravel — so it genuinely hides movement, and that is the tactical content of
     * the preset.
     */
    soundMask: 0.55,
    ambientNoise: 0.6,
  },
  storm: {
    label: 'ГРОЗА',
    sky: { turbidity: 3.4, cloudCoverage: 0.97, cirrus: 0.05, fogDensity: 3.4, fogHeight: 55, windSpeed: 14, shaftGain: 0.08 },
    wetness: 1,
    rain: 1,
    visibility: 95,
    soundMask: 0.78,
    ambientNoise: 0.85,
  },
  fog: {
    label: 'ТУМАН',
    sky: { turbidity: 2.4, cloudCoverage: 0.6, cirrus: 0.15, fogDensity: 7.5, fogHeight: 26, windSpeed: 1, shaftGain: 0.3 },
    wetness: 0.45,
    rain: 0,
    /**
     * The shortest sight line in the table, and it costs almost nothing in sound.
     * That asymmetry is the point: fog is the preset that rewards moving quietly
     * and punishes shooting at a noise, where rain is the opposite.
     */
    visibility: 55,
    soundMask: 0.05,
    ambientNoise: 0.05,
  },
  dust: {
    label: 'ПЫЛЬ',
    sky: { turbidity: 5.2, cloudCoverage: 0.35, cirrus: 0.1, fogDensity: 5, fogHeight: 40, windSpeed: 12, shaftGain: 0.6 },
    wetness: 0,
    rain: 0,
    visibility: 80,
    soundMask: 0.3,
    ambientNoise: 0.4,
  },
};

export const PRESET_ORDER = ['clear', 'overcast', 'rain', 'storm', 'fog', 'dust'];

/** Every field a preset has to declare. The gate walks this. */
export const PRESET_FIELDS = ['label', 'sky', 'wetness', 'rain', 'visibility', 'soundMask', 'ambientNoise'];

/**
 * Blend two presets. Pure, so the gate can check the midpoint of every pair.
 *
 * `label` and the sky patch are interpolated field by field rather than snapped,
 * because a fog bank rolling in over eight seconds is the difference between
 * weather and a light switch.
 */
export function blend(a, b, t) {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const out = {
    label: k < 0.5 ? a.label : b.label,
    wetness: a.wetness + (b.wetness - a.wetness) * k,
    rain: a.rain + (b.rain - a.rain) * k,
    visibility: a.visibility + (b.visibility - a.visibility) * k,
    soundMask: a.soundMask + (b.soundMask - a.soundMask) * k,
    ambientNoise: a.ambientNoise + (b.ambientNoise - a.ambientNoise) * k,
    sky: {},
  };
  for (const key of Object.keys(a.sky)) {
    const av = a.sky[key];
    const bv = b.sky[key] ?? av;
    out.sky[key] = av + (bv - av) * k;
  }
  return out;
}

/**
 * The surface `weather` vector for a wetness level.
 *
 * [dust, streak, splashHeight, cavityGrime] — the shader's own channels. Streak
 * is vertical runoff on walls, splashHeight is how far up a surface the ground
 * spray reaches, and cavityGrime darkens crevices. Dust goes DOWN as wetness goes
 * up, because rain washes it off, and that inverse relationship is the cheapest
 * way to make "it has been raining" legible on a dry-looking wall.
 */
export function surfaceWeather(wetness, dustiness = 0) {
  const w = wetness < 0 ? 0 : wetness > 1 ? 1 : wetness;
  return [
    0.35 * (1 - w * 0.85) + dustiness * 0.6,
    0.05 + w * 0.95,
    0.2 + w * 0.75,
    0.4 + w * 0.4,
  ];
}

/** How far the AI can see, given a preset's visibility and its own base range. */
export function viewScaleFor(visibility, baseRange = 260) {
  return Math.max(0.18, Math.min(1, visibility / baseRange));
}

/** How much quieter the world is to the AI. 1 = normal hearing. */
export function hearingScaleFor(soundMask) {
  const m = soundMask < 0 ? 0 : soundMask > 1 ? 1 : soundMask;
  return 1 - m * 0.72;
}

/* -------------------------------------------------------------------------- */
/*  the rain field                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Rain, as one instanced draw.
 *
 * A BOX THAT FOLLOWS THE CAMERA, not a world-sized emitter: rain only has to
 * exist where it can be seen, and a 24 m cube around the eye holds every drop
 * that will ever be on screen. Drops wrap within the box, so there is no
 * spawning, no pooling and no allocation after init.
 *
 * Each drop is a thin quad stretched along its own velocity. That stretch is why
 * rain reads as rain rather than as falling dots: a real raindrop at 6 m/s
 * crosses several centimetres during one 16 ms exposure, so it is photographed as
 * a streak. Making the streak length proportional to speed is therefore not
 * stylisation, it is motion blur done for free.
 */
class RainField {
  constructor(count) {
    this.count = count;
    this.half = 12;
    const geo = new THREE.PlaneGeometry(1, 1);
    // Anchor the quad at its TOP edge so scaling Y stretches it downward, which
    // keeps the head of the streak on the drop's actual position.
    geo.translate(0, -0.5, 0);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = geo.index;
    this.geometry.attributes.position = geo.attributes.position;
    this.geometry.attributes.uv = geo.attributes.uv;
    geo.dispose();

    this.offsets = new Float32Array(count * 3);
    this.params = new Float32Array(count * 2); // x = speed, y = length
    for (let i = 0; i < count; i++) {
      this.offsets[i * 3] = (Math.random() - 0.5) * this.half * 2;
      this.offsets[i * 3 + 1] = Math.random() * this.half * 2;
      this.offsets[i * 3 + 2] = (Math.random() - 0.5) * this.half * 2;
      // Drop size and terminal velocity correlate in reality: big drops fall
      // faster. One random number therefore drives both.
      const big = Math.random();
      this.params[i * 2] = 5.5 + big * 4.5;
      this.params[i * 2 + 1] = 0.22 + big * 0.5;
    }
    this.geometry.setAttribute('aOffset', new THREE.InstancedBufferAttribute(this.offsets, 3));
    this.geometry.setAttribute('aParam', new THREE.InstancedBufferAttribute(this.params, 2));
    this.geometry.instanceCount = count;
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), this.half * 2);

    this.uniforms = {
      uTime: { value: 0 },
      uEye: { value: new THREE.Vector3() },
      /** x = intensity 0..1, y = box half size, z = wind x, w = wind z */
      uState: { value: new THREE.Vector4(0, this.half, 0, 0) },
      // Slightly cool: a drop is reflecting the sky, not the ground.
      uColor: { value: new THREE.Color(0.72, 0.80, 0.92) },
    };

    this.material = new THREE.ShaderMaterial({
      name: 'weather:rain',
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        attribute vec2 aParam;
        uniform float uTime;
        uniform vec3 uEye;
        uniform vec4 uState;
        varying float vFade;
        varying vec2 vUv;
        void main() {
          float half = uState.y;
          float span = half * 2.0;
          vec3 wind = vec3(uState.z, 0.0, uState.w);
          // Fall, then wrap inside the box. Wrapping rather than respawning is
          // what makes the field allocation-free.
          vec3 p = aOffset;
          p.y = mod(aOffset.y - uTime * aParam.x, span);
          p += wind * (uTime * 0.35);
          p.x = mod(p.x + half, span) - half;
          p.z = mod(p.z + half, span) - half;
          /**
           * THE BOX FOLLOWS THE EYE, and it is biased UPWARD.
           *
           * Version one quantised the box to whole spans (floor(eye/span + 0.5))
           * to stop the field sliding with the player. That was solving a problem
           * rain does not have — the field is statistically homogeneous, so moving
           * it smoothly is invisible — while creating two real ones: the box could
           * sit up to half a span (12 m) off the eye, and it was CENTRED on the
           * eye, which buried half of every drop below the pavement. Measured live:
           * a full storm produced no visible rain at all.
           *
           * Biased so the field runs from 4 m below the eye to 20 m above it: rain
           * you can see is rain overhead and just in front, not rain in the ground.
           */
          vec3 world = uEye + vec3(p.x, p.y - 4.0, p.z);

          // Billboard, but only about Y: a streak has to stay vertical-ish.
          vec3 toEye = normalize(vec3(uEye.x - world.x, 0.0, uEye.z - world.z) + vec3(1e-4));
          vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toEye));
          // Lean with the wind so a storm reads as driven rather than as still air.
          vec3 down = normalize(vec3(wind.x * 0.12, -1.0, wind.z * 0.12));
          float len = aParam.y * (0.35 + 0.65 * uState.x);
          /**
           * 20 mm wide, which is deliberately far wider than a raindrop.
           *
           * A 3 mm drop at 8 m subtends about a third of a pixel at 1080p, so a
           * physically-sized streak filters away to nothing — which is exactly what
           * the first live shot showed. Every shipped rain effect draws the streak
           * two to four pixels wide at low alpha instead, and that is not a cheat:
           * it is what the drop's motion blur plus the sensor's point spread
           * function actually produce.
           */
          vec3 v = world + right * (position.x * 0.020) - down * (position.y * len);

          // Fade the nearest drops out: a streak drawn 20 cm from the lens is a
          // grey smear across a third of the screen.
          float d = length(uEye - world);
          vFade = uState.x * smoothstep(0.5, 2.2, d) * (1.0 - smoothstep(half * 0.7, half * 1.05, d));
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * vec4(v, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vFade;
        varying vec2 vUv;
        void main() {
          // Soft across the width, tapered along the length: the head of a streak
          // is brighter than the tail because the drop was there most recently.
          float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
          float along = smoothstep(0.0, 0.35, vUv.y);
          /**
           * BRIGHT, and it has to be.
           *
           * This is additive light in a LINEAR HDR pipeline: the frame it is added
           * to is somewhere between 1 and 10 in daylight, so an amplitude of 0.55
           * is three orders of magnitude below the street and the rain was
           * measured as completely invisible in the first live shot. A raindrop is
           * a lens full of sky — it is genuinely one of the brighter things in an
           * overcast frame, which is exactly why rain photographs as white
           * streaks against a grey world.
           */
          float a = vFade * across * across * along * 2.6;
          if (a < 0.002) discard;
          gl_FragColor = vec4(uColor * a, a);
        }
      `,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    // Rain must not enter the depth/normal prepass or the shadow cascades: it is
    // a transparent additive overlay, and a velocity buffer full of falling
    // streaks would smear the whole frame under TAA.
    this.mesh.userData.owNoPrepass = true;
    this.mesh.userData.owNoShadow = true;
  }

  update(dt, eye, intensity, wind) {
    this.uniforms.uTime.value += dt;
    this.uniforms.uEye.value.copy(eye);
    const s = this.uniforms.uState.value;
    s.x = intensity;
    s.z = wind.x;
    s.w = wind.z;
    this.mesh.visible = intensity > 0.01;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

/* -------------------------------------------------------------------------- */

export class WeatherSystem {
  static id = 'weather';
  static deps = ['sky', 'materials'];

  constructor() {
    this.preset = 'clear';
    this.current = { ...PRESETS.clear, sky: { ...PRESETS.clear.sky } };
    this._from = this.current;
    this._to = PRESETS.clear;
    this._t = 1;
    this._fade = 1;
    this._eye = new THREE.Vector3();
    this._wind = new THREE.Vector3();
    this._off = [];
  }

  async init(ctx) {
    this.ctx = ctx;
    this.sky = ctx.get('sky');
    this.mats = ctx.get('materials');

    const q = ctx.config.q ?? 1;
    // Drop count by tier. Rain is one draw call whatever the count, so the only
    // cost that scales is fragment overdraw from overlapping streaks.
    const count = ctx.config.quality === 'low' ? 1400 : ctx.config.quality === 'medium' ? 3200 : 6000;
    this.rain = new RainField(count);
    ctx.scene.add(this.rain.mesh);
    /**
     * NOT patched into the world's lighting injection. `render.patcher` rewrites
     * MeshStandardMaterial shader chunks to add cascades, AO and SSR; a hand-written
     * ShaderMaterial has none of those chunks to rewrite, so the call is either a
     * no-op or a corruption. Rain is an additive overlay lit by nothing.
     */

    /**
     * Start from the query string so a screenshot or a bug report can pin the
     * weather, and so the pixel gate stays deterministic (it passes nothing, and
     * `clear` is the default).
     */
    if (typeof location !== 'undefined') {
      const want = new URLSearchParams(location.search).get('weather');
      if (want && PRESETS[want]) this.set(want, { fade: 0 });
    }
    // Idempotent: `set` above has already applied if a preset was requested, and
    // this covers the default path where it was not.
    this.#apply(this.current, true);

    console.info(
      `[weather] ${this.preset} · visibility ${this.current.visibility} m · ` +
        `sound mask ${(this.current.soundMask * 100) | 0}% · ${count} drops`,
    );
  }

  /* ------------------------------------------------------------------ public */

  /**
   * Change the weather.
   *
   * @param {keyof typeof PRESETS} name
   * @param {{fade?: number}} [o] seconds to blend over. 0 snaps.
   */
  set(name, o = {}) {
    const target = PRESETS[name];
    if (!target) return { ok: false, reason: `unknown weather "${name}"` };
    // Blend FROM the live resolved state, not from the previous preset: changing
    // weather twice inside one transition must not jump back to the start.
    this._from = { ...this.current, sky: { ...this.current.sky } };
    this._to = target;
    this._fade = Math.max(0, o.fade ?? 8);
    this._t = this._fade > 0 ? 0 : 1;
    this.preset = name;
    /**
     * A SNAP HAS TO APPLY HERE, not on the next frame.
     *
     * `#apply` is otherwise only reached from `update()` while a transition is
     * running — and a fade of 0 leaves `_t` already at 1, so that branch never
     * runs and the change is resolved into `current` and then never pushed
     * anywhere. Measured live: `set('fog', { fade: 0 })` moved `visibility` to
     * 55 m and left the AI's `viewRangeScale` at exactly 1.0, so the fog rolled
     * in as a pure filter with no effect on what the enemy could see.
     *
     * The gate could not see this: it checks that the wiring EXISTS, not that it
     * RUNS. That is what the live probe is for, and it is why the same gate now
     * boots the subsystem against a stub context and reads the scales back.
     */
    if (this._t === 1) {
      this.#resolve();
      if (this.ctx) this.#apply(this.current, true);
    }
    this.ctx?.events?.emit?.('weather:changed', { preset: name, fade: this._fade });
    return { ok: true };
  }

  get visibility() {
    return this.current.visibility;
  }

  get soundMask() {
    return this.current.soundMask;
  }

  /* ------------------------------------------------------------------- frame */

  update(dt, ctx) {
    if (this._t < 1) {
      this._t = Math.min(1, this._t + dt / Math.max(0.001, this._fade));
      this.#resolve();
      this.#apply(this.current, false);
    }

    // Wind, from the sky's own figure so the rain, the clouds and the god rays
    // all agree about which way the weather is going.
    const speed = this.current.sky.windSpeed ?? 0;
    const angle = this.sky?.weather?.windAngle ?? 0;
    this._wind.set(Math.sin(angle) * speed, 0, Math.cos(angle) * speed);

    this._eye.setFromMatrixPosition(ctx.camera.matrixWorld);
    this.rain.update(dt, this._eye, this.current.rain, this._wind);
  }

  #resolve() {
    this.current = blend(this._from, this._to, this._t);
  }

  /**
   * Push the resolved state out to everything that consumes it.
   *
   * Called every frame WHILE a transition is running and once when it ends —
   * not unconditionally, because `materials.tune` walks every material in the
   * bank and the sky rebakes its LUTs when the atmosphere moves.
   */
  #apply(state, force) {
    this.sky.setWeather({ ...state.sky });

    /**
     * Surfaces get TWO patches, and the split matters.
     *
     * `weather` is the level's permanent marks — dust, dried runoff stains, the
     * splash band, grime in the crevices. Rain washing dust off is a real change
     * to those, so it belongs there.
     *
     * `wet` is the transient film of water: albedo down, roughness down, pooling
     * on horizontal faces. It had to be its own uniform, because folding it into
     * the weathering vector would have meant a shower permanently repainting the
     * street.
     */
    const vec = surfaceWeather(state.wetness, this.preset === 'dust' ? 1 : 0);
    const wet = [state.wetness, 0.6, 0, 0];
    for (const m of this.mats.materials()) this.mats.tune(m, { weather: vec, wet });

    /**
     * THE PART THAT MAKES IT A MECHANIC.
     *
     * `ai` reads these two scalars where it already computes an agent's view
     * range and how far a shot is heard. Fog therefore shortens the enemy's sight
     * line and rain deafens them, and the player can feel both without being
     * told. Injected rather than imported: weather must not become a dependency
     * of the AI, and the AI degrades to 1.0 if this subsystem is absent.
     */
    const ai = this.ctx.peek('ai');
    if (ai) {
      ai.viewRangeScale = viewScaleFor(state.visibility);
      ai.hearingScale = hearingScaleFor(state.soundMask);
    }

    if (force) this.ctx.events?.emit?.('weather:applied', { preset: this.preset, state });
  }

  dispose() {
    for (const off of this._off) off?.();
    this._off.length = 0;
    this.rain?.dispose();
    const ai = this.ctx?.peek?.('ai');
    if (ai) {
      ai.viewRangeScale = 1;
      ai.hearingScale = 1;
    }
  }
}
