"""Round 48: the two things the terminal gained that can be wrong on their own.

  1. the timeframe ladder - every rung has to be buildable from the same tick archive, and a
     coarser candle has to contain exactly the ticks of the finer ones it covers;
  2. the quote book - bid, ask and spread come from the wire or not at all, and a wire that
     only sends a mid never yields a spread.

No broker, no network: the ticks are built here so the answers are known by hand.
"""

import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import tape as T      # noqa: E402
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


LADDER = [15, 30, 60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 86400]

print("the timeframe ladder")
check("every rung the archive can build is offered", all(t in T.TIMEFRAMES for t in LADDER),
      T.TIMEFRAMES)
check("nothing is offered that the four-day archive cannot build",
      all(t <= 86400 for t in T.TIMEFRAMES) and 604800 not in T.TIMEFRAMES, T.TIMEFRAMES)
check("the ladder is ascending and unique",
      list(T.TIMEFRAMES) == sorted(set(T.TIMEFRAMES)), T.TIMEFRAMES)

# six hours of quotes, 30 s apart, walking up and down by a tenth
base = 1_700_000_000.0
path = [(base + i * 30.0, 3570.0 + (i % 11) * 0.1, 0, None) for i in range(720)]
by_tf = {}
for tf in T.TIMEFRAMES:
    by_tf[tf] = T.footprint(path, tf=tf, step=0.05, limit=10_000)

check("every candle is exactly one timeframe long",
      all(b["t1"] - b["t0"] == tf for tf in T.TIMEFRAMES for b in by_tf[tf]))
check("every candle starts on its own grid line",
      all(b["t0"] % tf == 0 for tf in T.TIMEFRAMES for b in by_tf[tf]))
check("no candle overlaps the next",
      all(all(a["t1"] <= b["t0"] for a, b in zip(bs, bs[1:])) for bs in by_tf.values()))
check("the six hours produce fewer candles as the candle grows",
      len(by_tf[15]) > len(by_tf[900]) > len(by_tf[3600]) > len(by_tf[14400]),
      (len(by_tf[15]), len(by_tf[900]), len(by_tf[3600]), len(by_tf[14400])))

counts = {tf: sum(b["volume"] for b in bs) for tf, bs in by_tf.items()}
check("no quote is lost or counted twice at any candle size",
      len(set(counts.values())) == 1 and counts[15] == len(path), counts)
check("the tick counts add up the same way",
      len({sum(b["ticks"] for b in bs) for bs in by_tf.values()}) == 1)
check("buy plus sell plus flat is the candle volume",
      all(abs(b["buy"] + b["sell"] + b["flat"] - b["volume"]) < 1e-6
          for bs in by_tf.values() for b in bs))
check("delta is ask minus bid on every candle",
      all(abs(b["delta"] - (b["buy"] - b["sell"])) < 1e-6
          for bs in by_tf.values() for b in bs))
# an hour contains exactly the four quarter hours it covers
q = {b["t0"]: b for b in by_tf[900]}
h = {b["t0"]: b for b in by_tf[3600]}
ok = True
for t0, hour in h.items():
    parts = [q.get(t0 + k * 900) for k in range(4)]
    if all(parts):
        ok = ok and abs(sum(p["volume"] for p in parts) - hour["volume"]) < 1e-6 \
            and abs(sum(p["ticks"] for p in parts) - hour["ticks"]) < 1e-6
check("an hourly candle is exactly its four quarter-hour candles", ok)
check("a candle keeps open, high, low and close that really happened",
      all(b["low"] <= min(b["open"], b["close"]) <= max(b["open"], b["close"]) <= b["high"]
          for bs in by_tf.values() for b in bs))

print("the archive under a long timeframe")
tmpd = tempfile.mkdtemp()
st = T.Store(os.path.join(tmpd, "cap.db"))
st.add([(1000.0 + i, 100.0 + i, 1, None) for i in range(10)])
check("a plain window comes back oldest first",
      [r[1] for r in st.range(0, 2000)] == [100.0 + i for i in range(10)])
check("a capped window keeps the newest quotes, not the oldest",
      [r[1] for r in st.range(0, 2000, limit=3)] == [107.0, 108.0, 109.0],
      [r[1] for r in st.range(0, 2000, limit=3)])

print("the quote book")
OF._LAST_BOOK.clear()
OF._LAST_PX.clear()
now = time.time()
OF.ingest([{"sym": "XAUUSD", "price": 3571.20, "bid": 3571.10, "ask": 3571.30,
            "volume": None, "ts": now}])
q1 = OF.quote("XAUUSD")
check("the wire's bid is kept as sent", q1.get("bid") == 3571.10, q1)
check("the wire's ask is kept as sent", q1.get("ask") == 3571.30, q1)
check("the spread is ask minus bid", abs(q1.get("spread", 0) - 0.20) < 1e-9, q1)
check("a quote that is a fraction of a tick old is not called stale",
      q1.get("age") is not None and q1["age"] < 5, q1)
check("another instrument has no quote of its own", OF.quote("EURUSD") == {}, OF.quote("EURUSD"))

OF._LAST_BOOK.clear()
OF.ingest([{"sym": "XAUUSD", "price": 3571.25, "bid": None, "ask": None, "volume": None,
            "ts": time.time()}])
check("a mid-only wire leaves no bid, ask or spread behind", OF.quote("XAUUSD") == {},
      OF.quote("XAUUSD"))

OF._LAST_BOOK.clear()
OF.ingest([{"sym": "XAUUSD", "price": 3571.30, "bid": 3571.40, "ask": 3571.20,
            "volume": None, "ts": time.time()}])
check("a crossed book is refused rather than printed upside down", OF.quote("XAUUSD") == {},
      OF.quote("XAUUSD"))

print("what the wire parser keeps")
frame = {"type": "tick", "symbol": "XAUUSD", "bid": 3571.10, "ask": 3571.30,
         "ts": now, "data": [{"symbol": "XAUUSD", "bid": 3571.15, "ask": 3571.35, "ts": now + 1}]}
ticks = OF.parse_ticks(frame)
check("the parser keeps both sides of every quote",
      [t.get("bid") for t in ticks] == [3571.10, 3571.15]
      and [t.get("ask") for t in ticks] == [3571.30, 3571.35], ticks)
check("a quote with no last price is valued at the mid, not invented",
      all(t["price"] == (t["bid"] + t["ask"]) / 2 for t in ticks), ticks)

print()
print("%d passed, %d failed" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
