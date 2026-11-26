"""Round 49: the feed's own bookkeeping, and the candle engine under a disorderly wire.

A broker feed re-delivers frames, sends the odd unusable price and occasionally delivers a
quote behind a newer one. None of that may inflate volume, poison a candle or move a close.
These cases are built by hand so the expected answers are not in doubt.
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import tape as T        # noqa: E402
import orderflow as OF  # noqa: E402

PASS = FAIL = 0


def check(name, cond, extra=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  PASS  " + name)
    else:
        FAIL += 1
        print("  FAIL  " + name + ("" if extra is None else "  " + repr(extra)))


def counters():
    s = OF.state()
    return {k: s.get(k, 0) for k in ("parsed", "duplicates", "invalid", "late", "rejected")}


def tick(price, ts, **kw):
    t = {"sym": "XAUUSD", "price": price, "bid": None, "ask": None, "volume": None, "ts": ts}
    t.update(kw)
    return t


print("what the feed refuses to book")
base = counters()
now = time.time()
OF.ingest([tick(3570.10, now)])
check("a clean quote is booked", counters()["parsed"] == base["parsed"] + 1)
check("and it is not called a duplicate", counters()["duplicates"] == base["duplicates"])

OF.ingest([tick(3570.10, now)])
check("the same quote delivered twice is booked once",
      counters()["parsed"] == base["parsed"] + 1
      and counters()["duplicates"] == base["duplicates"] + 1, counters())

a = counters()["invalid"]
OF.ingest([tick(0, now + 1), tick(-5, now + 1), tick("nonsense", now + 1), tick(None, now + 1)])
check("prices that cannot be a trade are counted as invalid and dropped",
      counters()["invalid"] == a + 4 and counters()["parsed"] == base["parsed"] + 1, counters())

r = counters()["rejected"]
OF.ingest([tick(3570.20, now + 1, sym="EURUSD")])
check("a quote for an instrument this desk does not chart is counted, not charted",
      counters()["rejected"] == r + 1 and counters()["parsed"] == base["parsed"] + 1, counters())

lt = counters()["late"]
OF.ingest([tick(3570.30, now - 4.0)])
check("a quote that arrives behind a newer one is kept but counted as late",
      counters()["parsed"] == base["parsed"] + 2 and counters()["late"] == lt + 1, counters())

print("the candle under a disorderly wire")
# same minute, one quote delivered out of order: the close must be the latest by event time
pts = [(1000.0, 100.0, 0, None), (1015.0, 101.0, 0, None),
       (1005.0, 99.5, 0, None), (1018.0, 100.5, 0, None)]
bar = T.footprint(pts, tf=60, step=0.5, limit=10)[0]
check("a late quote still lands in its own candle", bar["open"] == 100.0, bar)
check("and the close is the newest quote by event time, not the last to arrive",
      bar["close"] == 100.5, bar["close"])
check("the high and low come from every quote in the interval",
      bar["high"] == 101.0 and bar["low"] == 99.5, (bar["high"], bar["low"]))
check("the interval boundaries are fixed by the clock, not by arrival",
      bar["t0"] == 960 and bar["t1"] == 1020, (bar["t0"], bar["t1"]))
two = T.footprint(pts, tf=10, step=0.5, limit=10)
check("a quote past the boundary starts the next candle",
      len(two) == 2 and two[1]["t0"] == 1010 and two[0]["close"] == 99.5, two)
check("every quote is still counted exactly once after the sort",
      sum(b["volume"] for b in T.footprint(pts, tf=15, step=0.5, limit=10)) == len(pts))

print("the diagnostics the page needs")
s = OF.state()
for k in ("parsed", "invalid", "duplicates", "late", "rejected", "messages"):
    check("the feed counts " + k, k in s and isinstance(s[k], int), s.get(k))

print()
print("%d passed, %d failed" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
