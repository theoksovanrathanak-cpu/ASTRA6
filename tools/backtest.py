"""Replay the cluster read on real bars and score it. No synthetic data, ever.

Usage:  python3 tools/backtest.py [--tf M5] [--src xaus|yahoo]

Every number comes from a feed's own OHLC. The point of the tool is to answer three
questions with evidence instead of opinion:
  1. does the setup hold water, and for how long?
  2. how far does a WINNING trade go against you before it wins (that is what the stop
     has to survive - a stop tighter than the winners' excursion is a stop that harvests
     noise);
  3. does entering later / at the level / with the higher timeframe beat entering now?
"""
import argparse, json, statistics as st, sys, time, urllib.request, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import volume as V

TFM = {"M1": 1, "M5": 5, "M15": 15, "H1": 60}
SEC = {"M1": 60, "M5": 300, "M15": 900, "H1": 3600}


def _get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "ASTRA6-backtest"})
    return json.load(urllib.request.urlopen(req, timeout=timeout))


def load(src, tf):
    rows = []
    if src == "xaus":
        rng, iv = {"M1": ("1d", "1m"), "M5": ("5d", "5m"), "M15": ("5d", "15m"), "H1": ("1mo", "1h")}[tf]
        d = _get(f"https://xaus.com/api/v1/chart?symbol=xau&range={rng}&interval={iv}")
        rows = [{"time": int(p["t"]), "open": p["o"], "high": p["h"], "low": p["l"],
                 "close": p["c"], "volume": float(p.get("v") or 0)} for p in d.get("points") or []]
    else:
        iv, rng = {"M1": ("1m", "5d"), "M5": ("5m", "1mo"), "M15": ("15m", "1mo"), "H1": ("60m", "3mo")}[tf]
        d = _get(f"https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval={iv}&range={rng}")
        res = d["chart"]["result"][0]
        ts = res["timestamp"]; q = res["indicators"]["quote"][0]
        for i, t in enumerate(ts):
            if None in (q["open"][i], q["high"][i], q["low"][i], q["close"][i]):
                continue
            rows.append({"time": int(t), "open": q["open"][i], "high": q["high"][i],
                         "low": q["low"][i], "close": q["close"][i],
                         "volume": float(q["volume"][i] or 0)})
    return V.split_estimate(rows)


def signals(cs, tf, step=1):
    """The read as it stood at every bar, using only the bars that existed then."""
    out, W = [], 150
    prof = []
    for i in range(200, len(cs) - 30, step):
        win = cs[max(0, i - W + 1):i + 1]
        vwap, _ = V.daily_vwap(win)
        cl, poc, _s = V.clusters(V.profile_window(win, TFM[tf]), 48, 10.0)
        a = V._atr_of(win); va = V.value_area(cl, poc)
        sg = V.signal(win, vwap, cl, poc, a, 10.0, V.vwap_series(win), va=va)
        out.append({"i": i, "sg": sg, "atr": a, "va": va, "poc": poc})
    return out


def _run(cs, t, side, entry, sl, tp1, tp2, fwd, mgmt=None):
    """Walk the bars after `t`. mgmt: 'partial' = 50% at tp1, stop to break-even."""
    risk = abs(entry - sl)
    if risk <= 0:
        return None
    left = 1.0
    booked = 0.0
    mae = 0.0
    sl_now = sl
    for c in cs[t:t + fwd]:
        adverse = (entry - c["low"]) / risk if side == 1 else (c["high"] - entry) / risk
        mae = max(mae, adverse)
        hit_sl = c["low"] <= sl_now if side == 1 else c["high"] >= sl_now
        # a bar can touch both: assume the stop is reached first — the conservative read
        if hit_sl:
            booked += left * ((sl_now - entry) * side) / risk
            return {"r": booked, "why": "sl", "mae": mae}
        hit1 = c["high"] >= tp1 if side == 1 else c["low"] <= tp1
        if hit1:
            if mgmt == "partial":
                booked += 0.5 * ((tp1 - entry) * side) / risk
                left = 0.5
                sl_now = entry                      # break-even on what is left
                tp1 = tp2 if side == 1 else tp2     # and let the rest run to TP2
            else:
                booked += left * ((tp1 - entry) * side) / risk
                return {"r": booked, "why": "tp1", "mae": mae}
        hit2 = c["high"] >= tp2 if side == 1 else c["low"] <= tp2
        if hit2:
            booked += left * ((tp2 - entry) * side) / risk
            return {"r": booked, "why": "tp2", "mae": mae}
    return {"r": booked + left * ((cs[min(t + fwd, len(cs) - 1)]["close"] - entry) * side) / risk,
            "why": "open", "mae": mae}


