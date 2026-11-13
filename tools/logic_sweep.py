"""Measure the LOGIC ENGINE on real bars, from more than one vendor.

    python3 tools/logic_sweep.py yahoo 1m         # GC=F M1 entry, M5 confirm, H1 bias, 7 sessions
    python3 tools/logic_sweep.py yahoo 5m         # same rules one speed up, 60 days
    python3 tools/logic_sweep.py xaus 1m          # spot XAU from the site's own feed

Prints: trades, win rate, avg R net of the 0.35 spread, halves, score bands, and a
random-entry control with identical exits. If the engine cannot beat its own control,
the structure is decoration and it does not go into the site.
"""
import json, random, sys, time, urllib.request

sys.path.insert(0, ".")
import logic_engine as L

UA = {"User-Agent": "Mozilla/5.0 (ASTRA6 research)"}
SPREAD = 0.35          # XAUUSD round trip, in dollars - charged on every trade


def _get(url, tries=3):
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            last = e
            time.sleep(2)
    raise last


def _bars_from_yahoo(url):
    d = _get(url)
    res = d["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    out = []
    for i, t in enumerate(res["timestamp"]):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if None in (o, h, l, c):
            continue
        out.append({"time": int(t), "open": float(o), "high": float(h),
                    "low": float(l), "close": float(c), "volume": float(q["volume"][i] or 0)})
    return out


def yahoo(symbol="GC=F", interval="1m", rng="7d"):
    return _bars_from_yahoo("https://query1.finance.yahoo.com/v8/finance/chart/%s"
                            "?interval=%s&range=%s" % (symbol.replace("=", "%3D"), interval, rng))


def xaus(interval="1m", rng="5d"):
    d = _get("https://xaus.com/api/v1/chart?symbol=xau&range=%s&interval=%s" % (rng, interval))
    pts = d.get("points") or []
    return [{"time": int(p["t"]), "open": float(p["o"]), "high": float(p["h"]),
             "low": float(p["l"]), "close": float(p["c"]), "volume": float(p.get("v") or 0)}
            for p in pts]


def agg(bars, secs):
    out, cur, key = [], None, None
    for b in bars:
        k = int(b["time"]) // secs
        if k != key:
            if cur:
                out.append(cur)
            key = k
            cur = {"time": k * secs, "open": b["open"], "high": b["high"],
                   "low": b["low"], "close": b["close"], "volume": b["volume"]}
        else:
            cur["high"] = max(cur["high"], b["high"])
            cur["low"] = min(cur["low"], b["low"])
            cur["close"] = b["close"]
            cur["volume"] += b["volume"]
    if cur:
        out.append(cur)
    return out


def random_control(entry, cfg, n, seed=7):
    """Same exits, same one-at-a-time rule, random entries - the bar the model must clear."""
    rnd = random.Random(seed)
    atrs = L.atr_list(entry, 14)
    tps = cfg["tp"]
    out, busy = [], 0
    for _ in range(n * 30):
        i = rnd.randrange(60, len(entry) - 2)
        if i <= busy or not atrs[i]:
            continue
        side = rnd.choice((1, -1))
        a = atrs[i]
        e = entry[i]["close"]
        risk = a * rnd.uniform(0.8, 2.0)
        sl = e - side * risk
        tp = [round(e + side * rr * risk, 2) for rr in tps]
        hit, res, exit_j = 0, None, None
        for j in range(i + 1, min(len(entry), i + 241)):
            b = entry[j]
            if (b["low"] <= sl) if side == 1 else (b["high"] >= sl):
                res, exit_j, hit = -1.0, j, 0
                break
            reached = [k for k, t in enumerate(tp)
                       if (b["high"] >= t if side == 1 else b["low"] <= t)]
            if reached:
                hit = max(hit, max(reached) + 1)
                if hit >= len(tp):
                    res, exit_j = tps[-1], j
                    break
        if exit_j is None:
            exit_j = min(len(entry) - 1, i + 240)
            res = (entry[exit_j]["close"] - e) * side / risk
        cost = cfg["spread"] / risk
        out.append({"time": entry[i]["time"], "type": "BUY" if side == 1 else "SELL",
                    "entry": e, "sl": sl, "tp": tp, "risk": risk, "score": 100,
                    "r": round(res - cost, 3), "cost_r": round(cost, 3), "hit": hit,
                    "bars": exit_j - i})
        busy = exit_j
        if len(out) >= n:
            break
    return out


def line(tag, s, h1, h2):
    print("  %-20s n=%-3s win%%=%-5s avgR=%-7s pf=%-5s halves %+.3f / %+.3f (n %d/%d)"
          % (tag, s["n"], s["winrate"], s["avg_r"], s["pf"],
             h1["avg_r"] or 0, h2["avg_r"] or 0, h1["n"], h2["n"]))


def half_stats(tr, mode=2):
    n = len(tr)
    return L.stats(tr[:n // 2], mode), L.stats(tr[n // 2:], mode)


def run(raw, label, entry_s, confirm_s, bias_s, scores=(70, 80)):
    conf = agg(raw, confirm_s) if confirm_s > entry_s else raw
    bias = agg(raw, bias_s) if bias_s > entry_s else raw
    print("\n%s: %d entry bars %s -> %s  (%d confirm, %d bias)"
          % (label, len(raw), time.strftime("%m-%d %H:%M", time.gmtime(raw[0]["time"])),
             time.strftime("%m-%d %H:%M", time.gmtime(raw[-1]["time"])), len(conf), len(bias)))
    for sc in scores:
        cfg = dict(L.DEFAULTS)
        cfg.update({"min_score": sc, "spread": SPREAD, "entry_s": entry_s,
                    "confirm_s": confirm_s, "bias_s": bias_s})
        t0 = time.time()
        tr = L.replay(raw, conf, bias, cfg)
        print(" minimum score %d: %d trades (%.0fs)" % (sc, len(tr), time.time() - t0))
        for mode in (1, 2, 3, 4):
            s = L.stats(tr, mode)
            h1, h2 = half_stats(tr, mode)
            line("booked at TP%d" % mode, s, h1, h2)
        m = L.managed(tr)
        print("  %-20s n=%-3s win%%=%-5s avgR=%s   (half at TP1, stop to BE)"
              % ("as managed", m["n"], m["winrate"], m["avg_r"]))
        if tr:
            print("  by score band (TP2):",
                  {k: (v["n"], v["avg_r"]) for k, v in L.fit_score(tr, 2).items() if v["n"]})
            print("  by side (TP2):",
                  {k: (L.stats([t for t in tr if t["type"] == k], 2)["n"],
                       L.stats([t for t in tr if t["type"] == k], 2)["avg_r"])
                   for k in ("BUY", "SELL")})
            print("  median stop $%.2f | median cost %.2fR"
                  % (sorted(t["risk"] for t in tr)[len(tr) // 2],
                     sorted(t["cost_r"] for t in tr)[len(tr) // 2]))
            ctl = random_control(raw, cfg, len(tr))
            s = L.stats(ctl, 2)
            h1, h2 = half_stats(ctl, 2)
            line("RANDOM control", s, h1, h2)
    return tr if scores else []


def main():
    src = (sys.argv[1] if len(sys.argv) > 1 else "yahoo").lower()
    speed = (sys.argv[2] if len(sys.argv) > 2 else "1m").lower()
    if src == "yahoo" and speed == "1m":
        raw = sorted(yahoo("GC=F", "1m", "7d"), key=lambda b: b["time"])
        run(raw, "yahoo GC=F M1 (7 sessions)", 60, 300, 3600)
    elif src == "yahoo" and speed == "5m":
        raw = sorted(yahoo("GC=F", "5m", "60d"), key=lambda b: b["time"])
        run(raw, "yahoo GC=F M5 (60 days), confirm M15, bias H1", 300, 900, 3600)
    elif src == "xaus":
        raw = sorted(xaus("1m", "5d"), key=lambda b: b["time"])
        run(raw, "xaus spot M1 (5 sessions)", 60, 300, 3600)
    else:
        print("usage: logic_sweep.py [yahoo 1m|yahoo 5m|xaus]")


if __name__ == "__main__":
    main()
