"""PRICE LOCK — the gate that decides whether the strategy is allowed to print a trade.

Every case below is built from real OHLCV shapes (a normal gold tape at ~3876), then
one thing is broken at a time. The lock must refuse the read every single time, and
must NOT refuse a clean tape. Run: python3 tests/price_lock.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import volume as VOL  # noqa: E402

PASS = []
FAIL = []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (("   " + str(extra)) if extra and not cond else ""))


def tape(n=150, start=3876.0, step=0.4, tf=900, end=None):
    """A clean, coherent 15m gold tape."""
    now = end or int(time.time())
    t0 = now - n * tf
    out, px = [], start
    for i in range(n):
        o = px
        c = o + (step if i % 2 == 0 else -step)
        out.append({"time": t0 + i * tf, "open": round(o, 2), "high": round(max(o, c) + 0.5, 2),
                    "low": round(min(o, c) - 0.5, 2), "close": round(c, 2),
                    "volume": 120.0 + i, "buy": 62.0 + i * 0.1, "sell": 58.0 + i * 0.1})
        px = c
    return out


def run(candles, quote, **kw):
    kw.setdefault("tf_minutes", 15)
    kw.setdefault("market_open", True)
    kw.setdefault("min_bars", 40)
    atr = kw.pop("atr", None) or 1.2
    return VOL.verify(candles, atr=atr, quote=quote, **kw)


CLEAN = {"price": 3876.0, "bid": 3875.8, "ask": 3876.2}

print("PRICE LOCK — synthetic cases")
# 1. a clean tape must pass, otherwise the gate is useless
c = tape()
live = c[-1]["close"]
v = run(c, {"price": live, "bid": live - 0.2, "ask": live + 0.2})
check("clean tape + agreeing quote passes", v["ok"], v["blocked_by"])
check("all eight layers reported", len(v["checks"]) == 8, len(v["checks"]))
check("grade is ok (no warnings)", v["grade"] == "ok", v["grade"])

# 2. the live quote contradicts the chart by far more than any venue difference
v = run(c, {"price": live * 1.08, "bid": live * 1.08 - 0.2, "ask": live * 1.08 + 0.2})
check("quote 8% away from the last bar is blocked", not v["ok"] and "tick" in [x["id"] for x in v["checks"] if not x["ok"]], v["blocked_by"])

# 3. a venue difference of a few dollars (gold: xaus spot vs TradingView) must NOT block
v = run(c, {"price": live + 6.0, "bid": live + 5.8, "ask": live + 6.2})
check("a normal 6-dollar venue gap still passes", v["ok"], v["blocked_by"])

# 4. the chart has fallen behind its own tape (stale bars, market open)
old = tape(end=int(time.time()) - 5 * 3600)
v = run(old, {"price": old[-1]["close"]})
check("bars five hours old on an open market are blocked", not v["ok"])

# 5. same stale bars, market closed -> allowed, because a weekend is not a fault
v = run(old, {"price": old[-1]["close"]}, market_open=False)
check("market closed tolerates old bars", v["ok"], v["blocked_by"])

# 6. one corrupted bar (close above its own high)
bad = tape()
bad[-2]["high"] = bad[-2]["close"] - 3.0
v = run(bad, {"price": bad[-1]["close"]})
check("a bar whose close is above its high is blocked", not v["ok"])

# 7. duplicate timestamps
dup = tape()
dup[-1]["time"] = dup[-2]["time"]
v = run(dup, {"price": dup[-1]["close"]})
check("duplicate timestamps are blocked", not v["ok"])

# 8. a lone spike print
spike = tape()
spike[-1]["close"] = spike[-1]["close"] * 1.35
spike[-1]["high"] = spike[-1]["close"] + 1
v = run(spike, {"price": spike[-1]["close"]})
check("a 35% single-bar spike is blocked", not v["ok"], v["blocked_by"])

# 9. crossed book
v = run(c, {"price": live, "bid": live + 1.0, "ask": live - 1.0})
check("a crossed book (bid above ask) is blocked", not v["ok"])

# 10. absurd spread
v = run(c, {"price": live, "bid": live * 0.90, "ask": live * 1.10})
check("a 20% spread is blocked", not v["ok"])

# 11. decimal slip: the feed drops a digit
slip = tape()
slip[-1]["close"] = slip[-1]["close"] / 100.0
v = run(slip, {"price": slip[-1]["close"]})
check("a decimal-slip price is blocked", not v["ok"], v["blocked_by"])

# 12. too little history for a value area to mean anything
v = run(tape(18), {"price": tape(18)[-1]["close"]})
check("18 bars is not enough history", not v["ok"])

# 13. no quote at all is a warning, not a block (the chart alone can still be read)
v = run(c, None)
check("no live quote only warns", v["ok"] and v["grade"] == "warn", v["grade"])

# 14. the whole strategy respects the lock: analyse() turns a blocked BUY into HOLD
rows = VOL.clusters(c, 48, 10.0)
vw, _used = VOL.daily_vwap(c)
atr = 1.2
sig_raw = VOL.signal(c, vw, rows[0], rows[1], atr, 10.0, VOL.vwap_series(c), va=VOL.value_area(rows[0], rows[1]))
a_ok = VOL.analyse(c, verify_quote={"price": c[-1]["close"]}, tf_minutes=15, market_open=True, min_bars=40)
check("analyse() attaches a verify block", isinstance(a_ok.get("verify"), dict) and "checks" in (a_ok.get("verify") or {}))
check("analyse() keeps a good tape tradable", a_ok["verify"]["ok"] is True)

a_bad = VOL.analyse(c, verify_quote={"price": c[-1]["close"] * 1.08}, tf_minutes=15, market_open=True, min_bars=40)
check("analyse() with a wrong quote is blocked", a_bad["verify"]["ok"] is False)
check("a blocked read is forced to HOLD", (a_bad.get("signal") or {}).get("type") == "HOLD", (a_bad.get("signal") or {}).get("type"))
check("the refused setup is preserved for the record",
      isinstance((a_bad.get("signal") or {}).get("blocked"), dict), (a_bad.get("signal") or {}).get("blocked"))
check("the lock is named in the reason", "price lock" in str((a_bad.get("signal") or {}).get("reason", "")).lower())
check("signal.verified mirrors the lock", (a_bad.get("signal") or {}).get("verified") is False)

# 15. a closed market must not print a trade, even on a perfect tape
a_closed = VOL.analyse(c, verify_quote={"price": c[-1]["close"]}, tf_minutes=15, market_open=False, min_bars=40)
locked_closed = any(x["id"] == "session" and not x["ok"] for x in a_closed["verify"]["checks"])
has_trade = (a_closed.get("signal") or {}).get("type") in ("BUY", "SELL")
check("closed market adds the session check", locked_closed)
check("closed market never prints BUY or SELL", not has_trade, (a_closed.get("signal") or {}).get("type"))
check("closed market still reads the tape (HOLD with a reason)",
      (a_closed.get("signal") or {}).get("type") == "HOLD" and bool((a_closed.get("signal") or {}).get("reason")))

# 16. same tape, market open -> the lock itself does not veto a valid setup
a_open = VOL.analyse(c, verify_quote={"price": c[-1]["close"]}, tf_minutes=15, market_open=True, min_bars=40)
check("open market has no session block",
      not any(x["id"] == "session" for x in a_open["verify"]["checks"]))

print()
print("%d passed, %d failed" % (len(PASS), len(FAIL)))
if FAIL:
    print("FAILED:", ", ".join(FAIL))
sys.exit(1 if FAIL else 0)
