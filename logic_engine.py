"""ASTRA6 LOGIC ENGINE - the M1 gold scalping model, in plain Python.

One model, two runtimes: this module and astra6_logic_engine.pine implement the same
rules. If they disagreed, the site would be quoting a strategy nobody could check on a
chart - the exact failure this project keeps getting caught in.

NON-REPAINTING BY CONSTRUCTION
  * A decision at entry bar i is made at that bar's CLOSE and uses bars 0..i only.
  * Higher timeframes are real bars whose period has already ENDED at that moment
    (time + period <= close of bar i). No partial bar, no lookahead, no clock-guessing.
  * Pivots are only usable `pivot_len` bars after they print, so the engine cannot
    "see" a swing before the market has made it.

THE MODEL (bias timeframe -> confirmation -> entry)
  BIAS  : market structure -> bullish / bearish / neutral
  CONF  : liquidity sweep -> BOS/MSS -> displacement -> FVG, on confirmed bars
  ENTRY : retrace into the FVG + candle direction + momentum -> the trigger
  Score out of 100. A trade needs >= min_score and every structural condition present.

COSTS
  Spread is charged on every trade as spread/risk in R. On an M1 stop of $2 the 0.35
  spot spread is 0.18R, which is the whole ballgame - leaving it out is how a losing
  scalper looks profitable on paper.
"""

TF_S = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600, "H4": 14400}

DEFAULTS = {
    "pivot_len": 3,          # a swing needs 3 bars on each side before it is real
    "eq_tol": 0.25,          # equal highs/lows: within this many ATR
    "disp_k": 1.2,           # displacement: body >= 1.2 x ATR
    "sl_buffer": 0.15,       # stop buffer, in ATR
    "min_score": 70,
    "tp": (1.0, 1.5, 2.0, 3.0),
    "sweep_look": 40,        # how many confirmation bars back a sweep may be
    "entry_s": 60,           # entry timeframe in seconds
    "confirm_s": 300,        # confirmation timeframe
    "bias_s": 3600,          # bias timeframe
    "spread": 0.0,           # price units charged per round trip
    "stop_mode": "sweep",    # sweep | fvg | tightest
    "risk_max_atr": 0.0,     # 0 = no cap; otherwise skip setups wider than this many ATR
    "fresh_conf": 0,         # 0 = any age; otherwise the gap must be this new (confirm bars)
    "allow_buy": True,
    "allow_sell": True,
}


# ---------------------------------------------------------------- bar helpers
def _rng(b, p=None):
    if p is None:
        return b["high"] - b["low"]
    return max(b["high"] - b["low"], abs(b["high"] - p["close"]), abs(b["low"] - p["close"]))


def atr_list(bars, n=14):
    out, trs = [], []
    for i, b in enumerate(bars):
        trs.append(_rng(b, bars[i - 1] if i else None))
        out.append(None if i < n else sum(trs[i - n + 1:i + 1]) / n)
    return out


def pivot_list(bars, n=3, kind="high"):
    """Confirmed pivots only: index j becomes usable once n bars have closed after it."""
    out = []
    for j in range(n, len(bars) - n):
        w = bars[j - n:j + n + 1]
        v = bars[j]["high"] if kind == "high" else bars[j]["low"]
        if kind == "high" and v == max(x["high"] for x in w):
            out.append((j, v))
        elif kind == "low" and v == min(x["low"] for x in w):
            out.append((j, v))
    return out


def equal_levels(pivs, atr, tol=0.25):
    """Pivots within `tol` ATR of each other = one level with several taps.

    Equal highs are buy-side liquidity (stops sit above them), equal lows sell-side.
    The tap count is what separates a level worth sweeping from a random wick.
    """
    levels = []
    for j, v in pivs:
        if levels and abs(v - levels[-1]["price"]) <= tol * atr:
            levels[-1]["price"] = (levels[-1]["price"] + v) / 2.0
            levels[-1]["taps"] += 1
            levels[-1]["last"] = j
        else:
            levels.append({"price": v, "taps": 1, "last": j})
    return levels


def sweep_at(bars, i, level, side, atr, min_dist=0.05):
    """Bar i swept `level` and closed back through it.

    A wick alone is not a sweep: the close has to come back, and the overshoot has to
    clear min_dist x ATR so a one-tick poke is not counted.
    """
    b = bars[i]
    if side == 1:
        return (level - b["low"]) >= min_dist * atr and b["close"] > level
    return (b["high"] - level) >= min_dist * atr and b["close"] < level


