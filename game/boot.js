/**
 * Boot.
 *
 * Adapted from the original Vite `main.js`, which ran as a top-level-await
 * module against a hand-written index.html. Under Next.js the entry has to be
 * callable and, crucially, *tearable*: React StrictMode mounts twice in dev and
 * Fast Refresh remounts on every edit, so a boot that only ever set up global
 * state would stack engines and leak WebGL contexts until the driver died.
 *
 * So the shape changed: `boot()` returns a handle with `dispose()`, and every
 * listener it attaches is tracked. The ORDER of work inside is unchanged from
 * the original, because that order is load-bearing:
 *
 *   menu first  -> the visitor sees the game's face, not a black canvas
 *   mode next   -> the mode decides quality, garrison size, whether a relay
 *                  connection is opened at all
 *   engine last -> systems are sized against the answers above
 *
 * Registration order of systems is irrelevant (Registry topologically sorts on
 * static deps) but is written in dependency order anyway, so a human reading it
 * does not have to run the sorter in their head.
 */

import { Engine } from './core/engine.js';
import { createConfig } from './core/config.js';

import { RenderSystem } from './render/index.js';
import { MaterialSystem } from './materials/index.js';
import { SkySystem } from './sky/index.js';
import { WorldSystem } from './world/index.js';
import { PhysicsSystem } from './physics/index.js';
import { PlayerSystem } from './player/index.js';
import { WeaponSystem } from './weapons/index.js';
import { FxSystem } from './fx/index.js';
import { AiSystem } from './ai/index.js';
import { UiSystem } from './ui/index.js';
import { AudioSystem } from './audio/index.js';

import { ModesSystem } from './modes/index.js';
import { NetSystem, defaultSocketUrl } from './net/index.js';
import { ArsenalSystem } from './arsenal/index.js';
import { ShellSystem } from './shell/index.js';
import { ModeMenu, MatchResults } from './shell/menu.js';

import { installShotApi } from './dev/shots.js';
import { prewarm } from './core/prewarm.js';

/**
 * What to call each system while it loads. Keyed by `static id`, so an id that
 * gains no entry here degrades to a generic caption rather than showing the
 * player an internal name.
 */
const STEP_LABELS = {
  render: 'ГРАФИКА',
  materials: 'МАТЕРИАЛЫ',
  sky: 'НЕБО',
  world: 'ГОРОД',
  physics: 'ФИЗИКА',
  player: 'ИГРОК',
  weapons: 'ОРУЖИЕ',
  fx: 'ЭФФЕКТЫ',
  ai: 'ПРОТИВНИКИ',
  ui: 'ИНТЕРФЕЙС',
  modes: 'РЕЖИМ БОЯ',
  net: 'СЕТЬ',
  arsenal: 'АРСЕНАЛ',
  shell: 'ВЕРСТАК',
  audio: 'ЗВУК',
};

/** 'auto' is a menu word, not an engine word: pick a tier from the hardware. */
function resolveQuality(name) {
  if (name !== 'auto') return name;
  const cores = navigator.hardwareConcurrency ?? 4;
  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  if (coarse || cores <= 4) return 'low';
  return cores >= 8 ? 'ultra' : 'medium';
}

