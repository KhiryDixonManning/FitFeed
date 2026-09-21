# rate_limit.py
"""Per-user rate limiting for costly endpoints.

Identity comes from the verified Firebase uid (g.uid, populated by
require_auth) rather than the client IP: users behind one campus or mobile
NAT would otherwise share a quota. A uid supplied in a request body is never
used. Endpoints with no authenticated caller (the admin route) fall back to
the peer address purely as a brute-force damper.

Each limiter enforces a burst window and a sustained window at once, so a
short flurry is allowed while long-running abuse is not.

DEPLOYMENT LIMITATION (documented deliberately)
-----------------------------------------------
Counters live in process memory. The Procfile runs Gunicorn with 2 workers,
so the effective ceiling is up to 2x the configured limit, and limits reset
on deploy or restart. That is an accepted trade for this project: the goal is
to bound runaway cost and accidental loops, not to defeat a determined
distributed attacker. Redis (a paid add-on on Railway) would be required for
exact cross-worker accounting; the numbers below are chosen so that even 2x
is an acceptable spend. If the service is ever scaled past a couple of
workers, revisit this.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import defaultdict, deque
from functools import wraps
from typing import Callable, Deque, Optional

from flask import g, jsonify, request

log = logging.getLogger(__name__)

# Stop the bookkeeping dict from growing without bound on a long-lived worker.
_MAX_TRACKED_KEYS = 10_000


class SlidingWindowLimiter:
    """Fixed-capacity sliding window over request timestamps."""

    def __init__(self, limit: int, window_seconds: int, name: str):
        self.limit = limit
        self.window = window_seconds
        self.name = name
        self._hits: dict[str, Deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float) -> Deque[float]:
        hits = self._hits[key]
        cutoff = now - self.window
        while hits and hits[0] <= cutoff:
            hits.popleft()
        return hits

    def check(self, key: str, now: Optional[float] = None) -> tuple[bool, int]:
        """Record a hit. Returns (allowed, retry_after_seconds)."""
        moment = now if now is not None else time.monotonic()
        with self._lock:
            if len(self._hits) > _MAX_TRACKED_KEYS:
                self._evict_idle(moment)

            hits = self._prune(key, moment)
            if len(hits) >= self.limit:
                retry_after = max(1, int(self.window - (moment - hits[0])) + 1)
                return False, retry_after

            hits.append(moment)
            return True, 0

    def _evict_idle(self, now: float) -> None:
        """Drop keys with no live hits (caller holds the lock)."""
        cutoff = now - self.window
        for key in [k for k, v in self._hits.items() if not v or v[-1] <= cutoff]:
            del self._hits[key]

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


# --------------------------------------------------------------- policies
#
# /analyze invokes Claude, so it gets the strict limit. One analysis per
# upload is the normal pattern; the burst allowance covers a user retrying a
# failed analysis, and the hourly cap bounds worst-case spend per account.
ANALYZE_BURST = SlidingWindowLimiter(limit=5, window_seconds=60, name="analyze_burst")
ANALYZE_SUSTAINED = SlidingWindowLimiter(limit=30, window_seconds=3600, name="analyze_sustained")

# /feed and /trending are CPU-only. The feed re-ranks on Firestore snapshot
# changes (debounced 300ms), so an active session legitimately makes several
# calls a minute.
RANK_BURST = SlidingWindowLimiter(limit=60, window_seconds=60, name="rank_burst")
RANK_SUSTAINED = SlidingWindowLimiter(limit=600, window_seconds=3600, name="rank_sustained")

# The admin route is already behind a constant-time shared secret; this only
# slows key guessing. Keyed by peer address, which behind Railway's proxy is
# effectively global - acceptable for a route called by hand.
ADMIN_LIMITER = SlidingWindowLimiter(limit=10, window_seconds=60, name="admin")

ALL_LIMITERS = [
    ANALYZE_BURST, ANALYZE_SUSTAINED,
    RANK_BURST, RANK_SUSTAINED,
    ADMIN_LIMITER,
]


def reset_all_limiters() -> None:
    """Test helper: clear every window."""
    for limiter in ALL_LIMITERS:
        limiter.reset()


def _too_many(retry_after: int):
    response = jsonify({
        "error": "rate_limited",
        "message": "Too many requests. Please wait a moment and try again.",
    })
    response.status_code = 429
    response.headers["Retry-After"] = str(retry_after)
    return response


def rate_limit_by_uid(*limiters: SlidingWindowLimiter) -> Callable:
    """Limit by verified uid. Must be applied below require_auth."""

    def decorator(fn: Callable) -> Callable:
        @wraps(fn)
        def wrapper(*args, **kwargs):
            uid = getattr(g, "uid", None)
            if not uid:
                # require_auth should have run first; fail closed rather than
                # silently letting an unidentified caller through.
                log.error("rate_limit_by_uid used without an authenticated uid")
                return jsonify({"error": "unauthorized", "message": "Authentication required."}), 401

            for limiter in limiters:
                allowed, retry_after = limiter.check(uid)
                if not allowed:
                    log.warning("Rate limit %s hit for uid=%s", limiter.name, uid)
                    return _too_many(retry_after)

            return fn(*args, **kwargs)

        return wrapper

    return decorator


def rate_limit_by_peer(*limiters: SlidingWindowLimiter) -> Callable:
    """Limit by peer address, for routes with no authenticated identity."""

    def decorator(fn: Callable) -> Callable:
        @wraps(fn)
        def wrapper(*args, **kwargs):
            # remote_addr only; X-Forwarded-For is client-controlled.
            key = request.remote_addr or "unknown"
            for limiter in limiters:
                allowed, retry_after = limiter.check(key)
                if not allowed:
                    log.warning("Rate limit %s hit for peer", limiter.name)
                    return _too_many(retry_after)
            return fn(*args, **kwargs)

        return wrapper

    return decorator
