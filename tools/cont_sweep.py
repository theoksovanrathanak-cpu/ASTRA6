"""Does 'break liquidity and hold' pay? Sweep it on months of real bars.

Entries tested are CONTINUATION: a close beyond the value edge (or a pooled liquidity
level) by k ATR, never a close back through it, then a touch of the level that holds.
The opposite of the fade the app used to trade.

Every variant is scored the same way: spread charged, position split 50/50 at TP1/TP2,
stop to entry after TP1, and the window cut into thirds (train / validation / test) so a
parameter can be judged on data it never picked.
"""
import json, os, statistics as st, sys, urllib.request
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import volume as V

SEC = {"M15": 900, "H1": 3600}


def _get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "ASTRA6-sweep"})
    return json.load(urllib.request.urlopen(req, timeout=timeout))


def load(tf, src="yahoo"):
    iv, rng = {"M15": ("15m", "60d"), "H1": ("60m", "730d")}[tf]
    sym = "GC=F" if src == "yahoo" else "DX-Y.NYB"
    d = _get(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval={iv}&range={rng}")
    res = d["chart"]["result"][0]
    ts, q = res["timestamp"], res["indicators"]["quote"][0]
    rows = []
    for i, t in enumerate(ts):
        if None in (q["open"][i], q["high"][i], q["low"][i], q["close"][i]):
            continue
        rows.append({"time": int(t), "open": q["open"][i], "high": q["high"][i],
                     "low": q["low"][i], "close": q["close"][i],
                     "volume": float(q["volume"][i] or 0)})
    return V.split_estimate(rows)


def pools(candles, atr, look=60, k=3, tol=0.15):
    w = candles[-look:]
    base = len(candles) - len(w)
    hi, lo = [], []
    for i in range(k, len(w) - k):
        h, l = w[i]["high"], w[i]["low"]
        if all(w[j]["high"] <= h for j in range(i - k, i + k + 1) if j != i):
            hi.append((base + i, h))
        if all(w[j]["low"] >= l for j in range(i - k, i + k + 1) if j != i):
            lo.append((base + i, l))
    def gp(pts):
        out = []
        for idx, p in pts:
            for g in out:
                if abs(g[0] - p) <= tol * atr:
                    g[1] += 1
                    break
            else:
                out.append([p, 1])
        return [(p, n) for p, n in out]
    return gp(hi), gp(lo)


def dxy_trend(tf, times, n=20):
    """Gold's macro tailwind, as a dollar trend: gold up when the dollar rolls over.

    A proxy for the fundamentals filter, and labelled as one. Real headlines cannot be
    replayed without an archive, but the dollar is the single biggest driver the news
    rules are scoring, and its history is free.
    """
    try:
        d = load(tf, src="dxy")
    except Exception as e:
        print("dxy load failed:", e)
        return {}
    closes = [(r["time"], r["close"]) for r in d]
    out, k, s_vals = {}, 0, []
    for t in times:
        while k < len(closes) and closes[k][0] <= t:
            s_vals.append(closes[k][1])
            k += 1
        if len(s_vals) < n:
            out[t] = 0
            continue
        sma = sum(s_vals[-n:]) / n
        out[t] = -1 if s_vals[-1] > sma else (1 if s_vals[-1] < sma else 0)
    return out


def features(cs, tf, step=1):
    """One row per bar: value area, ATR, higher-timeframe read, liquidity pools."""
    tfm = 15 if tf == "M15" else 60
    out = []
    for i in range(200, len(cs) - 60, step):
        win = cs[max(0, i - 149):i + 1]
        cl, poc, _ = V.clusters(V.profile_window(win, tfm), 48, 10.0)
        va = V.value_area(cl, poc)
        a = V._atr_of(win)
        hs, ls = pools(win, a)
        out.append({"i": i, "va": va, "atr": a, "htf": V.htf_structure(win, tfm),
                    "hs": hs, "ls": ls})
    return out


def state(f, cs, accept, look=8):
    """For each side: the level that was broken, how long ago, and the stop it implies."""
    i, va, a = f["i"], f["va"], f["atr"]
    if not va or not a:
        return {}
    out = {}
    for side, edge, plt in ((1, va.get("high"), f["hs"]), (-1, va.get("low"), f["ls"])):
        best = None
        cands = [(edge, "value edge")]
        for p, n in plt:
            if n >= 2 and ((side == 1 and p > edge) or (side == -1 and p < edge)):
                cands.append((p, "pooled %s" % ("highs" if side == 1 else "lows")))
        for lvl, name in cands:
            if lvl is None:
                continue
            bidx = None
            for j in range(max(0, i - look), i):
                c = cs[j]
                if (side == 1 and c["close"] >= lvl + accept * a) or \
                   (side == -1 and c["close"] <= lvl - accept * a):
                    bidx = j
            if bidx is None:
                continue
            if any((side == 1 and c["close"] < lvl) or (side == -1 and c["close"] > lvl)
                   for c in cs[bidx:i]):
                continue
            cur = cs[i]
            touch = (side == 1 and cur["low"] <= lvl + 0.25 * a) or \
                    (side == -1 and cur["high"] >= lvl - 0.25 * a)
            beyond = (side == 1 and cur["close"] > lvl) or (side == -1 and cur["close"] < lvl)
            if not (touch and beyond):
                continue
            stop = min(c["low"] for c in cs[bidx:i + 1]) - 0.1 * a if side == 1 else \
                   max(c["high"] for c in cs[bidx:i + 1]) + 0.1 * a
            cand = {"side": side, "lvl": lvl, "name": name, "stop": stop, "bidx": bidx}
            if best is None or abs(cur["close"] - stop) < abs(cur["close"] - best["stop"]):
                best = cand
        if best:
            out[side] = best
    return out


def follow(cs, t, side, entry, stop, r1, r2, fwd=40, be=True):
    risk = abs(entry - stop)
    if risk <= 0:
        return None
    got, hit1, stop = 0.0, False, stop
    for c in cs[t + 1:t + 1 + fwd]:
        hi, lo = c["high"], c["low"]
        if (side == 1 and lo <= stop) or (side == -1 and hi >= stop):
            got += (0.5 if hit1 else 1.0) * ((stop - entry) * side / risk)
            return got
        if not hit1 and ((side == 1 and hi >= entry + r1 * risk) or (side == -1 and lo <= entry - r1 * risk)):
            hit1 = True
            got += 0.5 * r1
            if be:
                stop = entry
        if hit1 and ((side == 1 and hi >= entry + r2 * risk) or (side == -1 and lo <= entry - r2 * risk)):
            return got + 0.5 * r2
    last = cs[min(len(cs) - 1, t + fwd)]
    return got + (0.5 if hit1 else 1.0) * ((last["close"] - entry) * side / risk)


def run(tf, spread=0.35, accept=0.15, r1=1.5, r2=3.0, fwd=40, filters=("none",)):
    cs = load(tf)
    feats = features(cs, tf)
    macro = dxy_trend(tf, [c["time"] for c in cs]) if "dxy" in filters else {}
    res = {f: [] for f in filters}
    for f in feats:
        i = f["i"]
        st_ = state(f, cs, accept)
        for side, s in st_.items():
            e = cs[i]["close"]
            risk = abs(e - s["stop"])
            if risk < 0.5 * f["atr"] or risk > 3.0 * f["atr"]:
                continue
            r = follow(cs, i, side, e, s["stop"], r1, r2, fwd)
            if r is None:
                continue
            r -= spread / risk
            for k in filters:
                if k == "htf" and f["htf"] != 0 and f["htf"] != side:
                    continue
                if k == "dxy":
                    md = macro.get(cs[i]["time"], 0)
                    if md != 0 and md != side:
                        continue
                res[k].append(r)
    return res


def show(tag, res):
    for k, v in res.items():
        if not v:
            print("     %-6s no trades" % k); continue
        n = len(v); th = n // 3
        a = sum(v[:th]) / max(1, th)
        b = sum(v[th:2 * th]) / max(1, th)
        c = sum(v[2 * th:]) / max(1, n - 2 * th)
        print("     %-6s n=%4d  all %+7.3fR   train %+7.3f  val %+7.3f  test %+7.3f"
              % (k, n, sum(v) / n, a, b, c))


if __name__ == "__main__":
    for tf in ("M15", "H1"):
        for accept in (0.10, 0.25):
            for (r1, r2) in ((1.5, 3.0),):
                print("%-4s accept=%.2f tp=%.1f/%.1f" % (tf, accept, r1, r2))
                show(tf, run(tf, accept=accept, r1=r1, r2=r2, filters=("none", "htf", "dxy")))
