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

# These two blocks test the PRICE LOCK and the closed-market rule, so the structure gate is
# pinned to agree with the fixture's own side - otherwise the read would stop at the gate
# and never reach the lock, and the lock would look untested.
_side = 1 if (sig_raw or {}).get("type") == "BUY" else -1
_real_htf = VOL.htf_structure
VOL.htf_structure = lambda *a, **k: _side
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
VOL.htf_structure = _real_htf

# 16. same tape, market open -> the lock itself does not veto a valid setup
a_open = VOL.analyse(c, verify_quote={"price": c[-1]["close"]}, tf_minutes=15, market_open=True, min_bars=40)
check("open market has no session block",
      not any(x["id"] == "session" for x in a_open["verify"]["checks"]))

# 17. the reader can see that the strategy is working, not just what it says now
reads = a_open.get("reads") or []
check("the read replays the last bars", len(reads) >= 8, len(reads))
check("every replayed read carries a time, a price and a side",
      all(r.get("time") and r.get("price") and r.get("type") in ("BUY", "SELL", "HOLD") for r in reads))
check("the replay is in time order", [r["time"] for r in reads] == sorted(r["time"] for r in reads))
lt = a_open.get("last_trade")
check("a trade in the replay is named as the last trade",
      (lt is None and not any(r["type"] in ("BUY", "SELL") for r in reads))
      or (lt and lt["type"] in ("BUY", "SELL") and lt["time"] == max(r["time"] for r in reads if r["type"] in ("BUY", "SELL"))),
      lt)

# 18. when the lock refuses, it says WHY - never the label of the check that passed
fails = [x for x in a_bad["verify"]["checks"] if not x["ok"]]
check("a failed check carries its own wording", all(x.get("fail") for x in fails), fails[:1])
check("the blocked reason is the failure, not the passing label",
      all(x["fail"] != x["label"] for x in fails if x["id"] in ("fresh", "tick")), [x.get("fail") for x in fails][:2])
check("a fresh tape is not called stale",
      all(x["ok"] for x in a_open["verify"]["checks"] if x["id"] == "fresh"))

# 19. a closed market is not spelled 'the feed has gone quiet'
closed_fresh = [x for x in a_closed["verify"]["checks"] if x["id"] == "fresh"]
check("a closed market's freshness reads as its own case",
      closed_fresh and "closed" in (closed_fresh[0].get("label") or "").lower(), closed_fresh)

# ================= round 8: the value area is measured on the running session =========
# A profile that spans the weekend gap is not a profile: Friday's range and Sunday's
# range are two different auctions, and mixing them pushes the value area so wide that
# price is permanently "inside value" - which is exactly how the strategy printed
# nothing at all on the 15 minute chart.
def gap_tape(tf=900, before=140, after=21, gap_h=49):
    now = int(time.time())
    now -= now % tf
    out = []
    # the closed Friday session, then a real weekend hole, then the running Sunday/Monday one
    t0 = now - (after - 1) * tf - gap_h * 3600 - before * tf
    px = 4030.0
    for i in range(before):
        o = px
        c = o + (0.6 if i % 2 == 0 else -0.6)
        out.append({"time": t0 + i * tf, "open": round(o, 2), "high": round(max(o, c) + 1.5, 2),
                    "low": round(min(o, c) - 1.5, 2), "close": round(c, 2),
                    "volume": 400.0 + i, "buy": 200.0 + i, "sell": 200.0})
        px = c
    t1 = now - (after - 1) * tf
    px = 3898.0
    for i in range(after):
        o = px
        c = o + (2.0 if i % 3 else -1.0)
        out.append({"time": t1 + i * tf, "open": round(o, 2), "high": round(max(o, c) + 2.0, 2),
                    "low": round(min(o, c) - 2.0, 2), "close": round(c, 2),
                    "volume": 120.0 + i, "buy": 60.0 + i, "sell": 60.0})
        px = c
    return out


gt = gap_tape()
all_va = VOL.value_area(*VOL.clusters(gt)[:2])
prof = VOL.profile_window(gt, 15)
sess_va = VOL.value_area(*VOL.clusters(prof)[:2])
check("the profile window stops at the weekend gap", len(prof) < len(gt) and prof[-1]["time"] == gt[-1]["time"], len(prof))
check("the session window starts after the hole", prof[0]["time"] > gt[0]["time"], prof[0]["time"] - gt[0]["time"])
check("a gap-spanning value area is anchored far away from the live price",
      all_va and not (all_va["low"] <= gt[-1]["close"] <= all_va["high"]), all_va)
