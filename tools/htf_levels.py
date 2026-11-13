"""Trade the levels that hold orders: prior day / prior week extremes.

    python3 tools/htf_levels.py

Every round so far treated any 3-bar M5 pivot as "liquidity". Most of those are noise,
so the engine fires 300+ times on 60 days and nets nothing. The only level set that has
ever measured positive in this project is the higher-timeframe value area, so the same
sweep-and-retrace entry is tested against levels with actual resting orders behind them:

    prior day high / low        (PDH / PDL)
    prior week high / low       (PWH / PWL)
    prior week value-area edges (PWVH / PWVL, 70% of the prior week's volume)

Entry styles: at the sweep close, or on the retrace back to the level within 12 bars.
Same cost model everywhere: 0.35 spread, same-bar ties to the stop, 4-hour time stop.
"""
import sys
import time

sys.path.insert(0, ".")
sys.path.insert(0, "tools")
import logic_engine as L
import logic_sweep as S

SPREAD, HOLD, TP = 0.35, 48, (1.0, 1.5, 2.0, 3.0)


def day_key(t):
    return int(t // 86400)


def week_key(t):
    # ISO weeks by epoch: 1970-01-01 was a Thursday; shift so weeks run Mon-Sun
    return int((t + 3 * 86400) // (7 * 86400))


def prior_levels(bars):
    """For each bar: the last COMPLETED day's and week's high/low (and week VA)."""
    dh, dl, wh, wl = {}, {}, {}, {}
    cur_d, cur_w = None, None
    d_hi = d_lo = w_hi = w_lo = None
    days, weeks = {}, {}
    for b in bars:
        dk, wk = day_key(b["time"]), week_key(b["time"])
        if cur_d is not None and dk != cur_d:
            dh[cur_d], dl[cur_d] = d_hi, d_lo
        if cur_w is not None and wk != cur_w:
            wh[cur_w], wl[cur_w] = w_hi, w_lo
        if dk != cur_d:
            cur_d, d_hi, d_lo = dk, b["high"], b["low"]
        else:
            d_hi, d_lo = max(d_hi, b["high"]), min(d_lo, b["low"])
        if wk != cur_w:
            cur_w, w_hi, w_lo = wk, b["high"], b["low"]
        else:
            w_hi, w_lo = max(w_hi, b["high"]), min(w_lo, b["low"])
        days.setdefault(dk, []).append(b)
    dh[cur_d], dl[cur_d] = d_hi, d_lo
    wh[cur_w], wl[cur_w] = w_hi, w_lo
    # prior-week value area from that week's own volume profile
    wva = {}
    for wk, rows in _group(bars, week_key).items():
        prof = L._rng(rows[0]) and None
        try:
            import volume as V
            rr = [{"time": r["time"], "open": r["open"], "high": r["high"], "low": r["low"],
                   "close": r["close"], "volume": r["volume"]} for r in rows]
            rr = V.split_estimate(rr)
            cl, poc, _step = V.clusters(rr, 40, 1.0)
            va = V.value_area(cl, poc)
            if va:
                wva[wk] = (va["low"], va["high"])
        except Exception:
            pass
    return dh, dl, wh, wl, wva


def _group(bars, keyfn):
    out = {}
    for b in bars:
        out.setdefault(keyfn(b["time"]), []).append(b)
    return out


def levels_at(b, dh, dl, wh, wl, wva):
    out = []
    dk, wk = day_key(b["time"]), week_key(b["time"])
    if dk - 1 in dh:
        out += [("PDH", dh[dk - 1]), ("PDL", dl[dk - 1])]
    if wk - 1 in wh:
        out += [("PWH", wh[wk - 1]), ("PWL", wl[wk - 1])]
        if wk - 1 in wva:
            out += [("PWVH", wva[wk - 1][1]), ("PWVL", wva[wk - 1][0])]
    return out


def replay(bars, bias_bars, use=("PDH", "PDL", "PWH", "PWL"), retrace=True,
           need_bias=False, stop_mode="extreme", tol=0.3, wait=12):
    atr = L.atr_list(bars, 14)
    dh, dl, wh, wl, wva = prior_levels(bars)
    closed_bias, bp, bias_at = [], 0, [0] * len(bars)
    for i, b in enumerate(bars):
        while bp < len(bias_bars) and bias_bars[bp]["time"] + 3600 <= b["time"] + 300:
            closed_bias.append(bias_bars[bp])
            bp += 1
        if len(closed_bias) >= 10:
            bias_at[i] = L.bias_detail(closed_bias[-120:], 3)["dir"]
    trades, busy = [], 0
    i = 60
    while i < len(bars) - 2:
        if i <= busy or not atr[i]:
            i += 1
            continue
        b = bars[i]
        lv = [(n, v) for n, v in levels_at(b, dh, dl, wh, wl, wva) if n in use]
        hit = None
        for name, price in lv:
            long_side = name.endswith("L")
            side = 1 if long_side else -1
            if not L.sweep_at(bars, i, price, side, atr[i], 0.05):
                continue
            if need_bias and bias_at[i] not in (side, 0):
                continue
            hit = (side, price, name, b["low"] if side == 1 else b["high"])
            break
        if not hit:
            i += 1
            continue
        side, price, name, extreme = hit
        if retrace:
            entry_j, ent = None, None
            for j in range(i + 1, min(len(bars), i + 1 + wait)):
                bb = bars[j]
                near = abs((bb["low"] if side == 1 else bb["high"]) - price) <= tol * atr[i]
                ok = (bb["close"] > bb["open"]) if side == 1 else (bb["close"] < bb["open"])
                if near and ok:
                    entry_j, ent = j, bb["close"]
                    break
            if entry_j is None:
                i += 1
                continue
        else:
            entry_j, ent = i, b["close"]
        stop = (extreme - side * 0.15 * atr[i]) if stop_mode == "extreme" else \
               (price - side * 1.0 * atr[i])
        risk = abs(ent - stop)
        if risk <= 0.15 * atr[i]:
            i += 1
            continue
        tps = [ent + side * rr * risk for rr in TP]
        h, res, exit_j = 0, None, None
        for j in range(entry_j + 1, min(len(bars), entry_j + 1 + HOLD)):
            bb = bars[j]
            if (bb["low"] <= stop) if side == 1 else (bb["high"] >= stop):
                res, exit_j = -1.0, j           # hit count is preserved
                break
            reached = [k for k, t in enumerate(tps)
                       if (bb["high"] >= t if side == 1 else bb["low"] <= t)]
            if reached:
                h = max(h, max(reached) + 1)
                if h >= len(tps):
                    res, exit_j = TP[-1], j
                    break
        if exit_j is None:
            exit_j = min(len(bars) - 1, entry_j + HOLD)
            res = (bars[exit_j]["close"] - ent) * side / risk
        trades.append({"time": bars[entry_j]["time"], "side": side, "name": name,
                       "entry": ent, "risk": risk, "hit": h, "res": res,
                       "cost_r": SPREAD / risk})
        busy = exit_j
        i += 1
    return trades


def report(tag, tr, mode=1):
    n = len(tr)
    if not n:
        print("  %-46s no trades" % tag)
        return
    rs = [(TP[mode - 1] if t["hit"] >= mode else t["res"]) - t["cost_r"] for t in tr]
    h = n // 2
    a, b = rs[:h], rs[h:]
    wr = 100.0 * sum(1 for x in rs if x > 0) / n
    med = sorted(t["risk"] for t in tr)[n // 2]
    print("  %-46s n=%-3s win%%=%-5s avgR=%-7s halves %+.3f / %+.3f  stop $%.1f"
          % (tag, n, round(wr, 1), round(sum(rs) / n, 3), sum(a) / len(a), sum(b) / len(b), med))


def main():
    t0 = time.time()
    bars = sorted(S.yahoo("GC=F", "5m", "60d"), key=lambda b: b["time"])
    bias = S.agg(bars, 3600)
    print("M5 bars %d  %s -> %s\n" % (len(bars),
          time.strftime("%m-%d", time.gmtime(bars[0]["time"])),
          time.strftime("%m-%d", time.gmtime(bars[-1]["time"]))))
    sets = {
        "prior day H/L": ("PDH", "PDL"),
        "prior week H/L": ("PWH", "PWL"),
        "prior week VA edges": ("PWVH", "PWVL"),
        "day + week": ("PDH", "PDL", "PWH", "PWL"),
    }
    for tag, use in sets.items():
        for retrace in (True, False):
            for bias_on in (False, True):
                tr = replay(bars, bias, use=use, retrace=retrace, need_bias=bias_on)
                report("%s · %s%s" % (tag, "retrace" if retrace else "at sweep",
                                      " · H1 agrees" if bias_on else ""), tr, 1)
    print("\nsecond target and the far target (day + week, retrace, H1 agrees):")
    tr = replay(bars, bias, use=("PDH", "PDL", "PWH", "PWL"), retrace=True, need_bias=True)
    for m in (1, 2, 4):
        report("booked at TP%d" % m, tr, m)
    by = {}
    for t in tr:
        by.setdefault(t["name"], []).append(t)
    print("\nby level:")
    for k, v in sorted(by.items()):
        report("  " + k, v, 1)
    print("\ntotal %.0fs" % (time.time() - t0))


if __name__ == "__main__":
    main()
