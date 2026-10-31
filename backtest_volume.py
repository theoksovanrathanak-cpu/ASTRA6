"""Replay the volume-cluster strategy on real history.

Answers two questions with numbers instead of opinion:
    1. how often does it get stopped out?
    2. how often does it fire the same signal again (spam)?

Usage:  python backtest_volume.py [btc|gold|both]
"""
import sys
import time
import requests

import importlib
import os
import volume as VOL


# ---------------------------------------------------------------- data
def load_btc(bars=5000, interval="1m"):
    """Paginate Binance vision back from now. Real taker split (index 9)."""
    url = "https://data-api.binance.vision/api/v3/klines"
    out, end = [], None
    while len(out) < bars:
        params = {"symbol": "BTCUSDT", "interval": interval, "limit": 1000}
        if end:
            params["endTime"] = end
        k = requests.get(url, params=params, timeout=25).json()
        if not k:
            break
        rows = []
        for r in k:
            vol, buy = float(r[5]), float(r[9])
            rows.append({"time": int(r[0] / 1000), "open": float(r[1]), "high": float(r[2]),
                         "low": float(r[3]), "close": float(r[4]), "volume": vol,
                         "buy": buy, "sell": max(0.0, vol - buy)})
        out = rows + out
        end = int(k[0][0]) - 1
        if len(k) < 1000:
            break
    out = out[-bars:]
    return [c for c in out if c["volume"] > 0]


def load_gold(bars=1000):
    j = requests.get("https://xaus.com/api/v1/chart?symbol=xau&range=5d&interval=5m",
                     timeout=30, headers={"User-Agent": "ASTRA6/1.0"}).json()
    c = [{"time": int(p["t"]), "open": p["o"], "high": p["h"], "low": p["l"],
          "close": p["c"], "volume": float(p.get("v") or 0)} for p in j.get("points", [])]
    c = [x for x in c if x["volume"] > 0]
    return VOL.split_estimate(c)[-bars:]


# ---------------------------------------------------------------- strategy
DEFAULTS = {
    "rows": 48,
    "min_pct": 10.0,
    "atr_n": 14,
    "vwap_buf": 0.0,        # require price this many ATR away from VWAP
    "min_delta_ratio": 0.0, # |delta| / row total
    "stop_mode": "row",     # row | wide
    "stop_atr": 1.0,        # used by wide
    "confirm": 1,           # consecutive bars the same signal must persist
    "cooldown": 0,          # bars to wait before the next signal
    "tp1_r": 0.75,
    "max_hold": 60,
    "lookback": 400,
    "no_overlap": True,
    "vwap_slope": 0,       # require VWAP to be rising/falling over N bars
    "bar_quality": 0.0,    # close must sit this far up/down its own bar
    "atr_max_pct": 1.0,    # skip when ATR is above this percentile
}


def atr_series(c, n=14):
    out, prev = [], None
    trs = []
    for i, x in enumerate(c):
        if i == 0:
            trs.append(x["high"] - x["low"])
        else:
            p = c[i - 1]["close"]
            trs.append(max(x["high"] - x["low"], abs(x["high"] - p), abs(x["low"] - p)))
        if len(trs) >= n:
            prev = sum(trs[-n:]) / n
        out.append(prev if prev is not None else trs[-1])
    return out


def evaluate(sig, bars, i, cfg):
    """Walk forward from entry bar i. Conservative: if a bar touches SL and TP,
    the stop is assumed first."""
    e = sig["entry"]
    sl, tp1, tp2 = sig["sl"], sig["tp1"], sig["tp2"]
    risk = abs(e - sl)
    if risk <= 0:
        return None
    side = 1 if sig["type"] == "BUY" else -1
    be = False
    tp1_hit = False
    for j in range(i + 1, min(i + 1 + cfg["max_hold"], len(bars))):
        b = bars[j]
        if side == 1:
            if b["low"] <= sl:
                return (cfg["tp1_r"] if tp1_hit else -1.0, j - i, "SL")
            if not tp1_hit and b["high"] >= tp1:
                tp1_hit, be, sl = True, True, e
            if b["high"] >= tp2:
                return ((tp2 - e) / risk if not tp1_hit else (tp2 - e) / risk, j - i, "TP2")
        else:
            if b["high"] >= sl:
                return (cfg["tp1_r"] if tp1_hit else -1.0, j - i, "SL")
            if not tp1_hit and b["low"] <= tp1:
                tp1_hit, be, sl = True, True, e
            if b["low"] <= tp2:
                return ((e - tp2) / risk, j - i, "TP2")
    last = bars[min(i + cfg["max_hold"], len(bars) - 1)]["close"]
    return ((last - e) / risk * side, cfg["max_hold"], "TIME")


