"""
KEEP-ALIVE — three layers of defence against Render's free-tier spin-down.

THE PROBLEM
-----------
A free Render web service is stopped after 15 minutes without inbound HTTP
traffic. The next visitor pays a cold start: container pull, Python import,
first paint. For a game whose whole pitch is "click and you are in a firefight",
a 30-second white page is the difference between a player and a bounce.

WHY ONE LAYER IS NOT ENOUGH
---------------------------
The obvious fix — have the service ping itself — has a fatal hole: a stopped
process cannot ping anything. Self-pinging keeps a *running* service running; it
can never wake a *stopped* one. So it must be paired with a pinger that lives
somewhere else. And an external pinger alone is not enough either: free cron
services and GitHub's scheduled workflows are best-effort, routinely late by
several minutes, and GitHub disables schedules on repositories that see no
commits for 60 days. Either layer alone fails; together they cover each other.

  Layer 1  in-process self-ping        (this file)   holds a live service awake
  Layer 2  GitHub Actions cron         (.github/workflows/keepalive.yml)
                                                      wakes a stopped service
  Layer 3  browser heartbeat           (game/net/heartbeat.js)
                                                      free coverage while anyone
                                                      is actually playing

THE INSTANCE-HOUR BUDGET
------------------------
Render's free tier grants 750 instance-hours per month. A service kept awake
every hour of a 31-day month needs 744, which fits — but only just, and only for
one service. That is why the pinger is *idle-driven* rather than unconditional:
it fires only when no real traffic has arrived for `idle_threshold` seconds, so a
busy service spends nothing on keep-alive. `KEEPALIVE_WINDOW` narrows it further
to a range of UTC hours for anyone who would rather sleep at 04:00 than risk
running out of hours on the 28th.

WHY urllib AND NOT httpx
------------------------
The ping has to leave the container and come back through Render's edge, because
only traffic arriving at the edge counts as activity — a request to 127.0.0.1
does not. That needs an ordinary outbound GET, which the standard library does
perfectly well. Adding an async HTTP client to `requirements.txt` for one GET
every ten minutes would be a dependency, a wheel, and a supply-chain surface
bought for nothing. The blocking call runs in a worker thread so the event loop
never stalls.
"""

from __future__ import annotations

import asyncio
import os
import random
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

# A request carrying this header is our own ping and must not count as activity,
# or the pinger would keep itself alive forever and never notice a quiet service.
PING_HEADER = "x-fps-keepalive"
PING_TOKEN = "1"


def _env_int(name: str, default: int) -> int:
    """Environment integers, tolerant of the blanks a dashboard produces."""
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _parse_window(raw: str | None) -> tuple[int, int] | None:
    """
    `"6-23"` -> (6, 23): only self-ping between 06:00 and 23:00 UTC.

    A window that wraps midnight (`"22-4"`) is honoured as 22:00->04:00. Garbage
    returns None, which means "always on" — a malformed variable must never be
    the reason the service quietly stopped staying awake.
    """
    if not raw or "-" not in raw:
        return None
    a, _, b = raw.partition("-")
    try:
        start, end = int(a), int(b)
    except ValueError:
        return None
    if not (0 <= start <= 23 and 0 <= end <= 23) or start == end:
        return None
    return start, end


def in_window(window: tuple[int, int] | None, hour_utc: int) -> bool:
    """Pure, so the gate can check the wrap-around case without a clock."""
    if window is None:
        return True
    start, end = window
    if start < end:
        return start <= hour_utc < end
    return hour_utc >= start or hour_utc < end


@dataclass
class KeepAliveConfig:
    """
    `period` is the sleep between checks; `idle_threshold` is how quiet things
    have to have been before a ping is worth sending.

    Both default well inside Render's 15-minute window. 600 s leaves a five
    minute margin for a late tick, a slow DNS answer and one retry — a 14-minute
    period would be arithmetically valid and operationally reckless.
    """

    external_url: str | None = None
    period: int = 60
    idle_threshold: int = 600
    timeout: int = 20
    window: tuple[int, int] | None = None
    enabled: bool = True
    max_backoff: int = 900

    @classmethod
    def from_env(cls) -> "KeepAliveConfig":
        url = (
            os.environ.get("KEEPALIVE_URL")
            or os.environ.get("RENDER_EXTERNAL_URL")
            or ""
        ).strip().rstrip("/")
        return cls(
            external_url=url or None,
            period=_env_int("KEEPALIVE_PERIOD", 60),
            idle_threshold=_env_int("KEEPALIVE_IDLE", 600),
            timeout=_env_int("KEEPALIVE_TIMEOUT", 20),
            window=_parse_window(os.environ.get("KEEPALIVE_WINDOW")),
            enabled=(os.environ.get("KEEPALIVE", "1").strip().lower()
                     not in {"0", "false", "no", "off"}),
        )


