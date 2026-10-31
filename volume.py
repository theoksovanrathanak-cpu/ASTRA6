"""
Volume clusters + daily VWAP  —  port of "Volume Clusters + Daily VWAP".

WHAT IS REAL AND WHAT IS ESTIMATED (this matters, no pretending):
  · VWAP          — exact. hlc3 x real volume, reset each UTC day.
  · BTCUSD rows   — Binance klines carry taker buy volume per bar, so the
                    buy/sell split is REAL aggressor flow. The volume is then
                    laid across the bar's price range (uniform model), because
                    free APIs do not expose per-price order flow.
  · XAUUSD rows   — real tick volume per bar; the buy/sell split uses the
                    close-location estimator (buy = vol*(close-low)/(high-low)).
                    An estimate, labelled as such in the API and the UI.
  Nothing is invented: every number comes from a real trade volume.
"""
from __future__ import annotations

BINANCE = "https://data-api.binance.vision/api/v3"


_KL_CACHE = {"key": None, "t": 0.0, "d": None}
_KL_TTL = 45.0          # clusters do not need sub-minute freshness; Be polite to the venue


def fetch_btc_klines(interval="1m", limit=500):
    """Real Binance klines with taker buy volume (field 9).

    Cached, because this feed rate-limits hard: hammering it earns an HTTP 418
    ban for the whole server IP, which also takes the live price down.
    """
    import time
    import requests
    key = (interval, min(limit, 1000))
    now = time.time()
    if _KL_CACHE["d"] is not None and _KL_CACHE["key"] == key and now - _KL_CACHE["t"] < _KL_TTL:
        return _KL_CACHE["d"]

    url = f"{BINANCE}/klines?symbol=BTCUSDT&interval={key[0]}&limit={key[1]}"
    r = requests.get(url, timeout=12, headers={"User-Agent": "ASTRA6/1.0"})
    if r.status_code in (418, 429):
        # rate limited — serve the last good set instead of failing, and stay quiet
        if _KL_CACHE["d"] is not None:
            return _KL_CACHE["d"]
        raise RuntimeError("binance rate limited (418/429)")
    r.raise_for_status()
    out = []
    for k in r.json():
        vol = float(k[5])
        buy = float(k[9])                      # taker buy base asset volume
        sell = max(0.0, vol - buy)
        out.append({"time": int(k[0] / 1000), "open": float(k[1]), "high": float(k[2]),
                    "low": float(k[3]), "close": float(k[4]), "volume": vol,
                    "buy": buy, "sell": sell, "trades": int(k[8])})
    if out:
        _KL_CACHE.update({"key": key, "t": now, "d": out})
    return out


# ---- timeframe helpers -------------------------------------------------------
# The chart plots M1..W1. The profile has to be built from the SAME bars the chart
# shows, otherwise the cluster box floats over candles it was never measured from.
TF_MINUTES = {"M1": 1, "M5": 5, "M15": 15, "M30": 30, "H1": 60, "H4": 240, "D": 1440, "W": 10080}
TF_BINANCE = {"M1": "1m", "M5": "5m", "M15": "15m", "M30": "30m", "H1": "1h", "H4": "4h", "D": "1d", "W": "1w"}
TF_COINBASE = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600, "H4": 21600, "D": 86400}


def normalise_tf(tf):
    """Accept M15 / 15m / D1 / W1 / 1h and give back one of our keys."""
    raw = str(tf or "M15").strip()
    t = raw.upper()
    t = {"D1": "D", "W1": "W"}.get(t, t)
    if t in TF_MINUTES:
        return t
    low = raw.lower()
    rev = {v: k for k, v in TF_BINANCE.items()}
    if low in rev:
        return rev[low]
    if low in ("1d", "d", "daily", "day"):
        return "D"
    if low in ("1w", "w", "weekly", "week"):
        return "W"
    return "M15"