def displacement_dir(b, atr, k=1.2):
    body = abs(b["close"] - b["open"])
    if atr and body >= k * atr:
        return 1 if b["close"] > b["open"] else -1
    return 0


def fvg_at(bars, i, side):
    """3-bar imbalance whose middle bar is i-1, tested at bar i -> (top, bottom)."""
    if i < 2:
        return None
    a, c = bars[i - 2], bars[i]
    if side == 1 and c["low"] > a["high"]:
        return (c["low"], a["high"])
    if side == -1 and c["high"] < a["low"]:
        return (a["low"], c["high"])
    return None


def last_fvg(bars, side, atr, look=20, i=None, min_h=0.05):
    """Most recent FVG still open (not traded back through) within `look` bars."""
    i = len(bars) - 1 if i is None else i
    for k in range(i, max(1, i - look), -1):
        g = fvg_at(bars, k, side)
        if not g:
            continue
        top, bot = g
        if (top - bot) < min_h * atr:
            continue
        filled = any((bars[m]["low"] <= bot) if side == 1 else (bars[m]["high"] >= top)
                     for m in range(k + 1, i + 1))
        if not filled:
            return {"top": top, "bot": bot, "at": k, "h_atr": (top - bot) / atr}
    return None


def bos_at(bars, i, side, pivs_hi, pivs_lo, pivot_len=3):
    """BOS / MSS at bar i: close beyond the last swing confirmed BEFORE this bar."""
    src = pivs_hi if side == 1 else pivs_lo
    ref = None
    for j, v in src:
        if j + pivot_len <= i:
            ref = (j, v)
    if ref is None:
        return None
    j, v = ref
    ok = bars[i]["close"] > v if side == 1 else bars[i]["close"] < v
    return {"level": v, "at": j, "ok": ok}


def bias_detail(bars, pivot_len=3):
    """Bias from H1 market structure, tie-broken by price vs the 20-bar mean.

    Returns {"dir": +1/-1/0, "strength": "structure"|"mean"|"none"} - the strength is
    what the score grades, otherwise every setup would score 100 and the minimum score
    setting would be decoration.
    """
    if len(bars) < 10:
        return {"dir": 0, "strength": "none"}
    hi = pivot_list(bars, pivot_len, "high")[-2:]
    lo = pivot_list(bars, pivot_len, "low")[-2:]
    closes = [b["close"] for b in bars]
    mean = sum(closes[-20:]) / min(20, len(closes))
    up = len(hi) == 2 and hi[-1][1] > hi[0][1] and len(lo) == 2 and lo[-1][1] > lo[0][1]
    dn = len(hi) == 2 and hi[-1][1] < hi[0][1] and len(lo) == 2 and lo[-1][1] < lo[0][1]
    if up:
        return {"dir": 1, "strength": "structure"}
    if dn:
        return {"dir": -1, "strength": "structure"}
    d = 1 if closes[-1] > mean else (-1 if closes[-1] < mean else 0)
    return {"dir": d, "strength": "mean" if d else "none"}


def bias_from(bars, pivot_len=3):
    return bias_detail(bars, pivot_len)["dir"]


def _closed(bars, end_time, period_s):
    """Bars of that timeframe whose period ended at or before end_time - the whole
    non-repainting argument in one function."""
    return [b for b in bars if int(b["time"]) + period_s <= end_time]


def _ema(vals, n):
    if not vals:
        return None
    k = 2.0 / (n + 1)
    e = vals[0]
    for v in vals[1:]:
        e = v * k + e * (1 - k)
    return e


# ---------------------------------------------------------------- the read
def evaluate(entry, conf, bias_bars, i, cfg=None, atr=None):
    """The read at entry bar i. Returns the score, every component, and the levels."""
    c = dict(DEFAULTS)
    c.update(cfg or {})
    atr = atr if atr is not None else (atr_list(entry, 14)[i] if i < len(entry) else None)
    b = entry[i]
    end = int(b["time"]) + c["entry_s"]
    if not atr or atr <= 0:
        return {"ok": False, "score": 0, "side": 0, "why": ["not enough bars for ATR"],
                "atr": atr}

    confc = _closed(conf, end, c["confirm_s"])[-240:] if conf else []
    biasc = _closed(bias_bars, end, c["bias_s"])[-120:] if bias_bars else []
    bd = bias_detail(biasc, c["pivot_len"]) if len(biasc) >= 10 else {"dir": 0, "strength": "none"}

    best = None
    for s in ((1, -1) if (c["allow_buy"] and c["allow_sell"]) else
              ((1,) if c["allow_buy"] else ((-1,) if c["allow_sell"] else ()))):
        got = _side_setup(entry, confc, i, s, atr, c, bd)
        if got and (best is None or got["score"] > best["score"]):
            best = got
    if not best:
        return {"ok": False, "score": 0, "side": 0, "bias": bd["dir"], "atr": atr,
                "why": ["no sweep of a known level in the last %d bars" % c["sweep_look"]]}

    best.update({"bias": bd["dir"], "atr": atr, "at": int(b["time"])})
    best["ok"] = (best["score"] >= c["min_score"] and best.get("trigger") is True)
    best["why"] = best.pop("_why")
    return best


