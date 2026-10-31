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


def fetch_btc_klines(interval="1m", limit=500):
    """Real Binance klines with taker buy volume (field 9)."""
    import requests
    url = f"{BINANCE}/klines?symbol=BTCUSDT&interval={interval}&limit={min(limit, 1000)}"
    r = requests.get(url, timeout=12, headers={"User-Agent": "ASTRA6/1.0"})
    r.raise_for_status()
    out = []
    for k in r.json():
        vol = float(k[5])
        buy = float(k[9])                      # taker buy base asset volume
        sell = max(0.0, vol - buy)
        out.append({"time": int(k[0] / 1000), "open": float(k[1]), "high": float(k[2]),
                    "low": float(k[3]), "close": float(k[4]), "volume": vol,
                    "buy": buy, "sell": sell, "trades": int(k[8])})
    return out


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


def signal(candles, vwap, rows, poc, atr, min_pct=10.0):
    """
    The strategy, stated plainly:
        price in a high-volume row AND above VWAP AND row delta positive -> BUY
        price in a high-volume row AND below VWAP AND row delta negative -> SELL
    Stop goes just past the row, TP1 is the next cluster, TP2 is the POC/VWAP.
    """
    if not candles or not rows:
        return {"type": "HOLD", "reason": "no volume data yet"}
    price = candles[-1]["close"]
    a = atr or (candles[-1]["high"] - candles[-1]["low"]) or price * 0.0005

    cur = next((r for r in rows if r["bot"] <= price <= r["top"]), None)
    if cur is None:
        nearest = min(rows, key=lambda r: abs((r["bot"] + r["top"]) / 2 - price))
        return {"type": "HOLD", "price": round(price, 2),
                "reason": f"Price outside every cluster — nearest node {(nearest['bot'] + nearest['top']) / 2:.2f}"}

    strong = cur["total"] >= poc["total"] * min_pct / 100.0
    above = vwap is not None and price > vwap
    below = vwap is not None and price < vwap
    out = {"price": round(price, 2), "row": {k: cur[k] for k in ("bot", "top", "buy", "sell", "total", "delta")},
           "vwap": round(vwap, 2) if vwap else None,
           "poc": {"price": round((poc["bot"] + poc["top"]) / 2, 2), "total": poc["total"]},
           "poc_row": {"bot": poc["bot"], "top": poc["top"]}}

    if not strong:
        out.update({"type": "HOLD", "reason": "Price in a thin row — no cluster to trade against."})
        return out

    if above and cur["delta"] > 0:
        side = 1
    elif below and cur["delta"] < 0:
        side = -1
    else:
        out.update({"type": "HOLD",
                    "reason": f"In cluster but {'above' if above else 'below'} VWAP with "
                              f"{'positive' if cur['delta'] > 0 else 'negative'} delta — no edge."})
        return out

    # next cluster in the direction of the trade
    # stop past the row, but never tighter than 0.6 ATR (a $1 stop is not a stop)
    min_risk = 0.6 * a
    if side == 1:
        nxt = [r for r in rows if r["bot"] > cur["top"]]
        tp_level = min(nxt, key=lambda r: r["bot"])["bot"] if nxt else (vwap or price + 2 * a)
        sl = cur["bot"] - 0.15 * a
        if price - sl < min_risk:
            sl = price - min_risk
    else:
        nxt = [r for r in rows if r["top"] < cur["bot"]]
        tp_level = max(nxt, key=lambda r: r["top"])["top"] if nxt else (vwap or price - 2 * a)
        sl = cur["top"] + 0.15 * a
        if sl - price < min_risk:
            sl = price + min_risk

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
        "confidence": min(92, 55 + int(min(35, abs(cur["delta"]) / max(cur["total"], 1e-9) * 100 * 0.5))),
        "reason": (f"{'Cluster' if True else ''} {cur['bot']:.2f}–{cur['top']:.2f} · "
                   f"{'above' if side == 1 else 'below'} VWAP {vwap:.2f} · "
                   f"delta {'+' if cur['delta'] >= 0 else ''}{cur['delta']:.2f}"),
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
    sig = signal(candles, vwap, cl, poc, atr, min_pct)
    va = value_area(cl, poc)
    return {"status": "ok", "vwap_series": vwap_series(candles[-180:]),
            "vwap": round(vwap, 2) if vwap else None,
            "vwap_bars": used, "rows": cl, "poc": poc,
            "value_area": va, "row_size": step,
            "signal": sig, "atr": round(atr, 2) if atr else None,
            "bars": n}
