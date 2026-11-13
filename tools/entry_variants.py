"""Does the M1/M5 entry have a prayer? Entry styles, one cost model, one dataset.

    python3 tools/entry_variants.py

The first version of this script was WRONG: when a trade later hit its stop it reset the
target-hit count to zero, so a trade that tagged TP1 and then reversed was booked as a
full -1R at every mode. That made even a random entry look like a 30% winner at 1R, which
is impossible in a fair race. The count is now preserved: mode k books the k-th target if
it was ever reached, otherwise the trade's real ending.

Variants, all on the same M5 bars, 0.35 spread charged, same-bar ties go to the stop:
  A  retrace into FVG, stop at the sweep extreme        (what shipped)
  B  enter at the sweep bar's close, stop at the extreme
  C  enter at the sweep bar's close, stop 1.0 ATR beyond the swept level
  D  enter at the BOS close, stop beyond the last swing
  E  random entry, 1.5 ATR stop                          (the control)
"""
import random
import sys
import time

sys.path.insert(0, ".")
sys.path.insert(0, "tools")
import logic_engine as L
import logic_sweep as S

SPREAD = 0.35
HOLD = 48           # 48 x M5 = 4 hours
TP = (1.0, 1.5, 2.0, 3.0)
PIV = 3
EQ = 0.25


def _booked(hit, res, mode):
    if hit >= mode:
        return TP[mode - 1]
    return res


def _manage(tr, bar):
    """Advance one open trade by one bar. Returns True when it closed."""
    side, stop = tr["side"], tr["stop"]
    if (bar["low"] <= stop) if side == 1 else (bar["high"] >= stop):
        tr["res"], tr["hit"], tr["closed"] = -1.0, tr["hit"], True   # stop, but keep the hit
        return True
    reached = [k for k, t in enumerate(tr["tp"])
               if (bar["high"] >= t if side == 1 else bar["low"] <= t)]
    if reached:
        tr["hit"] = max(tr["hit"], max(reached) + 1)
        if tr["hit"] >= len(tr["tp"]):
            tr["res"], tr["closed"] = TP[-1], True
            return True
    return False


def run(bars, bias_bars, label_rng):
    atr = L.atr_list(bars, 14)
    n = len(bars)
    phi, plo = [], []                 # confirmed pivots (j, v)
    lhi, llo = [], []                 # levels {price, taps, last}
    bias_at = [0] * n
    bp = 0
    closed_bias = []
    open_tr = {k: None for k in "ABCDE"}
    done = {k: [] for k in "ABCDE"}
    busy = {k: 0 for k in "ABCDE"}
    for i in range(n):
        b = bars[i]
        # ---- bias in force at this bar (only closed bias bars) --------------------
        while bp < len(bias_bars) and bias_bars[bp]["time"] + 3600 <= b["time"] + 300:
            closed_bias.append(bias_bars[bp])
            bp += 1
        if len(closed_bias) >= 10:
            bias_at[i] = L.bias_detail(closed_bias[-120:], PIV)["dir"]
        # ---- a new pivot becomes usable exactly PIV bars after it printed ---------
        j = i - PIV
        if j >= PIV and atr[i]:
            w = range(j - PIV, j + PIV + 1)
            hi, lo = b_hi = bars[j]["high"], bars[j]["low"]
            if all(bars[k]["high"] <= hi for k in w if k != j):
                _add(lhi, hi, atr[i], j)
            if all(bars[k]["low"] >= lo for k in w if k != j):
                _add(llo, lo, atr[i], j)
        # ---- manage open trades ---------------------------------------------------
        for k, tr in list(open_tr.items()):
            if tr is not None:
                if _manage(tr, b) or (i - tr["i"]) >= HOLD:
                    if not tr["closed"]:
                        tr["res"] = (b["close"] - tr["entry"]) * tr["side"] / tr["risk"]
                        tr["closed"] = True
                    done[k].append(tr)
                    open_tr[k] = None
        # ---- entries ---------------------------------------------------------------
        if atr[i] and i >= 80 and len(lhi) and len(llo):
            cand = {}
            cand["B"] = _sweep_entry(bars, i, atr[i], bias_at[i], lhi, llo, tight=False)
            cand["C"] = _sweep_entry(bars, i, atr[i], bias_at[i], lhi, llo, tight=True)
            cand["D"] = _bos_entry(bars, i, atr[i], bias_at[i], lhi, llo)
            cand["A"] = _fvg_entry(bars, i, atr[i], bias_at[i], lhi, llo)
            rnd = random.Random(7000 + i)
            _es = rnd.choice((1, -1))
            cand["E"] = (_es, b["close"], b["close"] - _es * 1.5 * atr[i])
            for k, got in cand.items():
                if got is None or open_tr[k] is not None or i <= busy[k]:
                    continue
                side, ent, stop = got
                risk = abs(ent - stop)
                if risk <= 0.1 * atr[i]:
                    continue
                open_tr[k] = {"side": side, "entry": ent, "stop": stop, "risk": risk,
                              "tp": [ent + side * rr * risk for rr in TP],
                              "hit": 0, "res": None, "closed": False, "i": i,
                              "time": int(b["time"])}
                busy[k] = i
    out = {}
    for k, trs in done.items():
        rows = []
        for t in trs:
            rows.append({"time": t["time"], "type": "BUY" if t["side"] == 1 else "SELL",
                         "entry": t["entry"], "sl": t["stop"], "tp": t["tp"],
                         "risk": t["risk"], "score": 90, "hit": t["hit"],
                         "r": round(_booked(t["hit"], t["res"], 1) - SPREAD / t["risk"], 3),
                         "cost_r": round(SPREAD / t["risk"], 3),
                         "res": t["res"], "bars": 0})
        out[k] = rows
    return out