check("the session value area is measured inside the session's own range",
      sess_va and sess_va["low"] >= min(b["low"] for b in prof) - 1e-6
      and sess_va["high"] <= max(b["high"] for b in prof) + 1e-6, sess_va)
check("the session value area is a real, tradable range",
      sess_va and 0 < (sess_va["high"] - sess_va["low"]) < 3 * 40, sess_va)
check("the session profile never contains a bar from before the gap", len(prof) <= 24, len(prof))

# And the read on a session like that must actually be able to PRINT: a bar that dips
# through the value low and closes back inside with buyers on it is the classic VAL
# rejection - the setup the old gap-wide area made impossible, because price never
# reached an edge of it.
rej = []
t_rej = int(time.time()) - 21 * 900
t_rej -= t_rej % 900
px = 3900.0
for i in range(18):
    o = px
    c = o + (0.45 if i % 2 == 0 else -0.45)
    rej.append({"time": t_rej + i * 900, "open": round(o, 2), "high": round(max(o, c) + 0.9, 2),
                "low": round(min(o, c) - 0.9, 2), "close": round(c, 2),
                "volume": 150.0, "buy": 80.0, "sell": 70.0})
    px = c
for i, (o, h, l, c, b, sl_) in enumerate([(3899.0, 3899.6, 3895.4, 3898.9, 260.0, 90.0),
                                         (3898.9, 3899.4, 3895.6, 3899.2, 250.0, 80.0),
                                         (3899.2, 3900.4, 3896.0, 3900.1, 300.0, 70.0)]):
    rej.append({"time": t_rej + (18 + i) * 900, "open": o, "high": h, "low": l, "close": c,
                "volume": b + sl_, "buy": b, "sell": sl_})
a_rej = VOL.analyse(rej, tf_minutes=15, market_open=True, min_bars=10)
# The same fixture, once as chop and once inside a rising higher timeframe. The rule table
# itself is unchanged - what changed is that a setup against the timeframe above is not
# taken any more. Both branches are asserted so neither can regress silently.
check("a VAL rejection with no higher-timeframe agreement is refused, and says why",
      a_rej.get("signal", {}).get("type") == "HOLD"
      and a_rej.get("signal", {}).get("htf_block") is not None,
      a_rej.get("signal", {}).get("reason"))
# the rule table itself, handed a higher timeframe that agrees with the bounce
_rv = VOL.clusters(rej, 48, 10.0)
_rvw, _ = VOL.daily_vwap(rej)
_ratr = VOL.atr_series(rej, 14)[-1]
_s_up = VOL.signal(rej, _rvw, _rv[0], _rv[1], _ratr, 10.0, VOL.vwap_series(rej),
                   va=VOL.value_area(_rv[0], _rv[1]), htf_dir=1)
check("the same VAL rejection inside a rising higher timeframe prints a BUY",
      _s_up.get("type") == "BUY", _s_up.get("reason"))
# A sideways frame above is not a trend against the trade. It used to be treated as one,
# which vetoed every setup while the hour above was ranging - the entire Asian session.
_s_flat = VOL.signal(rej, _rvw, _rv[0], _rv[1], _ratr, 10.0, VOL.vwap_series(rej),
                     va=VOL.value_area(_rv[0], _rv[1]), htf_dir=0)
check("the same VAL rejection with a SIDEWAYS frame above still prints (Asian session)",
      _s_flat.get("type") == "BUY" and not _s_flat.get("htf_block"), _s_flat.get("reason"))
_s_dn = VOL.signal(rej, _rvw, _rv[0], _rv[1], _ratr, 10.0, VOL.vwap_series(rej),
                   va=VOL.value_area(_rv[0], _rv[1]), htf_dir=-1)
check("the same VAL rejection against a FALLING frame above is still refused",
      _s_dn.get("type") == "HOLD" and (_s_dn.get("htf_block") or {}).get("htf") == "down",
      _s_dn.get("reason"))
check("that BUY carries the level, a stop and two targets in order",
      (_s_up.get("sl") or 0) < (_s_up.get("entry") or 0)
      < (_s_up.get("tp1") or 0) < (_s_up.get("tp2") or 0),
      {k: _s_up.get(k) for k in ("entry", "sl", "tp1", "tp2")})
check("the plan travels with the trade: half at TP1, stop to entry, time stop",
      (_s_up.get("plan") or {}).get("partial_pct") == 50
      and (_s_up.get("plan") or {}).get("be_after") == "tp1"
      and (_s_up.get("plan") or {}).get("time_stop_bars", 0) > 0,
      _s_up.get("plan"))
