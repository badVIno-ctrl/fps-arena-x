"""
Tests for the keep-alive decision logic.

Everything worth testing here is a pure function of (config, clock, last inbound
request), which is why `KeepAlive.should_ping` exists as a separate method
instead of being inlined into the loop: the interesting behaviour can be checked
without a network, without an event loop and without waiting ten minutes.

Run: cd server && python -m unittest discover -p 'test_*.py'
"""

from __future__ import annotations

import calendar
import time
import unittest

from keepalive import KeepAlive, KeepAliveConfig, _parse_window, in_window


def at_utc_hour(hour: int) -> float:
    """A timestamp whose UTC hour is `hour`, independent of the host timezone."""
    return calendar.timegm((2026, 6, 15, hour, 30, 0, 0, 0, 0))


class WindowParsing(unittest.TestCase):
    def test_plain_range(self):
        self.assertEqual(_parse_window("6-23"), (6, 23))

    def test_wrapping_range_is_kept_as_written(self):
        # 22->4 crosses midnight and must survive parsing; normalising it to
        # (4, 22) would invert the meaning and silently sleep all day.
        self.assertEqual(_parse_window("22-4"), (22, 4))

    def test_garbage_means_always_on(self):
        # A malformed variable must never be the reason a service stopped staying
        # awake, so every unparseable value degrades to "no window".
        for bad in (None, "", "always", "6", "6-", "-6", "6-25", "-1-5", "7-7", "a-b"):
            self.assertIsNone(_parse_window(bad), bad)


class WindowMembership(unittest.TestCase):
    def test_no_window_is_always_inside(self):
        for h in range(24):
            self.assertTrue(in_window(None, h))

    def test_forward_window_is_half_open(self):
        self.assertFalse(in_window((6, 23), 5))
        self.assertTrue(in_window((6, 23), 6))
        self.assertTrue(in_window((6, 23), 22))
        self.assertFalse(in_window((6, 23), 23))

    def test_wrapping_window_covers_midnight(self):
        w = (22, 4)
        self.assertTrue(in_window(w, 22))
        self.assertTrue(in_window(w, 23))
        self.assertTrue(in_window(w, 0))
        self.assertTrue(in_window(w, 3))
        self.assertFalse(in_window(w, 4))
        self.assertFalse(in_window(w, 12))


class ShouldPing(unittest.TestCase):
    def make(self, **kw) -> KeepAlive:
        cfg = KeepAliveConfig(
            external_url=kw.pop("url", "https://example.onrender.com"),
            idle_threshold=kw.pop("idle_threshold", 600),
            window=kw.pop("window", None),
            enabled=kw.pop("enabled", True),
        )
        return KeepAlive(cfg)

    def test_quiet_service_is_pinged(self):
        ka = self.make()
        now = time.time()
        ka.stats.last_inbound = now - 601
        self.assertTrue(ka.should_ping(now))

    def test_busy_service_is_left_alone(self):
        # The instance-hour budget is the reason: a service with real traffic is
        # already awake, so a ping would be pure waste.
        ka = self.make()
        now = time.time()
        ka.stats.last_inbound = now - 599
        self.assertFalse(ka.should_ping(now))

    def test_threshold_is_inclusive(self):
        ka = self.make()
        now = time.time()
        ka.stats.last_inbound = now - 600
        self.assertTrue(ka.should_ping(now))

    def test_no_external_url_means_no_ping(self):
        # Local development and CI: there is nothing to keep awake, and pinging
        # localhost would not count as inbound traffic at the edge anyway.
        ka = self.make(url=None)
        ka.stats.last_inbound = time.time() - 10_000
        self.assertFalse(ka.should_ping())

    def test_disabled_means_no_ping(self):
        ka = self.make(enabled=False)
        ka.stats.last_inbound = time.time() - 10_000
        self.assertFalse(ka.should_ping())

    def test_outside_window_means_no_ping(self):
        ka = self.make(window=(6, 23))
        t = at_utc_hour(3)
        ka.stats.last_inbound = t - 10_000
        self.assertFalse(ka.should_ping(t))

    def test_inside_window_pings(self):
        ka = self.make(window=(6, 23))
        t = at_utc_hour(12)
        ka.stats.last_inbound = t - 10_000
        self.assertTrue(ka.should_ping(t))

    def test_inbound_traffic_resets_the_idle_clock(self):
        ka = self.make()
        now = time.time()
        ka.stats.last_inbound = now - 10_000
        self.assertTrue(ka.should_ping(now))
        ka.note_inbound()
        self.assertFalse(ka.should_ping())


class Margins(unittest.TestCase):
    """
    The numbers that protect against Render's 15-minute rule. These are asserted
    rather than commented because a well-meaning "let's ping less often" edit is
    exactly how this feature breaks silently in production.
    """

    SPIN_DOWN = 15 * 60

    def test_defaults_leave_a_real_margin(self):
        cfg = KeepAliveConfig()
        # Worst case for one cycle: nothing happens for idle_threshold, then the
        # loop waits up to one more period before it notices.
        worst_case = cfg.idle_threshold + cfg.period
        self.assertLess(worst_case, self.SPIN_DOWN)
        self.assertGreaterEqual(self.SPIN_DOWN - worst_case, 120,
                                "keep at least two minutes of slack for a late tick")

    def test_a_failed_ping_still_retries_inside_the_window(self):
        cfg = KeepAliveConfig()
        self.assertLessEqual(cfg.timeout, 30)
        # Backoff is capped so an outage cannot push the next attempt past the
        # point where waking up is still useful.
        self.assertLessEqual(cfg.max_backoff, 3600)


class StatsSnapshot(unittest.TestCase):
    def test_snapshot_shape_is_stable(self):
        # /api/wake and the CI workflow both read these keys; renaming one is a
        # breaking change to the dashboard the operator relies on.
        ka = KeepAlive(KeepAliveConfig())
        snap = ka.stats.snapshot()
        for key in ("uptime_s", "idle_s", "pings", "failures",
                    "skipped_busy", "skipped_window", "last_ping_age_s", "last_error"):
            self.assertIn(key, snap)

    def test_last_ping_age_is_none_before_the_first_ping(self):
        ka = KeepAlive(KeepAliveConfig())
        self.assertIsNone(ka.stats.snapshot()["last_ping_age_s"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