def _add(levels, v, atr, j):
    if levels and abs(v - levels[-1]["price"]) <= EQ * atr:
        levels[-1]["price"] = (levels[-1]["price"] + v) / 2.0
        levels[-1]["taps"] += 1
        levels[-1]["last"] = j
    else:
        levels.append({"price": v, "taps": 1, "last": j})
        if len(levels) > 40:
            levels.pop(0)


def _sweep_entry(bars, i, atr, bias, lhi, llo, tight):
    b = bars[i]
    for side in (1, -1):
        lvls = llo if side == 1 else lhi
        ref = b["low"] if side == 1 else b["high"]
        lv = min(lvls, key=lambda L_: abs(L_["price"] - ref))
        if lv["last"] >= i or lv["taps"] < 2:
            continue
        if not L.sweep_at(bars, i, lv["price"], side, atr):
            continue
        if bias not in (side, 0):
            continue
        extreme = b["low"] if side == 1 else b["high"]
        stop = lv["price"] - side * 1.0 * atr if tight else extreme - side * 0.15 * atr
        if (b["close"] - stop) * side <= 0.15 * atr:
            continue
        return side, b["close"], stop
    return None


def _bos_entry(bars, i, atr, bias, lhi, llo):
    b = bars[i]
    for side in (1, -1):
        lvls = lhi if side == 1 else llo
        if not lvls:
            continue
        j, v = lvls[-1]["last"], lvls[-1]["price"]
        if j + PIV > i:
            continue
        if not (b["close"] > v if side == 1 else b["close"] < v):
            continue
        if bias not in (side, 0):
            continue
        opp = llo if side == 1 else lhi
        if not opp:
            continue
        stop = opp[-1]["price"] - side * 0.15 * atr
        if (b["close"] - stop) * side <= 0.2 * atr or abs(b["close"] - stop) > 2.5 * atr:
            continue
        return side, b["close"], stop
    return None


def _fvg_entry(bars, i, atr, bias, lhi, llo):
    b = bars[i]
    for side in (1, -1):
        lvls = llo if side == 1 else lhi
        if not lvls:
            continue
        ref = b["low"] if side == 1 else b["high"]
        lv = min(lvls, key=lambda L_: abs(L_["price"] - ref))
        if lv["last"] >= i or not L.sweep_at(bars, i - 1, lv["price"], side, atr):
            continue
        if bias not in (side, 0):
            continue
        g = L.fvg_at(bars, i, side)
        if not g:
            continue
        top, bot = g
        in_zone = (b["low"] <= top and b["close"] >= bot) if side == 1 else \
                  (b["high"] >= bot and b["close"] <= top)
        if not in_zone:
            continue
        ext = min(bars[i - 3]["low"], b["low"]) if side == 1 else max(bars[i - 3]["high"], b["high"])
        return side, b["close"], ext - side * 0.15 * atr
    return None


def show(tag, rows):
    n = len(rows)
    print("\n%s" % tag)
    if not n:
        print("   no trades")
        return
    for mode in (1, 2, 4):
        rs = [_booked(r["hit"], r["res"], mode) - r["cost_r"] for r in rows]
        h = n // 2
        a, b = rs[:h], rs[h:]
        wr = 100.0 * sum(1 for x in rs if x > 0) / n
        print("   TP%d  n=%-4s win%%=%-5s avgR=%-7s halves %+.3f / %+.3f"
              % (mode, n, round(wr, 1), round(sum(rs) / n, 3),
                 sum(a) / len(a), sum(b) / len(b)))
    print("   median stop $%.2f" % sorted(r["risk"] for r in rows)[n // 2])


def main():
    t0 = time.time()
    raw = sorted(S.yahoo("GC=F", "5m", "60d"), key=lambda b: b["time"])
    bias = S.agg(raw, 3600)
    print("bars %d  %s -> %s" % (len(raw),
                                 time.strftime("%m-%d", time.gmtime(raw[0]["time"])),
                                 time.strftime("%m-%d", time.gmtime(raw[-1]["time"]))))
    out = run(raw, bias, "60d")
    for k, name in (("A", "A  retrace into FVG, stop at the sweep  (what shipped)"),
                    ("B", "B  enter at the sweep close, stop at the extreme"),
                    ("C", "C  enter at the sweep close, stop 1 ATR beyond the level"),
                    ("D", "D  enter at the BOS close, stop beyond the last swing"),
                    ("E", "E  random entry, 1.5 ATR stop  (control)")):
        show(name, out[k])
    print("\ntotal %.0fs" % (time.time() - t0))


if __name__ == "__main__":
    main()