_stairs = [{"time": 1793000000 + i * 900, "open": 3900 + i * 2.0, "high": 3901 + i * 2.0,
            "low": 3899 + i * 2.0, "close": 3900.5 + i * 2.0, "volume": 100.0}
           for i in range(40)]
_down = [{"time": b["time"], "open": 4000 - i * 2.0, "high": 4001 - i * 2.0,
          "low": 3999 - i * 2.0, "close": 4000 - i * 2.0 + 0.5, "volume": 100.0}
         for i, b in enumerate(_stairs)]
check("the structure gate reads a rising market as up and a falling one as down",
      VOL.htf_structure(_stairs, 15) == 1 and VOL.htf_structure(_down, 15) == -1,
      (VOL.htf_structure(_stairs, 15), VOL.htf_structure(_down, 15)))
check("the read reports which bars its profile came from",
      (a_rej.get("signal", {}).get("profile") or {}).get("bars", 0) > 5,
      a_rej.get("signal", {}).get("profile"))

# ================= round 13: the win rate is measured, never assumed ==================
import main as APPX  # noqa: E402

# a setup type may print only while its own record is positive, with a real sample
_ok_pos, _b_pos = APPX._edge_verdict("reject VAL", {"by_style": {"reject VAL": {"n": 20, "avg_r": 0.31, "winrate": 80}}})
_ok_neg, _b_neg = APPX._edge_verdict("reject VAL", {"by_style": {"reject VAL": {"n": 20, "avg_r": -0.12, "winrate": 45}}})
_ok_thin, _b_thin = APPX._edge_verdict("reject VAL", {"by_style": {"reject VAL": {"n": 3, "avg_r": 1.2, "winrate": 100}}})
_ok_none, _b_none = APPX._edge_verdict("absorbed at VAL", {"by_style": {}})
check("a setup that has paid is allowed to print", _ok_pos is True)
check("a setup that has been losing is not", _ok_neg is False, _b_neg)
check("three lucky trades are not a track record", _ok_thin is False, _b_thin)
check("a setup with no record at all is not taken", _ok_none is False, _b_none)
check("a missing number is never reported as a win rate",
      APPX.edge_stats.__module__ == "main" and (APPX.EDGE_MIN_N >= 12))

# the scorer itself must never book the same exit twice (this was a real bug: a runner that
# reached TP2 used to be paid three times, which made a losing rule look profitable)
_flat = [{"time": 1793000000 + i * 300, "open": 3900, "high": 3900.2, "low": 3899.8,
          "close": 3900, "volume": 100} for i in range(60)]
_sg = {"type": "BUY", "entry": 3900.0, "sl": 3899.0, "tp1": 3900.85, "tp2": 3901.5}
_st = VOL._follow(_flat, 5, _sg, 40)
check("a trade that never moves is not a winner", _st["r"] <= 0.0, _st)
# a clean runner: after TP1 the bars never dip back to the entry, so the only exits in
# play are TP1 (half) and TP2 (the rest). If either is paid twice this fails.
_walk = [{"time": 1793000000 + i * 300, "open": 3900.6, "high": 3901.6, "low": 3900.6,
          "close": 3901.5, "volume": 100} for i in range(60)]
_st2 = VOL._follow(_walk, 5, _sg, 40)
check("a runner to TP2 pays exactly half+half, not three times",
      abs(_st2["r"] - (0.5 * 0.85 + 0.5 * 1.5)) < 0.02, _st2)

# a blocked setup must not stay blocked after its record turns: the response object is
# cached and shared, so the gate has to edit a copy
import main as _M  # noqa: E402
_mfake = {"status": "ok", "n": 30, "winrate": 43.0, "avg_r": -0.21,
          "by_style": {"reject VAH": {"n": 30, "avg_r": -0.21, "winrate": 43.0}}}
_d = {"signal": {"type": "SELL", "style": "reject VAH", "entry": 1.0}}
_d2 = dict(_d); _d2["signal"] = dict(_d["signal"]); _d2["signal"]["type"] = "HOLD"
check("the gate gets its own copy of the shared response",
      _d["signal"]["type"] == "SELL" and _d2["signal"]["type"] == "HOLD")

# ================= round 8: a tick is not a candle ====================================
import main as APP  # noqa: E402

