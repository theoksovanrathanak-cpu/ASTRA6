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
    rows = max(8, min(400, int(rows)))
    raw = span / rows
    # round to a pleasant step so the rows look like the indicator's ticks
    mag = 10 ** (int(f"{raw:e}".split("e")[1]) - 1)
    step = round(raw / mag) * mag
    if step <= 0:
        step = raw
    # A quiet market can make span/rows smaller than 1, and the old max(0, ...) then gave
    # a step of 0 -> a 1e-8 step -> hundreds of millions of bins -> the worker was killed.
    # Cap the book at ~4000 bins whatever the instrument does.
    return max(step, span / 4000.0, 1e-9)


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


def _bar_delta(c):
    """Aggressive buying minus aggressive selling for one bar.

    Real taker split where the feed gives one (Binance), otherwise the close-location
    estimate the whole page is already labelled with: close near the high = buyers
    were in control, close near the low = sellers were.
    """
    b, s = c.get("buy"), c.get("sell")
    if b is not None and s is not None:
        return float(b) - float(s)
    vol = float(c.get("volume") or 0)
    hi, lo, cl = float(c["high"]), float(c["low"]), float(c["close"])
    rng = (hi - lo) or 1e-9
    return vol * (((cl - lo) - (hi - cl)) / rng)


def _sum_delta(bars):
    return sum(_bar_delta(c) for c in bars)


def _vol_of(bars):
    return sum(float(c.get("volume") or 0) for c in bars) or 1e-9


