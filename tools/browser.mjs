/**
 * Resolving a Chromium that can actually run WebGL2, wherever we are.
 *
 * The visual gates need a real GPU-ish browser, and three environments have to
 * be satisfied with one code path:
 *
 *   CI            playwright's own download works; nothing to do.
 *   a workstation  same.
 *   a locked-down sandbox
 *                 playwright's CDN is unreachable, but npm is not. The
 *                 @sparticuz/chromium package ships a brotli-compressed Chromium
 *                 build plus a SwiftShader ANGLE backend, so the binary can be
 *                 unpacked from node_modules and driven by playwright through
 *                 `executablePath`.
 *
 * The SwiftShader part is the bit that is easy to get wrong. Unpacking the
 * browser is not enough: libEGL.so, libGLESv2.so and libvk_swiftshader.so have to
 * be discoverable, and Chromium looks for them next to the binary and on
 * LD_LIBRARY_PATH. Without that, `getContext('webgl2')` returns null and the
 * whole render gate reports a black frame with no explanation.
 *
 * API
 *   const { launch, describe } = await resolveBrowser()
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { brotliDecompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Software-rendered WebGL2 with ANGLE over SwiftShader's Vulkan device.
 *
 * `--enable-unsafe-swiftshader` is required from Chromium 120 or so: without it
 * a headless build refuses to fall back to software GL and silently hands back a
 * null context. The rest keeps the sandbox and shared-memory assumptions of a
 * container from killing the process on start.
 */
export const GL_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu-sandbox',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-webgl',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  // Deterministic text: hinting differences between hosts otherwise show up as
  // diffs in every screenshot comparison.
  '--font-render-hinting=none',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
];

const UNPACK_DIR = join(tmpdir(), 'fps-arena-chromium');

/** Unpack the npm-shipped Chromium once; reuse it on later runs. */
function unpackBundled() {
  const pkg = join(ROOT, 'node_modules', '@sparticuz', 'chromium', 'bin');
  if (!existsSync(join(pkg, 'chromium.br'))) return null;

  const bin = join(UNPACK_DIR, 'chromium');
  if (existsSync(bin)) return bin;

  mkdirSync(UNPACK_DIR, { recursive: true });
  writeFileSync(bin, brotliDecompressSync(readFileSync(join(pkg, 'chromium.br'))));
  chmodSync(bin, 0o755);

  // The GL stack and the Amazon-Linux compatibility libs. Both land NEXT TO the
  // binary, which is the first place Chromium looks for libEGL/libGLESv2.
  for (const pack of ['swiftshader.tar.br', 'al2023.tar.br']) {
    const src = join(pkg, pack);
    if (!existsSync(src)) continue;
    const tar = join(UNPACK_DIR, pack.replace('.br', ''));
    writeFileSync(tar, brotliDecompressSync(readFileSync(src)));
    execFileSync('tar', ['-xf', tar, '-C', UNPACK_DIR]);
  }
  // Some builds nest the libs one level down; flatten so one LD_LIBRARY_PATH
  // entry covers both layouts.
  const nested = join(UNPACK_DIR, 'lib');
  if (existsSync(nested)) {
    execFileSync('sh', ['-c', `cp -n ${nested}/* ${UNPACK_DIR}/ 2>/dev/null || true`]);
  }
  return bin;
}

/**
 * @returns {Promise<{launch: (opts?: object) => Promise<import('playwright').Browser>,
 *                    describe: () => string}>}
 */
export async function resolveBrowser() {
  const { chromium } = await import('playwright');

  // An explicit path always wins: it is how CI pins a specific build and how a
  // developer points the gate at a browser they already have.
  let executablePath = process.env.PW_CHROMIUM_PATH || null;
  let source = executablePath ? 'PW_CHROMIUM_PATH' : null;

  if (!executablePath) {
    // Does playwright's own download exist? `executablePath()` throws when the
    // browser was never installed, which is exactly the sandbox case.
    try {
      const p = chromium.executablePath();
      if (p && existsSync(p)) {
        executablePath = p;
        source = 'playwright';
      }
    } catch {
      /* fall through to the bundled build */
    }
  }

  if (!executablePath) {
    const bundled = unpackBundled();
    if (bundled) {
      executablePath = bundled;
      source = '@sparticuz/chromium';
    }
  }

  if (!executablePath) {
    throw new Error(
      'no chromium available: run `npx playwright install chromium`, ' +
        'or set PW_CHROMIUM_PATH, or install @sparticuz/chromium',
    );
  }

  const needsLibPath = source === '@sparticuz/chromium';

  const env = needsLibPath
    ? {
        ...process.env,
        LD_LIBRARY_PATH: [UNPACK_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
      }
    : process.env;

  return {
    describe: () => `${source} · ${executablePath}`,
    /** Caller args are appended to GL_ARGS, never allowed to replace them. */
    launch: ({ args = [], ...rest } = {}) =>
      chromium.launch({ executablePath, env, ...rest, args: [...GL_ARGS, ...args] }),
  };
}
