/**
 * HEARTBEAT — layer 3 of the anti-sleep design.
 *
 * The other two layers live outside the browser (see server/keepalive.py for the
 * whole picture). This one is the cheapest of the three and covers the case that
 * matters most: while anybody is actually playing, the service must not be
 * allowed to drift towards its idle timer.
 *
 * It is not a duplicate of layer 1. Layer 1 pings only when the server has been
 * quiet, and a player sitting in the menu reading mode descriptions for twenty
 * minutes produces *no* HTTP traffic at all — the page was downloaded once and
 * the engine then talks WebSocket or nothing. Render's spin-down watches HTTP, so
 * a lobby full of idle players still looks idle. Four minutes of heartbeat fixes
 * that for free.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *   * It does not run when the page is served from a different origin than the
 *     relay: pinging the static host would keep the wrong machine awake.
 *   * It does not run on localhost. There is nothing to keep alive, and a dev
 *     server does not need the noise in its log.
 *   * It does not retry forever. Six consecutive failures means the service is
 *     down or the tab is offline, and hammering it helps nobody.
 *
 * PUBLIC API
 *   const hb = new Heartbeat({ url })   // url optional, defaults to same origin
 *   await hb.probe()                    // one-shot: is the server warm?
 *   hb.start() / hb.stop() / hb.dispose()
 *   hb.state                            // 'idle'|'warm'|'waking'|'unreachable'
 */

/** Four minutes. Comfortably inside Render's 15, and cheap: one small GET. */
const PERIOD_MS = 4 * 60 * 1000;
/** A wake-up from cold genuinely takes this long on a free instance. */
const PROBE_TIMEOUT_MS = 45_000;
const BEAT_TIMEOUT_MS = 10_000;
const MAX_FAILURES = 6;

function sameOriginBase() {
  const loc = globalThis.location;
  if (!loc || !loc.origin || loc.origin === 'null') return null;
  return loc.origin;
}

/**
 * A dev host has nothing to keep awake. Checked by name rather than by asking
 * the server, because the point is to send no request at all.
 */
export function isLocalHost(host) {
  if (!host) return true;
  const h = String(host).split(':')[0].toLowerCase();
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '0.0.0.0' ||
    h.endsWith('.local')
  );
}

export class Heartbeat {
  /**
   * @param {object} [o]
   *   url      relay origin; defaults to the page's own origin
   *   period   ms between beats
   *   fetch    injectable, so the gate can exercise this without a network
   *   now      injectable clock
   */
  constructor(o = {}) {
    this.base = (o.url ?? sameOriginBase() ?? '').replace(/\/+$/, '');
    this.period = o.period ?? PERIOD_MS;
    this._fetch = o.fetch ?? globalThis.fetch?.bind(globalThis) ?? null;
    this._now = o.now ?? (() => Date.now());

    this.state = 'idle';
    /** Set by `probe()`: true when this visitor paid for a cold start. */
    this.wokeTheServer = false;
    /** Server uptime in seconds as of the last probe, or null. */
    this.serverUptime = null;
    this.beats = 0;
    this.failures = 0;
    this.lastBeatAt = null;

    this._timer = null;
    this._inflight = null;
    this._onVisibility = () => {
      // Returning to a tab that has been hidden for a long time is exactly when
      // the server is most likely to have gone to sleep, so beat at once rather
      // than waiting out the remainder of the interval.
      if (!globalThis.document?.hidden && this._timer) void this._beat();
    };
  }

  /** Whether this environment is one where a heartbeat means anything. */
  get applicable() {
    if (!this._fetch || !this.base) return false;
    try {
      return !isLocalHost(new URL(this.base).host);
    } catch {
      return false;
    }
  }

  /**
   * One request, before the heavy chunks are fetched, so the shell can tell the
   * player "the server is waking up" instead of showing a dead screen.
   *
   * Never throws: a failed probe is information, not an error, and the offline
   * bot mode does not need a relay at all.
   */
  async probe() {
    if (!this.applicable) {
      this.state = 'idle';
      return { ok: false, applicable: false };
    }
    this.state = 'waking';
    const res = await this._get('/api/wake', PROBE_TIMEOUT_MS);
    if (!res.ok) {
      this.state = 'unreachable';
      return { ok: false, applicable: true, error: res.error };
    }
    const body = res.body ?? {};
    this.serverUptime = typeof body.uptime_s === 'number' ? body.uptime_s : null;
    this.wokeTheServer = body.cold_start === true;
    this.state = 'warm';
    return { ok: true, applicable: true, coldStart: this.wokeTheServer, body };
  }

  start() {
    if (!this.applicable || this._timer) return false;
    this._timer = setInterval(() => void this._beat(), this.period);
    globalThis.document?.addEventListener?.('visibilitychange', this._onVisibility);
    return true;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    globalThis.document?.removeEventListener?.('visibilitychange', this._onVisibility);
    this._inflight = null;
  }

  dispose() {
    this.stop();
  }

  async _beat() {
    // Never stack requests: a slow network would otherwise turn a 4-minute
    // interval into a growing queue of pending GETs.
    if (this._inflight) return;
    if (this.failures >= MAX_FAILURES) {
      this.stop();
      this.state = 'unreachable';
      return;
    }
    this._inflight = this._get('/healthz', BEAT_TIMEOUT_MS);
    const res = await this._inflight;
    this._inflight = null;
    if (res.ok) {
      this.beats++;
      this.failures = 0;
      this.lastBeatAt = this._now();
      this.state = 'warm';
    } else {
      this.failures++;
    }
  }

  async _get(path, timeoutMs) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const r = await this._fetch(`${this.base}${path}`, {
        method: 'GET',
        cache: 'no-store',
        // `keepalive` lets the beat survive a navigation away from the page,
        // which is the one moment a tab is most likely to be closed mid-request.
        keepalive: true,
        signal: controller?.signal,
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      let body = null;
      try {
        body = await r.json();
      } catch {
        body = null;
      }
      return { ok: true, body };
    } catch (err) {
      return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : String(err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  report() {
    return {
      applicable: this.applicable,
      base: this.base,
      state: this.state,
      beats: this.beats,
      failures: this.failures,
      serverUptime: this.serverUptime,
      wokeTheServer: this.wokeTheServer,
      running: !!this._timer,
    };
  }
}