@dataclass
class KeepAliveStats:
    started_at: float = field(default_factory=time.time)
    last_inbound: float = field(default_factory=time.time)
    pings: int = 0
    failures: int = 0
    skipped_busy: int = 0
    skipped_window: int = 0
    last_ping_at: float | None = None
    last_error: str | None = None

    def snapshot(self, now: float | None = None) -> dict:
        now = now or time.time()
        return {
            "uptime_s": round(now - self.started_at, 1),
            "idle_s": round(now - self.last_inbound, 1),
            "pings": self.pings,
            "failures": self.failures,
            "skipped_busy": self.skipped_busy,
            "skipped_window": self.skipped_window,
            "last_ping_age_s": (
                None if self.last_ping_at is None else round(now - self.last_ping_at, 1)
            ),
            "last_error": self.last_error,
        }


class KeepAlive:
    """
    Layer 1. Own the loop, not the app: `main.py` calls `note_inbound()` from a
    middleware and `start()/stop()` from lifespan events, and nothing else in the
    server knows this exists.
    """

    def __init__(self, config: KeepAliveConfig | None = None) -> None:
        self.config = config or KeepAliveConfig.from_env()
        self.stats = KeepAliveStats()
        self._task: asyncio.Task | None = None
        self._backoff = 0

    # ------------------------------------------------------------- accounting

    def note_inbound(self) -> None:
        """Any request that is not our own ping proves the service is wanted."""
        self.stats.last_inbound = time.time()

    @property
    def active(self) -> bool:
        return self._task is not None and not self._task.done()

    def should_ping(self, now: float | None = None) -> bool:
        """
        Pure decision function — the reason this class is testable without a
        network, a clock or an event loop.
        """
        cfg = self.config
        if not cfg.enabled or not cfg.external_url:
            return False
        now = now or time.time()
        if not in_window(cfg.window, time.gmtime(now).tm_hour):
            return False
        return (now - self.stats.last_inbound) >= cfg.idle_threshold

    # ------------------------------------------------------------------- loop

    async def start(self) -> bool:
        cfg = self.config
        if not cfg.enabled:
            print("[keepalive] disabled by KEEPALIVE=0")
            return False
        if not cfg.external_url:
            # Local development and CI have no external URL, and that is correct:
            # there is nothing to keep awake. Say so once instead of warning on a
            # timer.
            print("[keepalive] no RENDER_EXTERNAL_URL / KEEPALIVE_URL — layer 1 off")
            return False
        if self.active:
            return True
        self._task = asyncio.create_task(self._run(), name="keepalive")
        print(
            f"[keepalive] on · target={cfg.external_url}/healthz · "
            f"every {cfg.period}s when idle > {cfg.idle_threshold}s"
            + (f" · window {cfg.window[0]}-{cfg.window[1]} UTC" if cfg.window else "")
        )
        return True

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

    async def _run(self) -> None:
        cfg = self.config
        # Stagger the very first tick. Without it every redeploy fires a ping at
        # the same instant the platform is still wiring up routing, which shows
        # as a spurious failure in the stats and teaches you to distrust them.
        await asyncio.sleep(min(cfg.period, 15) + random.uniform(0, 5))
        while True:
            try:
                now = time.time()
                if not self.should_ping(now):
                    if not in_window(cfg.window, time.gmtime(now).tm_hour):
                        self.stats.skipped_window += 1
                    else:
                        self.stats.skipped_busy += 1
                else:
                    await self._ping()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # a keep-alive must never kill the server
                self.stats.last_error = f"{type(exc).__name__}: {exc}"
            # Jitter keeps a fleet of restarts from synchronising into a spike.
            delay = cfg.period + self._backoff + random.uniform(0, cfg.period * 0.1)
            await asyncio.sleep(delay)

    async def _ping(self) -> None:
        url = f"{self.config.external_url}/healthz"
        try:
            status = await asyncio.to_thread(self._get, url, self.config.timeout)
            if 200 <= status < 400:
                self.stats.pings += 1
                self.stats.last_ping_at = time.time()
                self.stats.last_error = None
                self._backoff = 0
                # A successful ping IS inbound traffic as far as Render is
                # concerned, so the idle clock has to move — otherwise every
                # tick would fire and we would burn the ping budget.
                self.stats.last_inbound = time.time()
            else:
                raise urllib.error.HTTPError(url, status, "unexpected status", {}, None)
        except Exception as exc:
            self.stats.failures += 1
            self.stats.last_error = f"{type(exc).__name__}: {exc}"
            # Back off, but never past max_backoff: a service that has been
            # unreachable for an hour still has to try again inside the window.
            self._backoff = min(
                self.config.max_backoff, (self._backoff or self.config.period) * 2
            )

    @staticmethod
    def _get(url: str, timeout: int) -> int:
        req = urllib.request.Request(
            url,
            method="GET",
            headers={
                PING_HEADER: PING_TOKEN,
                "User-Agent": "fps-arena-x-keepalive/1",
                # Never let a proxy answer on the origin's behalf: a cached 200
                # would keep the stats green while the service slept.
                "Cache-Control": "no-cache",
            },
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read(64)
            return resp.status
