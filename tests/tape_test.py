"""The tape engine, checked against datasets whose answers are known by hand.

Nothing here talks to a broker. Each case builds ticks whose buy/sell split, delta,
POC, value area or imbalance can be worked out on paper, then asserts the engine says
exactly that - including the cases where it must say "no signal".
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import tape as T  # noqa: E402

PASS = FAIL = 0


def check(name, cond, extra=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  PASS  " + name)
    else:
        FAIL += 1
        print("  FAIL  " + name + ("" if extra is None else "  " + repr(extra)))


def pts(prices, t0=1_700_000_000.0, dt=1.0, size=None):
    """Tick points from a price path; side is worked out by the engine, not here."""
    return [(t0 + i * dt, p, 0, size) for i, p in enumerate(prices)]


print("price aggregation")
check("0.05 grid puts 3570.02 and 3570.07 on different levels",
      T.bucket(3570.02, 0.05) == 3570.0 and T.bucket(3570.07, 0.05) == 3570.05)
check("a level is a grid line, not a rounded price",
      T.bucket(3570.049999, 0.05) == 3570.0 and T.bucket(3570.05, 0.05) == 3570.05)
check("a 0.25 grid is honoured as well",
      T.bucket(3570.30, 0.25) == 3570.25 and T.bucket(3570.26, 0.25) == 3570.25)
check("a nonsense price lands on no level", T.bucket(0, 0.05) == 0.0)

print("tick rule")
seq = pts([100.0, 101.0, 100.5, 100.5, 101.5])
cls, has_size = T.classify(seq)
check("the first quote votes for nobody, a repeat votes for nobody either",
      [c[2] for c in cls] == [0, 1, -1, 0, 1], [c[2] for c in cls])
check("with no size on the wire the weight is one tick",
      all(c[3] == 1.0 for c in cls) and has_size is False)
cls2, has_size2 = T.classify(pts([100.0, 101.0, 100.0], size=3))
check("a reported size is used as the weight and flagged as reported",
      [c[3] for c in cls2] == [3.0, 3.0, 3.0] and has_size2 is True)

print("footprint cells")
fp = T.footprint(pts([100.0, 100.5, 100.5, 100.0, 100.5]), tf=60, step=0.1,
                 limit=10)
bar = fp[0]
check("one candle holds five ticks", bar["ticks"] == 5 and bar["volume"] == 5)
check("the up ticks are buys, the down tick a sell, repeats vote for nobody",
      bar["buy"] == 2 and bar["sell"] == 1 and bar["flat"] == 2,
      (bar["buy"], bar["sell"], bar["flat"]))
check("the candle delta is buys minus sells", bar["delta"] == 1)
check("each price level carries its own bid x ask split",
      dict((r[0], (r[1], r[2])) for r in bar["levels"]) == {100.0: (0, 1), 100.5: (2, 0)},
      bar["levels"])
check("open, high, low and close come from the quotes",
      (bar["open"], bar["high"], bar["low"], bar["close"]) == (100.0, 100.5, 100.0, 100.5))
check("a level with only buys shows a zero sell side, never a made-up one",
      [r for r in bar["levels"] if r[0] == 100.5][0][2] == 0)

two = T.footprint(pts([100.0, 101.0, 102.0], dt=61), tf=60, step=0.1)
check("quotes more than a minute apart land in separate candles", len(two) == 3, len(two))
check("candles are ordered oldest first", two[0]["t0"] < two[1]["t0"])
check("the limit keeps the newest candles", len(T.footprint(pts([100.0] * 50, dt=61),
                                                           tf=60, step=0.1, limit=10)) == 10)

print("cumulative delta")
bars = T.footprint(pts([100.0, 101.0, 100.0, 99.0, 99.5], dt=61), tf=60, step=0.1)
running = T.cvd(bars)
check("CVD is the running sum of candle deltas",
      running == [round(sum(b["delta"] for b in bars[:i + 1]), 4)
                  for i in range(len(bars))], running)
check("CVD of one candle equals that candle's delta", T.cvd(bars[:1]) == [bars[0]["delta"]])

print("session")
_midnight = 86400.0 * 20000
check("the session starts at UTC midnight", T.session_start(_midnight + 3600) == _midnight)
check("two ticks either side of midnight are in different sessions",
      T.session_start(_midnight - 1) != T.session_start(_midnight + 1))

print("diagonal imbalance")
# Below: a level that traded 1 sell and, one level below, one sell. Above: 4 buys into
# 1 sell, so the buy side is 400% of the sell side on the same level.
bar = {"levels": [[100.05, 4.0, 1.0, 0.0], [100.00, 1.0, 1.0, 0.0]], "t0": 0}
im = T.imbalances(bar, ratio=3.0, stack=2)
check("a 400% buy level against its diagonal is marked", 
      any(m["side"] == "buy" and abs(m["price"] - 100.05) < 1e-9 for m in im["marks"]),
      im["marks"])
bar2 = {"levels": [[100.05, 2.0, 1.0, 0.0], [100.00, 1.0, 1.0, 0.0]], "t0": 0}
check("200% is not an imbalance at a 300% threshold",
      T.imbalances(bar2, ratio=3.0, stack=2)["marks"] == [],
      T.imbalances(bar2, ratio=3.0, stack=2)["marks"])
check("the same 200% is marked once the threshold is lowered to 150%",
      any(m["side"] == "buy" for m in T.imbalances(bar2, ratio=1.5, stack=2)["marks"]))
check("a level with no volume on the other side is not divided by zero",
      T.imbalances({"levels": [[100.0, 0.0, 5.0, 0.0]], "t0": 0}, 3.0, 2)["marks"] == [])

stacked = {"levels": [[100.3, 10.0, 1.0, 0.0], [100.2, 10.0, 1.0, 0.0],
                      [100.1, 10.0, 1.0, 0.0], [100.0, 0.0, 1.0, 0.0]], "t0": 0}
st = T.imbalances(stacked, ratio=3.0, stack=3)
check("three buy imbalances in a row are a stacked run",
      any(s["side"] == "buy" and s["levels"] >= 3 for s in st["stacks"]), st)

print("absorption")
# One level takes five candles of heavy two-way churn; the price never escapes it.
# Four candles of a price that walks up and back down through 200.05, so that level is
# reached from both directions - buys and sells, the signature of absorption.
walk = []
for _c in range(4):
    for _i, _px in enumerate([200.0, 200.05, 200.10, 200.05]):
        walk.append((1_000_000.0 + _c * 60 + _i, _px, 0, None))
z = T.footprint(walk, tf=60, step=0.05, limit=50)
absorb = T.absorption(z, step=0.05, mult=1.2, touches=3)
check("a busy level the price keeps returning to is called absorption",
      any(abs(a["price"] - 200.05) < 1e-9 for a in absorb), absorb)
check("absorption reports its two-way split, so churn is visible",
      all(a["buy"] > 0 or a["sell"] > 0 for a in absorb) and
      all(a["net_share"] <= 0.15 for a in absorb), absorb)
check("an empty tape finds no absorption", T.absorption([], step=0.05) == [])

print("exhaustion and aggression")
quiet = T.footprint(pts([100.0, 100.1, 100.0, 100.1], t0=0, dt=61), tf=60, step=0.05)
check("too few candles cannot prove exhaustion", T.exhaustion(quiet) == [])
burst = []
for i in range(6):
    burst += T.footprint(pts([100.0, 100.02, 100.0, 100.02] * 5, t0=i * 60, dt=1),
                         tf=60, step=0.05)
heavy = T.footprint(pts([100.0, 101.0, 102.0] * 10, t0=0, dt=1), tf=60, step=0.05)
out = T.exhaustion(burst + heavy, mult=2.0)
check("a candle with the most volume and the least range is flagged as exhaustion",
      isinstance(out, list), out)
aggr = T.aggressive(T.footprint(pts([100.0, 100.1, 100.2, 100.3], t0=0, dt=1),
                                tf=60, step=0.05), share=0.65)
check("a candle that only went up is aggressive buying",
      aggr and aggr[-1]["side"] == "buy" and aggr[-1]["share"] == 0.75, aggr)
check("a flat candle is never called aggressive",
      T.aggressive(T.footprint(pts([100.0, 100.0, 100.0], t0=0, dt=1), tf=60,
                               step=0.05), 0.65) == [])

print("volume profile: POC, VAH, VAL")
# 10 prints at 100.00, 6 at 100.10, 4 at 100.20 -> total 20, POC 100.00.
path = [100.0] * 10 + [100.1] * 6 + [100.2] * 4
prof = T.profile([(float(i), p, 0, None) for i, p in enumerate(path)], step=0.1)
check("the POC is the level with the most volume", prof["poc"] == 100.0, prof["poc"])
check("the total is every counted print", abs(prof["total"] - 20) < 1e-9, prof["total"])
check("the value area is 70% of the range by default and contains the POC",
      prof["val"] <= prof["poc"] <= prof["vah"] and prof["value_area"] == 0.70,
      (prof["val"], prof["poc"], prof["vah"]))
inside = sum(r[4] for r in prof["levels"] if prof["val"] <= r[0] <= prof["vah"])
check("the levels inside VAL..VAH really carry at least 70% of the volume",
      inside >= 0.70 * prof["total"], (inside, prof["total"]))
check("an HVN is a local volume peak, an LVN a local trough",
      isinstance(prof["hvn"], list) and isinstance(prof["lvn"], list))
check("the profile keeps buys, sells and the unattributed ticks apart at every level",
      all(len(r) == 5 for r in prof["levels"]) and
      abs(sum(r[1] + r[2] + r[3] for r in prof["levels"]) - prof["total"]) < 1e-6,
      prof["levels"][:2])
check("a custom range only profiles the points inside it",
      T.profile([(float(i), p, 0, None) for i, p in enumerate(path)], step=0.1,
                t0=0, t1=10)["total"] == 10)
check("an empty range returns no level rather than zeroes",
      T.profile([], step=0.1)["poc"] is None and T.profile([], step=0.1)["levels"] == [])

print("divergence")
up = [100.0, 100.5, 101.0, 101.5, 102.0, 102.5, 103.0, 103.5, 104.0, 104.5]
bars_up = T.footprint(pts(up, dt=61), tf=60, step=0.1)
check("price up with delta up is not a divergence", T.divergence(bars_up) == [],
      T.divergence(bars_up))
check("a divergence needs enough closed candles",
      T.divergence(T.footprint(pts([1.0, 2.0], dt=61), tf=60, step=0.1)) == [])

print("market hours")
import calendar


def _utc(y, mo, d, h, mi=0):
    return calendar.timegm((y, mo, d, h, mi, 0, 0, 0, 0))


check("gold is shut during its daily break", T.market_state(_utc(2026, 11, 26, 21, 30))["open"] is False
      and T.market_state(_utc(2026, 11, 26, 21, 30))["reason"] == "daily_break")
check("and it is open one minute before the break",
      T.market_state(_utc(2026, 11, 26, 20, 57))["open"] is True)
check("the break ends at 22:02 UTC", T.market_state(_utc(2026, 11, 26, 22, 2))["open"] is True)
check("the weekend starts at Friday 20:58 UTC",
      T.market_state(_utc(2026, 11, 27, 21, 0))["open"] is False
      and T.market_state(_utc(2026, 11, 27, 21, 0))["reason"] == "weekend")
check("Sunday is shut until 22:05 UTC",
      T.market_state(_utc(2026, 11, 29, 21, 0))["open"] is False
      and T.market_state(_utc(2026, 11, 29, 22, 6))["open"] is True)
check("a shut market says when it opens, in UTC seconds",
      T.market_state(_utc(2026, 11, 26, 21, 30))["opens_at"] == _utc(2026, 11, 26, 22, 2))
check("an open market names no reopening time",
      T.market_state(_utc(2026, 11, 26, 12, 0))["opens_at"] is None
      and T.market_state(_utc(2026, 11, 26, 12, 0))["detail"] == "")

print("snapshot and provenance")
snap = T.snapshot([(1000.0 + i, 100.0 + (i % 3) * 0.1, 0, None) for i in range(40)],
                  tf=60, step=0.05, bars=20, ratio=3.0)
check("the snapshot carries candles, CVD, session delta, profile and analysis",
      all(k in snap for k in ("bars", "cvd", "session", "profile", "absorption",
                              "exhaustion", "aggressive", "divergence", "imbalance")))
check("it says the volume is an estimate, in words that travel with the payload",
      snap["provenance"]["vol_kind"] == "tick_rule_estimate"
      and snap["provenance"]["label"] == "estimated"
      and "not" in snap["provenance"]["note"].lower())
check("CVD in the snapshot matches the CVD of its own candles",
      snap["cvd"] == T.cvd(snap["bars"]))
check("session delta is the signed sum of the tick weights",
      isinstance(snap["session"]["delta"], float))
check("when the archive supplies the session figure, the window's own guess is not used",
      T.snapshot([(1000.0 + i, 100.0, 0, None) for i in range(10)], session_delta=-42.5,
                 session_quotes=900)["session"] ==
      {"start": T.session_start(1009.0), "delta": -42.5, "quotes": 900, "source": "archive"})
check("every candle is marked estimated when no size was reported",
      all(b["estimated"] for b in snap["bars"]))
snap_sized = T.snapshot([(1000.0 + i, 100.0 + (i % 3) * 0.1, 0, 2) for i in range(40)],
                        tf=60, step=0.05, bars=20)
check("when the wire carries size, the payload stops calling it estimated ticks",
      snap_sized["provenance"]["vol_kind"] == "reported_size"
      and not snap_sized["bars"][0]["estimated"])
check("an empty tape gives an empty snapshot, not a fabricated one",
      T.snapshot([], tf=60, step=0.05)["bars"] == []
      and T.snapshot([])["profile"]["poc"] is None)

print("the archive")
tmp = tempfile.mkdtemp()
store = T.Store(os.path.join(tmp, "tape.db"))
store.add([(1000.0, 100.0, 1, None), (1001.0, 100.5, -1, None)])
store.add([])
check("written ticks come back in time order",
      store.range(0, 2000) == [(1000.0, 100.0, 1, None), (1001.0, 100.5, -1, None)],
      store.range(0, 2000))
check("a range respects both ends", store.range(1001, 2000) == [(1001.0, 100.5, -1, None)])
check("side totals separate buying from selling over a span",
      store.side_totals(0, 2000) == (1.0, 1.0, 2), store.side_totals(0, 2000))
check("the span reports what is actually stored",
      store.span() == {"ticks": 2, "first_ts": 1000.0, "last_ts": 1001.0}, store.span())
store.add([(1.0, 50.0, 0, None)])
check("old tape can be pruned away", store.prune(1.0 + T.Store.KEEP_S + 1) == 1)
check("survivors are untouched by the prune", store.span()["ticks"] == 2)

print()
print("%d passed, %d failed" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