def aggregate(candles, minutes):
    """Merge smaller bars into bigger ones, keeping the real volume and taker split."""
    if minutes <= 1 or not candles:
        return list(candles)
    step = minutes * 60
    out, cur = [], None
    for c in sorted(candles, key=lambda x: x["time"]):
        b = int(c["time"] // step) * step
        if cur is None or cur["time"] != b:
            if cur:
                out.append(cur)
            cur = {"time": b, "open": c["open"], "high": c["high"], "low": c["low"],
                   "close": c["close"], "volume": float(c.get("volume") or 0),
                   "buy": float(c.get("buy") or 0), "sell": float(c.get("sell") or 0)}
        else:
            cur["high"] = max(cur["high"], c["high"])
            cur["low"] = min(cur["low"], c["low"])
            cur["close"] = c["close"]
            cur["volume"] += float(c.get("volume") or 0)
            cur["buy"] += float(c.get("buy") or 0)
            cur["sell"] += float(c.get("sell") or 0)
    if cur:
        out.append(cur)
    return out


def fetch_btc_candles_fallback(bars=350, tf="M1"):
    """Real Coinbase 1m candles with the taker split ESTIMATED from close location.

    Only used when Binance rate-limits the server IP. The volume is real; the buy/sell
    split is an estimate and every caller labels it as one.
    """
    import requests
    key = normalise_tf(tf)
    gran = TF_COINBASE.get(key, 60)
    r = requests.get("https://api.exchange.coinbase.com/products/BTC-USD/candles",
                     params={"granularity": gran}, timeout=12,
                     headers={"User-Agent": "ASTRA6/1.0"})
    r.raise_for_status()
    rows = sorted(r.json(), key=lambda k: k[0])
    out = [{"time": int(k[0]), "low": float(k[1]), "high": float(k[2]),
            "open": float(k[3]), "close": float(k[4]), "volume": float(k[5])} for k in rows]
    out = [c for c in out if c["volume"] > 0][-bars:]
    return split_estimate(out)


def split_estimate(candles):
    """Gold: real volume, estimated buy/sell split from where the close sits."""
    out = []
    for c in candles:
        vol = float(c.get("volume") or 0)
        rng = c["high"] - c["low"]
        ratio = ((c["close"] - c["low"]) / rng) if rng > 0 else 0.5
        out.append({**c, "volume": vol, "buy": vol * ratio, "sell": vol * (1 - ratio)})
    return out


def daily_vwap(candles):
    """Exact VWAP from the start of the UTC day. Returns (value, bars_used)."""
    if not candles:
        return None, 0
    import datetime
    last_day = datetime.datetime.utcfromtimestamp(candles[-1]["time"]).date()
    pv = v = 0.0
    used = 0
    for c in reversed(candles):
        if datetime.datetime.utcfromtimestamp(c["time"]).date() != last_day:
            break
        tp = (c["high"] + c["low"] + c["close"]) / 3.0
        vol = float(c.get("volume") or 0)
        if vol <= 0:
            continue
        pv += tp * vol
        v += vol
        used += 1
    if v <= 0:
        return None, 0
    return pv / v, used


def _row_size(candles, rows=48):
    hi = max(c["high"] for c in candles)
    lo = min(c["low"] for c in candles)
    span = hi - lo
    if span <= 0:
        return None
    raw = span / rows
    # round to a pleasant step so the rows look like the indicator's ticks
    mag = 10 ** max(0, int(f"{raw:e}".split("e")[1]) - 1)
    step = round(raw / mag) * mag
    return max(step, 1e-8)


def clusters(candles, rows=48, min_pct=10.0):
    """
    Volume-at-price rows for the most recent bars.
    Returns rows sorted by price with buy/sell/total/delta, plus the POC.
    """
    if not candles:
        return [], None, None
    step = _row_size(candles, rows)
    if not step:
        return [], None, None
    book = {}
    for c in candles:
        lo_i = int(c["low"] // step)
        hi_i = int(c["high"] // step)
        n = max(1, hi_i - lo_i + 1)
        b = float(c.get("buy") or 0) / n
        s = float(c.get("sell") or 0) / n
        for i in range(lo_i, hi_i + 1):
            slot = book.setdefault(i, {"buy": 0.0, "sell": 0.0})
            slot["buy"] += b
            slot["sell"] += s
    out = []
    for i, slot in sorted(book.items()):
        total = slot["buy"] + slot["sell"]
        if total <= 0:
            continue
        out.append({"bot": round(i * step, 2), "top": round((i + 1) * step, 2),
                    "buy": round(slot["buy"], 4), "sell": round(slot["sell"], 4),
                    "total": round(total, 4), "delta": round(slot["buy"] - slot["sell"], 4)})
    if not out:
        return [], None, step
    poc = max(out, key=lambda r: r["total"])
    keep = [r for r in out if r["total"] >= poc["total"] * min_pct / 100.0]
    return keep, poc, step


def value_area(rows, poc, pct=0.70):
    """70% value area around the POC, like the indicator's value area."""
    if not rows or not poc:
        return None
    ordered = sorted(rows, key=lambda r: r["total"], reverse=True)
    target = sum(r["total"] for r in rows) * pct
    acc, chosen = 0.0, []
    for r in ordered:
        chosen.append(r)
        acc += r["total"]
        if acc >= target:
            break
    return {"high": max(r["top"] for r in chosen), "low": min(r["bot"] for r in chosen)}



def _percentile(vals, q):
    if not vals:
        return None
    s = sorted(vals)
    k = max(0, min(len(s) - 1, int(len(s) * q)))
    return s[k]


def atr_series(candles, n=14):
    """Wilder-style ATR for every bar, so we can rank volatility against itself."""
    trs, out = [], []
    for i, c in enumerate(candles):
        if i == 0:
            tr = c["high"] - c["low"]
        else:
            p = candles[i - 1]["close"]
            tr = max(c["high"] - c["low"], abs(c["high"] - p), abs(c["low"] - p))
        trs.append(tr)
        out.append(sum(trs[-n:]) / n if len(trs) >= n else trs[-1])
    return out


def signal(candles, vwap, rows, poc, atr, min_pct=10.0, vwap_series_in=None):
    """
    The rule set, tuned on real history (see backtest_volume.py):

        BUY   price in a high-volume row, above VWAP by 0.25 ATR, VWAP rising,
              row delta positive and at least 15% of the row, ATR not in the top 20%
        SELL  the mirror image
        stop  beyond the row AND at least 1 ATR away - never inside the cluster
        TP1   0.75R, TP2 the next cluster in the direction of travel
    """
    if not candles or not rows:
        return {"type": "HOLD", "reason": "no volume data yet"}
    price = candles[-1]["close"]
    a = atr or (candles[-1]["high"] - candles[-1]["low"]) or price * 0.0005

    out = {"price": round(price, 2), "atr": round(a, 4)}

    cur = next((r for r in rows if r["bot"] <= price <= r["top"]), None)
    if cur is None:
        nearest = min(rows, key=lambda r: abs((r["bot"] + r["top"]) / 2 - price))
        out.update({"type": "HOLD",
                    "reason": f"Price outside every cluster - nearest node {(nearest['bot'] + nearest['top']) / 2:.2f}"})
        return out

    out.update({"row": {k: cur[k] for k in ("bot", "top", "buy", "sell", "total", "delta")},
                "vwap": round(vwap, 2) if vwap else None,
                "poc": {"price": round((poc["bot"] + poc["top"]) / 2, 2), "total": poc["total"]},
                "poc_row": {"bot": poc["bot"], "top": poc["top"]}})

    # ---- gate 1: the row has to carry real volume ----
    if cur["total"] < poc["total"] * min_pct / 100.0:
        out.update({"type": "HOLD", "reason": "Price in a thin row - no cluster to trade against."})
        return out

    # ---- gate 2: volatility has to be normal for this instrument ----
    aser = atr_series(candles, 14)
    recent = [x for x in aser[-120:] if x]
    if len(recent) >= 30:
        lim = _percentile(recent, 0.80)
        if lim and a > lim:
            out.update({"type": "HOLD",
                        "reason": f"ATR {a:.2f} is above its 80th percentile ({lim:.2f}) - too hot to hold."})
            return out

    # ---- gate 3: VWAP side, with a buffer so it can't flicker on the line ----
    buf = 0.25 * a
    above = vwap is not None and (price - vwap) >= buf
    below = vwap is not None and (vwap - price) >= buf
    if not above and not below:
        out.update({"type": "HOLD",
                    "reason": f"Too close to VWAP {vwap:.2f} - waiting for price to commit." if vwap
                              else "VWAP unavailable."})
        return out

    # ---- gate 4: VWAP must be moving the same way as the trade ----
    ser = vwap_series_in or vwap_series(candles)
    if len(ser) > 10:
        slope = ser[-1]["value"] - ser[-11]["value"]
        if (above and slope <= 0) or (below and slope >= 0):
            out.update({"type": "HOLD",
                        "reason": f"VWAP is flat against the trade ({slope:+.2f} over 10 bars) - no edge."})
            return out

    # ---- gate 5: the row's own delta has to agree ----
    ratio = abs(cur["delta"]) / max(cur["total"], 1e-9)
    if ratio < 0.15:
        out.update({"type": "HOLD",
                    "reason": f"Row delta only {ratio*100:.0f}% of volume - buyers and sellers still fighting."})
        return out

    if above and cur["delta"] > 0:
        side = 1
    elif below and cur["delta"] < 0:
        side = -1
    else:
        out.update({"type": "HOLD",
                    "reason": f"In cluster but {'above' if above else 'below'} VWAP with "
                              f"{'positive' if cur['delta'] > 0 else 'negative'} delta - no edge."})
        return out

    # ---- stop: outside the row and never tighter than 1 ATR ----
    if side == 1:
        nxt = [r for r in rows if r["bot"] > cur["top"]]
        tp_level = min(nxt, key=lambda r: r["bot"])["bot"] if nxt else (vwap or price + 2 * a)
        sl = min(cur["bot"] - 0.15 * a, price - 1.0 * a)
    else:
        nxt = [r for r in rows if r["top"] < cur["bot"]]
        tp_level = max(nxt, key=lambda r: r["top"])["top"] if nxt else (vwap or price - 2 * a)
        sl = max(cur["top"] + 0.15 * a, price + 1.0 * a)

    risk = abs(price - sl)
    if risk <= 0:
        out.update({"type": "HOLD", "reason": "degenerate risk"})
        return out
    tp1 = price + side * 0.75 * risk
    tp2 = tp_level
    out.update({
        "type": "BUY" if side == 1 else "SELL",
        "entry": round(price, 2), "sl": round(sl, 2),
        "tp1": round(tp1, 2), "tp2": round(tp2, 2),
        "risk": round(risk, 2),
        "r": round(abs(tp2 - price) / risk, 2),
        "confidence": min(92, 55 + int(min(35, ratio * 100 * 0.5))),
        "reason": (f"Cluster {cur['bot']:.2f}-{cur['top']:.2f} · "
                   f"{'above' if side == 1 else 'below'} VWAP {vwap:.2f} · "
                   f"delta {'+' if cur['delta'] >= 0 else ''}{cur['delta']:.2f} · "
                   f"stop {risk/a:.1f} ATR"),
    })
    return out


def vwap_series(candles):
    """Per-bar running VWAP for the current UTC day (what the indicator plots)."""
    import datetime
    if not candles:
        return []
    pv = v = 0.0
    day = None
    out = []
    for c in candles:
        d = datetime.datetime.utcfromtimestamp(c["time"]).date()
        if d != day:
            day, pv, v = d, 0.0, 0.0
        vol = float(c.get("volume") or 0)
        tp = (c["high"] + c["low"] + c["close"]) / 3.0
        if vol > 0:
            pv += tp * vol
            v += vol
        if v > 0:
            out.append({"time": int(c["time"]), "value": round(pv / v, 2)})
    return out


def analyse(candles, rows=48, min_pct=10.0, bias_from="5m"):
    """Full pass: split -> vwap -> clusters -> signal."""
    if not candles:
        return {"status": "error", "error": "no candles"}
    vwap, used = daily_vwap(candles)
    cl, poc, step = clusters(candles, rows, min_pct)
    n = len(candles)
    trs = []
    for i in range(1, n):
        c, p = candles[i], candles[i - 1]
        trs.append(max(c["high"] - c["low"], abs(c["high"] - p["close"]), abs(c["low"] - p["close"])))
    atr = sum(trs[-14:]) / len(trs[-14:]) if trs else None
    sig = signal(candles, vwap, cl, poc, atr, min_pct, vwap_series(candles))
    va = value_area(cl, poc)
    return {"status": "ok", "vwap_series": vwap_series(candles[-180:]),
            "vwap": round(vwap, 2) if vwap else None,
            "vwap_bars": used, "rows": cl, "poc": poc,
            "value_area": va, "row_size": step,
            "signal": sig, "atr": round(atr, 2) if atr else None,
            "bars": n}