def _side_setup(entry, confc, i, side, atr, c, bd):
    """One side: confirmation-timeframe context + entry-timeframe trigger."""
    tag = "bullish" if side == 1 else "bearish"
    _why = []

    # ---- 1. bias alignment (20) -----------------------------------------------------
    if bd["dir"] == side:
        pts = 20 if bd["strength"] == "structure" else 12
        _why.append("bias is %s by %s (+%d)" % (tag, bd["strength"], pts))
    elif bd["dir"] and bd["dir"] != side:
        _why.append("bias is against this side (0)")
        pts = 0
    else:
        _why.append("bias undecided (0)")
        pts = 0

    # ---- 2. liquidity sweep on the confirmation timeframe (20/15) -------------------
    if len(confc) < 20:
        return None
    catr = atr_list(confc, 14)[-1]
    if not catr:
        return None
    pivs = pivot_list(confc, c["pivot_len"], "low" if side == 1 else "high")
    if not pivs:
        return None
    levels = equal_levels(pivs, catr, c["eq_tol"])
    sw = None
    for j in range(len(confc) - 1, max(0, len(confc) - 1 - c["sweep_look"]), -1):
        lv = (min(levels, key=lambda L: abs(L["price"] - confc[j]["low"])) if side == 1
              else min(levels, key=lambda L: abs(L["price"] - confc[j]["high"])))
        if lv["last"] < j and sweep_at(confc, j, lv["price"], side, catr):
            sw = {"at": j, "level": lv["price"], "taps": lv["taps"],
                  "extreme": confc[j]["low"] if side == 1 else confc[j]["high"]}
            break
    if not sw:
        return None
    sw_pts = 20
    _why.append("%s sweep of %.2f (%d taps, +%d)" % (tag, sw["level"], sw["taps"], sw_pts))

    # ---- 3. BOS / MSS (15, or 10 if it came late) -----------------------------------
    hi_p = pivot_list(confc, c["pivot_len"], "high")
    lo_p = pivot_list(confc, c["pivot_len"], "low")
    bos = None
    for j in range(sw["at"], len(confc)):
        g = bos_at(confc, j, side, hi_p, lo_p, c["pivot_len"])
        if g and g["ok"] and g["at"] < sw["at"]:
            bos = {"at": j, "level": g["level"]}
    if not bos:
        return None
    bos_pts = 15 if (bos["at"] - sw["at"]) <= 3 else 10
    _why.append("BOS through %.2f (+%d)" % (bos["level"], bos_pts))

    # ---- 4. displacement (15 / 11 by strength) --------------------------------------
    disp = None
    for j in range(sw["at"], len(confc)):
        if displacement_dir(confc[j], catr, c["disp_k"]) == side:
            disp = j
            break
    if disp is None:
        return None
    body = abs(confc[disp]["close"] - confc[disp]["open"]) / catr
    disp_pts = 15
    _why.append("displacement %.1f x ATR (+%d)" % (body, disp_pts))

    # ---- 5. FVG = the entry zone (15 / 10 by size) ----------------------------------
    fv = last_fvg(confc, side, catr, look=max(4, len(confc) - disp), i=len(confc) - 1)
    if fv and fv["at"] < disp:          # a gap from before the displacement is not this setup
        fv = None
    if fv and c.get("fresh_conf") and (len(confc) - 1 - fv["at"]) > c["fresh_conf"]:
        fv = None                       # the retrace came too late to be the same leg
    if not fv:
        return None
    fvg_pts = 15
    _why.append("FVG %.2f-%.2f (+%d)" % (fv["bot"], fv["top"], fvg_pts))

    # ---- 6. entry trigger: retrace into the gap, candle, momentum -------------------
    top, bot = fv["top"], fv["bot"]
    in_zone = ((entry[i]["low"] <= top and entry[i]["close"] >= bot) if side == 1
               else (entry[i]["high"] >= bot and entry[i]["close"] <= top))
    candle_ok = ((entry[i]["close"] > entry[i]["open"]) if side == 1
                 else (entry[i]["close"] < entry[i]["open"]))
    ema = _ema([x["close"] for x in entry[max(0, i - 40):i + 1]], 9)
    ema_ok = ema is not None and ((entry[i]["close"] > ema) if side == 1 else
                                  (entry[i]["close"] < ema))
    mom_pts = (10 if (in_zone and candle_ok) else 0) + (5 if ema_ok else 0)
    if in_zone and candle_ok:
        _why.append("retraced into the gap, candle agrees (+10)")
    if ema_ok:
        _why.append("entry momentum agrees (+5)")

    trigger = bool(in_zone and candle_ok)
    entry_px = entry[i]["close"]
    buf = c["sl_buffer"] * atr
    stop_sweep = sw["extreme"] - side * buf
    stop_fvg = (fv["bot"] - side * buf) if side == 1 else (fv["top"] + side * buf)
    mode = c.get("stop_mode", "sweep")
    if mode == "fvg":
        stop = stop_fvg
    elif mode == "tightest":
        # the nearer of the two, provided it still sits beyond the entry
        stop = max(stop_sweep, stop_fvg) if side == 1 else min(stop_sweep, stop_fvg)
        if (stop_fvg - entry_px) * side <= 0.2 * atr:
            stop = stop_sweep
    else:
        stop = stop_sweep
    risk = abs(entry_px - stop)
    if risk <= 0:
        return None
    if c.get("risk_max_atr") and risk > c["risk_max_atr"] * atr:
        return None
    tp = [round(entry_px + side * rr * risk, 2) for rr in c["tp"]]
    out = {"side": side, "score_h1": pts, "score_sweep": sw_pts, "score_bos": bos_pts,
           "score_disp": disp_pts, "score_fvg": fvg_pts, "score_mom": mom_pts,
           "trigger": trigger, "_why": _why,
           "sweep": sw, "bos": bos, "fvg": fv, "ema_ok": bool(ema_ok),
           "entry": round(entry_px, 2), "sl": round(stop, 2), "risk": round(risk, 2),
           "tp": tp, "type": "BUY" if side == 1 else "SELL"}
    out["score"] = (pts + sw_pts + bos_pts + disp_pts + fvg_pts + mom_pts)
    return out