def score(rows):
    if not rows:
        return {"n": 0}
    r = [x["r"] for x in rows]
    why = [x["why"] for x in rows]
    mae = [x["mae"] for x in rows]
    wins = [x["mae"] for x in rows if x["r"] > 0]
    loss = [x["mae"] for x in rows if x["r"] <= 0]
    q = lambda v, p: (sorted(v)[min(len(v) - 1, int(len(v) * p))] if v else None)
    return {"n": len(rows), "exp": round(st.mean(r), 3), "win": round(100 * sum(1 for x in r if x > 0) / len(r)),
            "tp1": why.count("tp1"), "tp2": why.count("tp2"), "sl": why.count("sl"), "open": why.count("open"),
            "mae_all": round(st.median(mae), 2),
            "mae_win_p90": round(q(wins, 0.90), 2) if wins else None,
            "mae_loss_p50": round(st.median(loss), 2) if loss else None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tf", default="M5")
    ap.add_argument("--src", default="xaus")
    a = ap.parse_args()
    cs = load(a.src, a.tf)
    print(f"{a.src} {a.tf}: {len(cs)} real bars "
          f"{time.strftime('%m-%d %H:%M', time.gmtime(cs[0]['time']))} -> "
          f"{time.strftime('%m-%d %H:%M', time.gmtime(cs[-1]['time']))}")
    sigs = signals(cs, a.tf)
    live = [s for s in sigs if s["sg"].get("type") in ("BUY", "SELL")]
    print(f"  {len(live)} signals printed by the current rules out of {len(sigs)} reads")
    out = {}

    def add(name, rows):
        out[name] = score(rows)
        s = out[name]
        if not s["n"]:
            print(f"  {name:38s} none"); return
        print(f"  {name:38s} n={s['n']:3d} exp {s['exp']:+.3f}R  win {s['win']:3d}%  "
              f"tp1 {s['tp1']:3d} tp2 {s['tp2']:3d} sl {s['sl']:3d} open {s['open']:3d}  "
              f"| MAE all {s['mae_all']:.2f}  winners p90 {s['mae_win_p90']}")

    base = []
    for s in live:
        sg = s["sg"]; side = 1 if sg["type"] == "BUY" else -1
        r = _run(cs, s["i"] + 1, side, sg["entry"], sg["sl"], sg["tp1"], sg["tp2"], 30)
        if r: base.append(r)
    add("A as shipped (market, tp1 0.85R)", base)

    # what does the same setup do if it is simply given more room and a closer target?
    for stop_m, tp_r in ((1.0, 0.6), (1.3, 0.85), (1.5, 1.0), (2.0, 1.5)):
        rows = []
        for s in live:
            sg = s["sg"]; side = 1 if sg["type"] == "BUY" else -1
            risk = sg["risk"] * stop_m
            ent = sg["entry"]
            r = _run(cs, s["i"] + 1, side, ent, ent - side * risk, ent + side * risk * tp_r,
                     ent + side * risk * tp_r * 2, 30)
            if r: rows.append(r)
        add(f"B stop x{stop_m}, tp1 {tp_r}R", rows)

    # trigger entry: only once the next bar CLOSES past the signal bar's extreme
    rows = []
    for s in live:
        sg = s["sg"]; side = 1 if sg["type"] == "BUY" else -1
        bar = cs[s["i"]]
        for j in range(s["i"] + 1, min(s["i"] + 4, len(cs))):
            c = cs[j]
            trig = c["close"] > bar["high"] if side == 1 else c["close"] < bar["low"]
            if trig:
                ent = c["close"]
                risk = max(abs(ent - sg["sl"]), 0.5 * s["atr"])
                r = _run(cs, j + 1, side, ent, ent - side * risk, ent + side * risk * 0.85,
                         ent + side * risk * 1.9, 30)
                if r: rows.append(r)
                break
    add("C trigger: next bar closes past it", rows)

    # retrace entry at the level itself, only if price comes back within 5 bars
    rows = []
    for s in live:
        sg = s["sg"]; side = 1 if sg["type"] == "BUY" else -1
        va = s["va"] or {}
        lvl = va.get("low") if side == 1 else va.get("high")
        if not lvl: continue
        for j in range(s["i"] + 1, min(s["i"] + 6, len(cs))):
            c = cs[j]
            got = c["low"] <= lvl if side == 1 else c["high"] >= lvl
            if got:
                risk = max(abs(lvl - sg["sl"]) + 0.25 * s["atr"], 0.5 * s["atr"])
                r = _run(cs, j + 1, side, lvl, lvl - side * risk, lvl + side * risk * 0.85,
                         lvl + side * risk * 1.9, 30)
                if r: rows.append(r)
                break
    add("D retrace entry at the level", rows)

    # higher-timeframe agreement: only take a trade pointing the same way as the last
    # six bars on the timeframe above (structure, not opinion)
    def htf_ok(tf):
        return {"M1": "M5", "M5": "M15", "M15": "H1"}.get(tf)

    step = {"M1": 5, "M5": 3, "M15": 4}.get(a.tf, 4)
    rows = []
    for s in live:
        sg = s["sg"]; side = 1 if sg["type"] == "BUY" else -1
        i = s["i"]
        # the timeframe above, aligned by time: the last closed bar of that series
        sec = SEC[a.tf] * step
        hk = (cs[i]["time"] // sec) * sec
        idx = None
        for k in range(i, max(0, i - 400), -1):
            if (cs[k]["time"] // sec) * sec <= hk:
                idx = k
                break
        if idx is None or idx < 10: continue
        sub = cs[max(0, idx - sec // SEC[a.tf] * 0 + 1 - 40):idx + 1]
        move = sub[-1]["close"] - sub[0]["close"] if len(sub) > 2 else 0
        if (side == 1 and move <= 0) or (side == -1 and move >= 0):
            continue
        r = _run(cs, i + 1, side, sg["entry"], sg["sl"], sg["tp1"], sg["tp2"], 30)
        if r: rows.append(r)
    add(f"E + trend of the timeframe above", rows)

    # partial at TP1 then the rest to TP2 with the stop at break-even
    rows = []
    for s in live:
        sg = s["sg"]; side = 1 if sg["type"] == "BUY" else -1
        r = _run(cs, s["i"] + 1, side, sg["entry"], sg["sl"], sg["tp1"], sg["tp2"], 40, mgmt="partial")
        if r: rows.append(r)
    add("F 50% at TP1, stop to break-even", rows)

    json.dump(out, open(f"/tmp/bt_{a.src}_{a.tf}.json", "w"), indent=1)


if __name__ == "__main__":
    main()