def signal(candles, vwap, rows, poc, atr, min_pct=10.0, vwap_series_in=None, va=None):
    """
    Order flow, read off the volume profile the chart is drawing.

    The unit of evidence is the VALUE EDGE, not the VWAP. Each edge gets one of two
    reads, and they are opposites:

      REJECTION (responsive)  a bar traded through VAL/VAH and closed back inside,
                              with the delta of that move agreeing with the reclaim.
                              Price failed outside value -> fade back to the POC.
                              A bounce off VAL is a BUY, even below VWAP. The old
                              rules vetoed exactly this with "below VWAP = sell",
                              which is how a VAL rejection came out as a SELL.

      ABSORPTION              heavy volume sitting on the edge row with a delta that
                              is almost balanced, and the last bar turning away.
                              Somebody big is filling the sellers/buyers there.

      ACCEPTANCE (initiative) price held outside value for 2+ of the last 3 bars and
                              the window delta is building -> go with it, stop back
                              inside value.

    VWAP and the POC are tie-breaks, never vetoes. The ATR gate stays: a market in
    its top-20% volatility has no business being held for a target.
    """
    if not candles or not rows or not poc:
        return {"type": "HOLD", "reason": "no volume data yet"}
    price = candles[-1]["close"]
    a = atr or (candles[-1]["high"] - candles[-1]["low"]) or price * 0.0005

    va = va or value_area(rows, poc)
    if va:
        val, vah = va["low"], va["high"]
    else:
        val, vah = poc["bot"], poc["top"]

    out = {"price": round(price, 2), "atr": round(a, 4)}
    cur = next((r for r in rows if r["bot"] <= price <= r["top"]), None)
    row = cur or min(rows, key=lambda r: abs((r["bot"] + r["top"]) / 2 - price))
    out.update({"row": {k: row[k] for k in ("bot", "top", "buy", "sell", "total", "delta")},
                "vwap": round(vwap, 2) if vwap else None,
                "poc": {"price": round((poc["bot"] + poc["top"]) / 2, 2), "total": poc["total"]},
                "poc_row": {"bot": poc["bot"], "top": poc["top"]},
                "value_area": {"low": round(val, 2), "high": round(vah, 2)}})

    # ---- the flow window: last six bars of aggression, last three of structure ----
    win, w3 = candles[-6:], candles[-3:]
    d_win, v_win = _sum_delta(win), _vol_of(win)
    d_ratio = d_win / v_win
    d_last = _bar_delta(candles[-1])
    wlow = min(c["low"] for c in w3)
    whigh = max(c["high"] for c in w3)
    closes_below = sum(1 for c in w3 if c["close"] < val)
    closes_above = sum(1 for c in w3 if c["close"] > vah)
    away = 0.15 * a
    above_vwap = vwap is not None and price > vwap
    below_vwap = vwap is not None and price < vwap

    out["flow"] = {"delta_6": round(d_win, 2), "delta_ratio": round(d_ratio, 4),
                   "delta_last": round(d_last, 2), "va_low": round(val, 2),
                   "va_high": round(vah, 2),
                   "vwap_side": "above" if above_vwap else ("below" if below_vwap else "at")}

    # ---- volatility gate: unchanged, it keeps the strategy out of news spikes ----
    aser = atr_series(candles, 14)
    recent = [x for x in aser[-120:] if x]
    if len(recent) >= 30:
        lim = _percentile(recent, 0.80)
        if lim and a > lim:
            out.update({"type": "HOLD",
                        "reason": f"ATR {a:.2f} is in the top 20% of the last 120 bars - too hot to hold."})
            return out

    row_strength = (row["total"] / poc["total"]) if poc["total"] else 0
    row_balance = abs(row["delta"]) / max(row["total"], 1e-9)

    rejection_low = wlow < val and price > val and d_win > 0
    rejection_high = whigh > vah and price < vah and d_win < 0
    absorption_low = (row_strength >= min_pct / 100.0 and row_balance < 0.20 and
                      wlow < val + away and d_last > 0)
    absorption_high = (row_strength >= min_pct / 100.0 and row_balance < 0.20 and
                       whigh > vah - away and d_last < 0)
    accept_above = price > vah + away and closes_above >= 2 and d_win > 0 and above_vwap
    accept_below = price < val - away and closes_below >= 2 and d_win < 0 and below_vwap

    side, style = 0, None
    if rejection_low:
        side, style = 1, "reject VAL"
    elif rejection_high:
        side, style = -1, "reject VAH"
    elif accept_above:
        side, style = 1, "accept above value"
    elif accept_below:
        side, style = -1, "accept below value"
    elif absorption_low:
        side, style = 1, "absorbed at VAL"
    elif absorption_high:
        side, style = -1, "absorbed at VAH"

    if not side:
        if val < price < vah:
            why = f"Inside value {val:.2f}-{vah:.2f}, delta {d_ratio*100:+.0f}% - no edge either way."
        elif price <= val:
            why = f"Under VAL {val:.2f} but the flow is not turning up yet (delta {d_ratio*100:+.0f}%)."
        else:
            why = f"Over VAH {vah:.2f} but the flow is not turning down yet (delta {d_ratio*100:+.0f}%)."
        out.update({"type": "HOLD", "reason": why})
        return out

    # ---- the level that voids the idea, and two targets that are actually reachable ----
    if "reject" in style or "absorbed" in style:
        extreme = wlow if side == 1 else whigh
        raw_risk = abs(price - (extreme - side * away))
        risk = min(max(raw_risk, 0.5 * a), 1.6 * a)
        poc_mid = (poc["bot"] + poc["top"]) / 2
        to_poc = (poc_mid - price) * side
        tp1_d = min(max(to_poc if to_poc > 0 else risk, 0.8 * risk), 1.4 * risk)
        far = vah if side == 1 else val
        to_far = (far - price) * side
        tp2_d = to_far if to_far > tp1_d * 1.2 else 2.4 * risk
        tp2_d = min(max(tp2_d, 1.5 * risk), 2.5 * risk)
    else:
        extreme = val if side == 1 else vah
        risk = min(max(abs(price - extreme) + away, 0.5 * a), 1.5 * a)
        edges = ([r["bot"] - price for r in rows if r["bot"] > price] if side == 1
                 else [price - r["top"] for r in rows if r["top"] < price])
        edges = sorted(d for d in edges if d > 0)
        tp1_d = risk
        tp2_d = next((d for d in edges if d >= 1.4 * risk), 2.6 * risk)
        tp2_d = min(max(tp2_d, 1.5 * risk), 2.5 * risk)

    if risk <= 0:
        out.update({"type": "HOLD", "reason": "degenerate risk"})
        return out

    entry, sl = price, price - side * risk
    tp1, tp2 = price + side * tp1_d, price + side * tp2_d
    _entry, _sl = round(entry, 2), round(sl, 2)
    _tp1, _tp2 = round(tp1, 2), round(tp2, 2)
    _risk = abs(_entry - _sl) or risk
    if (_tp2 - _entry) * side <= (_tp1 - _entry) * side:      # TP2 can never sit behind TP1
        _tp2 = round(_entry + side * max(abs(_tp1 - _entry) * 1.4, _risk * 1.4), 2)
    _r = round(abs(_tp2 - _entry) / _risk, 2)
    _r1 = round(abs(_tp1 - _entry) / _risk, 2)

    conf = 55
    if "reject" in style:
        conf += 8
    if "absorbed" in style:
        conf += 10
    if abs(d_ratio) >= 0.25:
        conf += 8
    if (side == 1 and above_vwap) or (side == -1 and below_vwap):
        conf += 6
    if row_strength >= 0.5:
        conf += 4
    conf = min(92, conf)

    where = f"VAL {val:.2f}" if side == 1 else f"VAH {vah:.2f}"
    out.update({
        "type": "BUY" if side == 1 else "SELL",
        "entry": _entry, "sl": _sl, "tp1": _tp1, "tp2": _tp2,
        "risk": round(_risk, 2), "r": _r, "confidence": conf,
        "style": style,
        "reason": (f"{style} · {where} · delta {d_ratio*100:+.0f}% over 6 bars · "
                   f"stop {abs(_sl-_entry):.2f} ({_risk/a:.1f} ATR) · "
                   f"tp1 {_r1:.1f}R · tp2 {_r:.1f}R"),
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
    va = value_area(cl, poc)
    sig = signal(candles, vwap, cl, poc, atr, min_pct, vwap_series(candles), va=va)
    return {"status": "ok", "vwap_series": vwap_series(candles[-180:]),
            "vwap": round(vwap, 2) if vwap else None,
            "vwap_bars": used, "rows": cl, "poc": poc,
            "value_area": va, "row_size": step,
            "signal": sig, "atr": round(atr, 2) if atr else None,
            "bars": n}