# ---------------------------------------------------------------- replay / stats
def replay(entry, conf, bias_bars, cfg=None, max_hold=240, step=1):
    """Walk the bars once; take every setup; book the outcome.

    Same-bar rule: if one entry bar touches both the stop and a target, the STOP is
    booked. One trade at a time - a new setup cannot open while one is live.
    """
    c = dict(DEFAULTS)
    c.update(cfg or {})
    atrs = atr_list(entry, 14)
    out, busy_until = [], 0
    for i in range(60, len(entry) - 1, max(1, step)):
        if i <= busy_until:
            continue
        ev = evaluate(entry, conf, bias_bars, i, c, atr=atrs[i])
        if not ev.get("ok"):
            continue
        side, entry_px, sl, risk, tps = ev["side"], ev["entry"], ev["sl"], ev["risk"], ev["tp"]
        hit, res_r, exit_j = 0, None, None
        for j in range(i + 1, min(len(entry), i + 1 + max_hold)):
            b = entry[j]
            if (b["low"] <= sl) if side == 1 else (b["high"] >= sl):
                # conservative: the stop wins the tie - but the targets this trade had
                # ALREADY reached stay on the record. Zeroing `hit` here is what made a
                # trade that tagged TP1 and reversed book as a full loss at every mode.
                res_r, exit_j = -1.0, j
                break
            reached = [k for k, t in enumerate(tps)
                       if (b["high"] >= t if side == 1 else b["low"] <= t)]
            if reached:
                hit = max(hit, max(reached) + 1)
                if hit >= len(tps):
                    res_r, exit_j = c["tp"][-1], j
                    break
        if exit_j is None:
            exit_j = min(len(entry) - 1, i + max_hold)
            res_r = round((entry[exit_j]["close"] - entry_px) * side / risk, 3)
        cost = (c["spread"] / risk) if risk else 0.0
        out.append({"time": int(entry[i]["time"]), "type": ev["type"], "entry": entry_px,
                    "sl": sl, "tp": tps, "risk": risk, "score": ev["score"],
                    "r_gross": res_r, "cost_r": round(cost, 3), "r": round(res_r - cost, 3),
                    "hit": hit, "bars": exit_j - i, "bias": ev.get("bias"),
                    "why": ev["why"][:3]})
        busy_until = exit_j
    return out