_PASS_CACHE = {}


def analysis_pass(bars, lookback, rows, min_pct, mod=None):
    """Every bar's signal, computed once and memoised per dataset."""
    mod = mod or VOL
    key = (id(bars), len(bars), lookback, rows, min_pct, mod.__name__)
    if key in _PASS_CACHE:
        return _PASS_CACHE[key]
    out = []
    for i in range(len(bars)):
        if i < 240:
            out.append(None)
            continue
        w = bars[max(0, i - lookback + 1):i + 1]
        d = mod.analyse(w, rows=rows, min_pct=min_pct)
        out.append(d)
    _PASS_CACHE[key] = out
    return out


def run(bars, cfg, mod=None):
    mod = mod or VOL
    cfg = dict(DEFAULTS, **cfg)
    if cfg.get("cooldown_min") is not None:
        # express the cooldown in wall-clock minutes, whatever the timeframe
        diffs = sorted(bars[i]["time"] - bars[i - 1]["time"] for i in range(1, min(400, len(bars))))
        bar_min = max(1, diffs[len(diffs) // 2] // 60) if diffs else 1
        cfg["cooldown"] = max(1, int(round(cfg["cooldown_min"] / bar_min)))
    atrs = atr_series(bars, cfg["atr_n"])
    trade_list = analysis_pass(bars, cfg["lookback"], cfg["rows"], cfg["min_pct"], mod)
    trades, signals = [], 0
    last_bar = -10 ** 9
    streak, prev_type = 0, None
    i = 240
    while i < len(bars) - 1:
        d = trade_list[i]
        sig = d.get("signal") or {}
        t = sig.get("type")
        streak = streak + 1 if t == prev_type else 1
        prev_type = t
        if t not in ("BUY", "SELL"):
            i += 1
            continue
        if streak < cfg["confirm"]:
            i += 1
            continue
        if i - last_bar < cfg["cooldown"]:
            i += 1
            continue

        row, a = sig.get("row") or {}, atrs[i]
        price = sig["price"]
        vwap = sig.get("vwap")

        # gates
        if cfg["vwap_buf"] and vwap:
            done = price - vwap if t == "BUY" else vwap - price
            if done < cfg["vwap_buf"] * a:
                i += 1
                continue
        if cfg["min_delta_ratio"]:
            tot = max(row.get("total", 0), 1e-9)
            if abs(row.get("delta", 0)) / tot < cfg["min_delta_ratio"]:
                i += 1
                continue

        if cfg["vwap_slope"] and vwap:
            ser = d.get("vwap_series") or []
            k = cfg["vwap_slope"]
            if len(ser) > k:
                slope = ser[-1]["value"] - ser[-1 - k]["value"]
                if (t == "BUY" and slope <= 0) or (t == "SELL" and slope >= 0):
                    i += 1
                    continue
        if cfg["bar_quality"]:
            b0 = bars[i]
            rng = max(b0["high"] - b0["low"], 1e-9)
            pos = (b0["close"] - b0["low"]) / rng
            if (t == "BUY" and pos < cfg["bar_quality"]) or (t == "SELL" and pos > 1 - cfg["bar_quality"]):
                i += 1
                continue
        if cfg["atr_max_pct"] < 1.0:
            hist = sorted(atrs[max(0, i - 200):i + 1])
            lim = hist[int(len(hist) * cfg["atr_max_pct"])] if hist else a
            if a > lim:
                i += 1
                continue

        # stop placement
        if cfg["stop_mode"] == "wide":
            if t == "BUY":
                far = row["bot"] - 0.15 * a
                sl = min(far, price - cfg["stop_atr"] * a)
            else:
                far = row["top"] + 0.15 * a
                sl = max(far, price + cfg["stop_atr"] * a)
        else:
            sl = sig["sl"]
            risk0 = abs(price - sl)
            if risk0 < 0.6 * a:                      # same floor the live code uses
                sl = price - 0.6 * a if t == "BUY" else price + 0.6 * a
        risk = abs(price - sl)
        if risk <= 0:
            i += 1
            continue
        tp1 = price + (cfg["tp1_r"] * risk) * (1 if t == "BUY" else -1)
        tp2 = sig["tp2"]
        # a target on the wrong side is nonsense
        if (t == "BUY" and tp2 <= price) or (t == "SELL" and tp2 >= price):
            i += 1
            continue

        signals += 1
        s = {"type": t, "entry": price, "sl": sl, "tp1": tp1, "tp2": tp2}
        r = evaluate(s, bars, i, cfg)
        if not r:
            i += 1
            continue
        trades.append({"i": i, "r": r[0], "bars": r[1], "why": r[2], "type": t,
                       "risk": risk, "atr": a, "row": (row.get("bot"), row.get("top"))})
        last_bar = i
        if cfg["no_overlap"]:
            i += max(1, r[1])   # can't take another trade while this one is open
        else:
            i += 1
    return signals, trades


def report(name, bars, cfg, span_hours):
    t0 = time.time()
    signals, trades = run(bars, cfg)
    n = len(trades)
    if not n:
        print(f"{name:<28} no trades")
        return {}
    wins = [t for t in trades if t["r"] > 0]
    stops = [t for t in trades if t["why"] == "SL" and t["r"] <= -0.99]
    be = [t for t in trades if t["why"] == "SL" and t["r"] > -0.99]
    total_r = sum(t["r"] for t in trades)
    dur = time.time() - t0
    print(f"{name:<28} sig {signals:>4} ({(signals/span_hours):5.2f}/h) | "
          f"trades {n:>4} | win {100*len(wins)/n:5.1f}% | "
          f"stop-out {100*len(stops)/n:5.1f}% | BE {100*len(be)/n:4.1f}% | "
          f"avg {total_r/n:+.2f}R | total {total_r:+.1f}R  [{dur:.0f}s]")
    return {"signals": signals, "trades": n, "win": len(wins) / n,
            "stops": len(stops) / n, "avg": total_r / n, "total": total_r,
            "per_h": signals / span_hours}


if __name__ == "__main__":
    which = (sys.argv[1] if len(sys.argv) > 1 else "both").lower()
    sets = []
    if which in ("btc", "both"):
        b = load_btc(5000)
        print(f"BTC 1m: {len(b)} bars · {b[0]['time']} → {b[-1]['time']} · last {b[-1]['close']}")
        sets.append(("BTC 1m", b, 5000 / 60, 600))
    if which in ("gold", "both"):
        g = load_gold(1300)
        print(f"GOLD 5m: {len(g)} bars · last {g[-1]['close']}")
        sets.append(("GOLD 5m", g, 1300 * 5 / 60, 400))

    BASE = {"stop_mode": "wide", "vwap_buf": 0.25, "min_delta_ratio": 0.15, "confirm": 2}
    VARIANTS = [
        ("current", {}),
        ("delta gate only", {"min_delta_ratio": 0.15}),
        ("wide stop", {"stop_mode": "wide"}),
        ("base + cd 15", dict(BASE, cooldown=15)),
        ("base + cd 30", dict(BASE, cooldown=30)),
        ("base + cd 30 + d.25", dict(BASE, cooldown=30, min_delta_ratio=0.25)),
        ("cd30 d.25 tp1 1R", dict(BASE, cooldown=30, min_delta_ratio=0.25, tp1_r=1.0)),
        ("cd15 + vwap slope", dict(BASE, cooldown=15, vwap_slope=10)),
        ("cd15 + bar quality", dict(BASE, cooldown=15, bar_quality=0.6)),
        ("cd15 + slope + bq", dict(BASE, cooldown=15, vwap_slope=10, bar_quality=0.55)),
        ("cd15 + slope + atr<80", dict(BASE, cooldown=15, vwap_slope=10, atr_max_pct=0.8)),
        ("FINAL 15min", dict(BASE, cooldown_min=15, vwap_slope=10, atr_max_pct=0.8)),
        ("FINAL 30min", dict(BASE, cooldown_min=30, vwap_slope=10, atr_max_pct=0.8)),
        ("FINAL 15 no delta gate", {"stop_mode": "wide", "vwap_buf": 0.25, "confirm": 2,
                                    "cooldown_min": 15, "vwap_slope": 10, "atr_max_pct": 0.8}),
        ("FINAL 15 no slope", {"stop_mode": "wide", "vwap_buf": 0.25, "min_delta_ratio": 0.15,
                               "confirm": 2, "cooldown_min": 15, "atr_max_pct": 0.8}),
        # the real thing: gates inside volume.signal(), only the alert cooldown on top
        ("SHIPPED (15m cooldown)", {"cooldown_min": 15}),
        ("SHIPPED (no cooldown)", {"cooldown_min": 0}),
    ]
    for name, bars, span_hours, lookback in sets:
        print(f"\n=== {name} — {len(bars)} bars, lookback {lookback}")
        for vname, cfg in VARIANTS:
            cfg = dict(cfg, lookback=lookback, max_hold=60 if "1m" in name else 36)
            report(vname, bars, cfg, span_hours)
