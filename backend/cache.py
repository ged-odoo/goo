"""In-memory caches for the services layer (see services.py).

A TTLCache memoizes a value per key for a fixed time-to-live, and "single-flights"
concurrent misses so the same expensive fetch (a runbot scrape, a `gh` call) runs
once even when several requests arrive at the same moment. It holds no global state,
so the services that use it stay easy to unit-test.
"""

import threading
import time as _time


class TTLCache:
    def __init__(self, ttl, *, clock=_time.time):
        self.ttl = ttl  # seconds a value stays fresh
        self._clock = clock  # injectable for tests
        self._lock = threading.Lock()
        self._entries = {}  # key -> (stored_at, value)
        self._key_locks = {}  # key -> Lock, for single-flight

    def _fresh(self, entry):
        return entry is not None and (self._clock() - entry[0]) < self.ttl

    def get(self, key, compute):
        """Return the fresh cached value for `key`, else call compute(), store and
        return it. Concurrent misses for the same key compute exactly once."""
        with self._lock:
            entry = self._entries.get(key)
            if self._fresh(entry):
                return entry[1]
            key_lock = self._key_locks.setdefault(key, threading.Lock())
        with key_lock:  # single-flight: one computation per key at a time
            with self._lock:
                entry = self._entries.get(key)
                if self._fresh(entry):
                    return entry[1]
            value = compute()  # outside the global lock so other keys aren't blocked
            with self._lock:
                self._entries[key] = (self._clock(), value)
            return value

    def invalidate(self, key=None):
        """Drop a single key, or the whole cache when key is None."""
        with self._lock:
            if key is None:
                self._entries.clear()
            else:
                self._entries.pop(key, None)