def _booked(t, mode):
    """R booked under mode, net of the spread already inside t["r"]."""
    if t["hit"] >= mode:
        gross = [1.0, 1.5, 2.0, 3.0][mode - 1]
        return round(gross - t["cost_r"], 3)
    return t["r"]


def stats(trades, mode=2):
    """Performance at TP mode 1..4, from this indicator's own signals only.

    A trade that reached TP1 and then reversed is not a full win at mode 2 - it books 1R
    at mode 1 and its actual ending at mode 2. Nothing is rounded in the trader's favour.
    """
    if not trades:
        return {"n": 0, "wins": 0, "losses": 0, "winrate": None, "pf": None,
                "avg_r": None, "max_win_streak": 0, "max_loss_streak": 0}
    wins = losses = 0
    gw = gl = 0.0
    tot = 0.0
    streak = bw = bl = 0
    for t in trades:
        r = _booked(t, mode)
        tot += r
        if r > 0:
            wins += 1
            gw += r
            streak = streak + 1 if streak > 0 else 1
            bw = max(bw, streak)
        else:
            losses += 1
            gl += abs(r)
            streak = streak - 1 if streak < 0 else -1
            bl = max(bl, -streak)
    n = wins + losses
    return {"n": n, "wins": wins, "losses": losses,
            "winrate": round(100.0 * wins / n, 1),
            "pf": round(gw / gl, 2) if gl else None,
            "avg_r": round(tot / n, 3),
            "max_win_streak": bw, "max_loss_streak": bl}


def managed(trades):
    """The plan as actually run: half off at TP1, stop to break-even, runner at TP4.
    Approximation stated openly - without tick data we cannot know whether the stop or
    the target printed first inside a bar, so the stop is always assumed first."""
    if not trades:
        return {"n": 0, "avg_r": None, "winrate": None}
    tot, wins = 0.0, 0
    for t in trades:
        if t["hit"] >= 1:
            r = 0.5 * 1.0 + 0.5 * ([1.0, 1.5, 2.0, 3.0][t["hit"] - 1])
        else:
            r = t["r"]
        r -= t["cost_r"] if t["hit"] < 1 else 0.0
        tot += r
        wins += 1 if r > 0 else 0
    n = len(trades)
    return {"n": n, "avg_r": round(tot / n, 3), "winrate": round(100.0 * wins / n, 1)}


def fit_score(trades, mode=2):
    bands = [("80-100", 80, 101), ("70-79", 70, 80), ("<70", 0, 70)]
    return {name: stats([t for t in trades if lo <= t["score"] < hi], mode)
            for name, lo, hi in bands}

def _summ(tr, mode=2):
    """One bucket in the same shape volume.trade_stats emits, so the edge gate and the
    stats endpoint read the new engine exactly like the old ones."""
    n = len(tr)
    if not n:
        return {"n": 0, "tp1": 0, "avg_r": None, "winrate": None, "h1_n": 0, "h2_n": 0,
                "h1_avg": None, "h2_avg": None, "stable": False}
    rs = [_booked(t, mode) for t in tr]
    h = n // 2
    a, b = rs[:h], rs[h:]
    h1 = round(sum(a) / len(a), 3) if a else None
    h2 = round(sum(b) / len(b), 3) if b else None
    return {"n": n, "tp1": sum(1 for t in tr if t["hit"] >= 1),
            "avg_r": round(sum(rs) / n, 3),
            "winrate": round(100.0 * sum(1 for r in rs if r > 0) / n, 1),
            "h1_n": len(a), "h2_n": len(b), "h1_avg": h1, "h2_avg": h2,
            "stable": bool(len(a) >= 4 and len(b) >= 4 and (h1 or 0) > 0 and (h2 or 0) > 0)}


def edge_block(trades, mode=2):
    """by_style + by_family for the gate, from this engine's own replay."""
    buys = [t for t in trades if t["type"] == "BUY"]
    sells = [t for t in trades if t["type"] == "SELL"]
    styles = {"logic sweep BUY": _summ(buys, mode),
              "logic sweep SELL": _summ(sells, mode),
              "logic sweep": _summ(trades, mode)}
    fam = _summ(trades, mode)
    fam["stable"] = bool(fam["h1_n"] >= 4 and fam["h2_n"] >= 4
                         and (fam["h1_avg"] or 0) > 0 and (fam["h2_avg"] or 0) > 0)
    return {"n": len(trades), "winrate": fam["winrate"], "avg_r": fam["avg_r"],
            "by_style": styles, "by_family": {"liquidity sweep": fam}}