function renderBootFailure(err) {
  console.error('[boot] init failed', err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre data-boot-failure style="position:fixed;inset:0;padding:2rem;color:#f66;background:#000;
       font:12px/1.5 ui-monospace,monospace;overflow:auto;z-index:9999;white-space:pre-wrap">
BOOT FAILURE\n\n${err?.stack ?? err?.message ?? String(err)}</pre>`
  );
}

/**
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas
 * @returns {Promise<{engine: import('./core/engine.js').Engine, dispose: () => void}>}
 */
export async function boot({ canvas } = {}) {
  if (!canvas) throw new Error('boot() requires a canvas');

  const params = new URLSearchParams(location.search);
  const capture = params.get('capture') === '1';
  // Deterministic shutter for the pixel gate: the engine does not schedule its
  // own frames, the driver advances exactly N of them through window.__PUMP__.
  const lockstep = capture && params.get('lockstep') === '1';

  // A capture run must never sit in front of a menu waiting for a click, so it
  // answers the menu itself from the query string.
  let choice;
  if (capture) {
    choice = {
      mode: params.get('mode') ?? 'bots',
      submode: params.get('submode') ?? 'ctf',
      difficulty: params.get('difficulty') ?? 'normal',
      quality: params.get('q') ?? 'ultra',
      nickname: '',
      menu: null,
    };
  } else {
    const menu = new ModeMenu({ quality: params.get('q') ?? 'auto' });
    choice = { ...(await menu.choose()), menu };
  }

  // The mount may have been torn down while the player sat in the menu.
  if (!canvas.isConnected) {
    choice.menu?.dismiss?.();
    throw new Error('boot aborted: canvas detached');
  }

  const config = createConfig({
    quality: resolveQuality(choice.quality),
    deterministic: capture,
  });

  const engine = new Engine({ canvas, config });

  engine
    .add(RenderSystem)
    .add(MaterialSystem)
    .add(SkySystem)
    .add(WorldSystem)
    .add(PhysicsSystem)
    .add(PlayerSystem)
    .add(WeaponSystem)
    .add(FxSystem)
    .add(AiSystem)
    .add(UiSystem)
    .add(ModesSystem)
    .add(NetSystem)
    .add(ArsenalSystem)
    .add(ShellSystem)
    .add(AudioSystem);

  // Both of these must be told what kind of match this is BEFORE init(): modes
  // sizes the garrison during init, and net decides there whether to open a
  // socket.
  engine.registry.get(ModesSystem.id).configure({
    mode: choice.mode,
    submode: choice.submode,
    difficulty: choice.difficulty,
  });
  engine.registry.get(NetSystem.id).configure({
    url: params.get('relay') ?? defaultSocketUrl(),
    nickname: choice.nickname,
    mode: choice.mode,
  });

  /**
   * Feed boot progress back to the menu the player is still looking at.
   *
   * Split of the bar: system init takes the first 60%, shader prewarm the rest.
   * That is roughly how the wall-clock time divides on a cold cache, so the bar
   * moves at a fairly even rate instead of racing then stalling.
   *
   * In capture mode there is no menu, so `report` is a no-op and engine.init()
   * gets no callback at all — which also means it skips the rAF yields and runs
   * as fast as the pixel gate needs.
   */
  const menu = choice.menu;
  const report = menu ? (frac, label) => menu.progress(frac, label) : null;

  try {
    await engine.init(report && ((f, id) => report(f * 0.6, STEP_LABELS[id] ?? 'ИНИЦИАЛИЗАЦИЯ')));
  } catch (err) {
    renderBootFailure(err);
    throw err;
  }

  const shotApi = installShotApi(engine, { capture, lockstep });

  // Compile every shader permutation before the frame loop starts. Without
  // this, 86 programs compile lazily during play, up to 30 on one frame,
  // producing 3.1-3.9 SECOND stalls. Opt out with `?prewarm=0`.
  report?.(0.6, 'КОМПИЛЯЦИЯ ШЕЙДЕРОВ');
  const warmup =
    params.get('prewarm') === '0'
      ? { ok: false, reason: 'disabled by ?prewarm=0' }
      : await prewarm(engine, {
          onProgress: report && ((f) => report(0.6 + f * 0.4, 'КОМПИЛЯЦИЯ ШЕЙДЕРОВ')),
        });
  report?.(1, 'ГОТОВО');
  console.info('[boot] prewarm', warmup);
  window.__PREWARM__ = warmup;

  engine.start();

  // The results card is driven by the match snapshot, so one handler covers all
  // three modes. Restarting means reloading with the same choice in the query
  // string: tearing a live match down in place leaves stale agents in the scene.
  const results = new MatchResults(() => {
    const q = new URLSearchParams({
      mode: choice.mode,
      submode: choice.submode,
      difficulty: choice.difficulty,
      q: choice.quality,
    });
    location.search = `?${q}`;
  });
  const onOver = (snapshot) => results.show(snapshot);
  engine.events.on('modes:over', onOver);

  // Capture harness handshake: only flag ready once a frame has actually landed.
  const BOOT_FRAMES = 3;
  if (lockstep) {
    await shotApi.pump(BOOT_FRAMES);
    window.__READY__ = true;
  } else {
    let warm = 0;
    const readyProbe = () => {
      if (++warm >= BOOT_FRAMES) {
        window.__READY__ = true;
        choice.menu?.dismiss();
        return;
      }
      requestAnimationFrame(readyProbe);
    };
    requestAnimationFrame(readyProbe);
  }

  window.__ENGINE__ = engine;

  let disposed = false;
  return {
    engine,
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        engine.events.off?.('modes:over', onOver);
        results.hide();
        choice.menu?.dismiss?.();
        engine.dispose();
      } catch (err) {
        console.warn('[boot] dispose failed', err);
      }
      if (window.__ENGINE__ === engine) delete window.__ENGINE__;
      delete window.__READY__;
    },
  };
}