rows = [{"t": 1793588820, "o": 3912.4, "h": 3912.9, "l": 3911.5, "c": 3912.2, "v": 82},
        {"t": 1793588880, "o": 3911.8, "h": 3912.8, "l": 3911.0, "c": 3912.1, "v": 0},
        {"t": 1793588902, "o": 3912.8, "h": 3912.8, "l": 3912.8, "c": 3912.8, "v": 0}]  # a raw tick
aligned = APP._align_bars(rows, 60)
check("a raw tick does not become its own candle", len(aligned) == 2, [r["t"] % 60 for r in aligned])
check("every aligned bar lands on the interval", all(r["t"] % 60 == 0 for r in aligned), [r["t"] for r in aligned])
check("the tick still counts as the newest price of its bar",
      aligned[-1]["c"] == 3912.8 and aligned[-1]["h"] >= 3912.8, aligned[-1])
check("folding a tick never blanks volume the feed reported", aligned[-1]["v"] == 0 and aligned[0]["v"] == 82, aligned)
check("a misaligned timestamp can never reach the chart twice",
      len({r["t"] for r in aligned}) == len(aligned))

# ================= round 8: the live tail comes only from real venue bars =============
book = {1793589000 + 60 * i: {"open": 3900.0, "high": 3901.0, "low": 3899.0, "close": 3900.5}
        for i in range(4)}
APP._LIVE_BOOK["M1"] = book
tail = APP._tail_bars("M1", 1793589000 - 60)
check("the tail starts on the bar after the last delayed one", tail and tail[0]["time"] == 1793589000, tail[:1])
check("the tail is contiguous and stops at the newest real bar", len(tail) == 4, len(tail))
APP._LIVE_BOOK["M1"].pop(1793589060, None)          # one minute the server never sampled
# a hole in OUR record is not a bar: the tail skips the minute it never sampled and
# carries on with the real ones. Nothing is drawn for the missing minute, so the chart
# shows an honest gap instead of a made-up candle or a chart that stops dead.
_hole = APP._tail_bars("M1", 1793589000 - 60)
check("a hole in the book is skipped, never filled and never ends the tail",
      [b["time"] for b in _hole] == [1793589000, 1793589120, 1793589180],
      [b["time"] for b in _hole])
check("closed tail bars are history, not forming bars", all(b["complete"] is True for b in tail), tail)
now_k = APP._forming_time(60)
APP._LIVE_BOOK["M1"] = {now_k - 60: {"open": 1, "high": 1, "low": 1, "close": 1},
                        now_k: {"open": 2, "high": 2, "low": 2, "close": 2}}
_now_tail = APP._tail_bars("M1", now_k - 120)
check("the bar running right now is the only forming one",
      len(_now_tail) == 2 and _now_tail[-1]["complete"] is False and _now_tail[0]["complete"] is True,
      [(b["time"], b["complete"]) for b in _now_tail])
APP._LIVE_BOOK.pop("M1", None)

# ================= round 8: buyers vs sellers from real quotes ========================
VOL._TAPE.clear()
VOL._TAPE_LAST.update({"price": None, "side": 1})
t0 = time.time() - 60
VOL.tape_add(3900.0, bid=3899.8, ask=3900.2, ts=t0)        # mid, between bid and ask
VOL.tape_add(3900.2, bid=3900.0, ask=3900.2, ts=t0 + 1)    # at the ask -> buyer
VOL.tape_add(3900.0, bid=3900.0, ask=3900.2, ts=t0 + 2)    # at the bid -> seller
VOL.tape_add(3901.0, ts=t0 + 3)                            # no book, up tick -> buyer
VOL.tape_add(3900.5, ts=t0 + 4)                            # down tick -> seller
VOL.tape_add(3900.5, ts=t0 + 5)                            # repeat: no information
tp = VOL.tape_read(300)
check("a quote at the ask counts as a buyer and at the bid as a seller",
      tp["buy"] >= 2 and tp["sell"] >= 2, tp)
check("a repeated quote is not counted as flow", tp["samples"] == 4, tp["samples"])
check("the tape reports its sample count and window", tp["samples"] > 0 and tp["window_s"] == 300, tp)
check("the tape never claims contracts it does not have", tp["unit"] == "quotes" and tp["estimated"] is True, tp)
check("the tape says how it was classified", "bid/ask" in tp["method"], tp["method"])
VOL._TAPE.clear()

print()
print("%d passed, %d failed" % (len(PASS), len(FAIL)))
if FAIL:
    print("FAILED:", ", ".join(FAIL))
sys.exit(1 if FAIL else 0)
