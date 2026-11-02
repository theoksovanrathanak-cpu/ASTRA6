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


# ---------------- live buyer / seller tape ----------------
# Spot gold quotes carry no aggressor flag, so the tape classifies each REAL quote the
# standard way: at/above the ask = a buyer lifting the offer, at/below the bid = a seller
# hitting the bid; with no book, an up-tick counts as a buy and a down-tick as a sell.
# It counts quotes, not contracts - the API and the UI both say so.
import collections as _collections
_TAPE = _collections.deque(maxlen=8000)
_TAPE_LAST = {"price": None, "side": 1}


def tape_add(price, bid=None, ask=None, ts=None):
    """Feed one real quote into the live tape. Never called with an invented price."""
    import time as _t
    try:
        p = float(price)
    except Exception:
        return False
    if not p or p != p or p <= 0:
        return False
    t = float(ts or _t.time())
    side = None
    try:
        b, a = float(bid or 0), float(ask or 0)
    except Exception:
        b = a = 0.0
    if a > b > 0:
        if p >= a:
            side = 1
        elif p <= b:
            side = -1
    if side is None:
        # no book: a rise is a buyer, a fall is a seller, and a repeat carries no
        # new information at all - it is skipped instead of being counted as either
        prev = _TAPE_LAST.get("price")
        if prev is None:
            _TAPE_LAST["price"] = p
            return False
        if p > prev:
            side = 1
        elif p < prev:
            side = -1
        else:
            return False
    if _TAPE and t - _TAPE[-1][0] < 1.0 and abs(p - _TAPE[-1][1]) < 1e-9:
        return False
    _TAPE_LAST["price"] = p
    _TAPE_LAST["side"] = side
    _TAPE.append((t, p, side))
    return True


def tape_read(window_s=300, now=None):
    """Buyer vs seller over the last `window_s`, counted from real quotes."""
    import time as _t
    now = float(now or _t.time())
    w = int(max(30, min(3600, int(window_s or 300))))
    cut = now - w
    rows = [x for x in _TAPE if x[0] >= cut]
    buys = sum(1 for x in rows if x[2] > 0)
    sells = sum(1 for x in rows if x[2] < 0)
    n = buys + sells
    prices = [x[1] for x in rows]
    return {
        "window_s": w,
        "samples": n,
        "buy": buys,
        "sell": sells,
        "buy_pct": round(100.0 * buys / n, 1) if n else None,
        "last_side": ("buy" if _TAPE_LAST["side"] > 0 else "sell") if _TAPE_LAST["price"] else None,
        "last_price": _TAPE_LAST["price"],
        "first": int(rows[0][0]) if rows else None,
        "last": int(rows[-1][0]) if rows else None,
        "hi": round(max(prices), 2) if prices else None,
        "lo": round(min(prices), 2) if prices else None,
        "method": "quote ticks - bid/ask rule (tick rule when the venue gives no book)",
        "unit": "quotes",
        "estimated": True,
        "note": "counts of real quotes, not contracts",
        "warming": n < 20,
    }


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


def profile_window(candles, tf_minutes=15, max_bars=None):
    """The bars that make up the CURRENT trading session's volume profile.

    A profile built across a weekend gap is not a profile: Friday's range and
    Sunday's range are two different auctions, and mixing them pushes the value
    area so wide that price is always "inside value" and the strategy can never
    print. This walks back from the newest bar and stops at the first real hole
    in the tape (a break longer than three intervals, e.g. the daily close, the
    weekend, a feed outage), then caps the window at roughly one day of bars.

    Nothing here changes a single price - it only decides which real bars the
    profile is measured on.
    """
    if not candles:
        return []
    tf = int(tf_minutes or 15)
    s = max(60, tf * 60)
    if max_bars is None:
        max_bars = max(24, min(240, int((24 * 60) / max(tf, 1))))
    out = list(candles[-max_bars:])
    if len(out) < 2:
        return out
    start = 0
    for i in range(len(out) - 1, 0, -1):
        gap = int(out[i]["time"]) - int(out[i - 1]["time"])
        if gap > 3 * s:
            start = i
            break
    return out[start:]


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


# How far past its own level a setup may be and still be that setup rather than a chase.
# A rejection that prints 1.5 ATR above VAL is not a rejection any more - the trade lives
# at the level. Acceptance is different by nature: price is *meant* to be beyond VAH, so
# it is allowed further before the entry stops being the trade and starts being the tail.
FRESH_LIM_ATR = {"reject": 1.20, "accept": 1.20}
FRESH_RISK_MULT = 0.80      # the level must sit inside the risk the trade would take


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

    # ---- is the level still where the trade is? ------------------------------------
    # A "reject VAL" printed when price is already 1.5 ATR above VAL is not a rejection:
    # it is a chase, and it goes underwater the moment it prints. The trade lives at the
    # level, so the level has to still be within reach of the bar that claims it.
    if side:
        edge = (vah if side == 1 else val) if "accept" in style else (val if side == 1 else vah)
        dist = abs(price - edge)
        out["level_dist_atr"] = round(dist / a, 2) if a else None
        if "accept" in style:
            # a breakout trade lives just beyond the edge; further out than this and the
            # entry is the tail of the move, not the move
            fresh = dist <= FRESH_LIM_ATR["accept"] * a
        else:
            # measured against the risk the trade itself would take: the level has to be
            # inside that risk, not a distant memory behind price
            _ext = wlow if side == 1 else whigh
            _raw = abs(price - (_ext - side * away)) or a
            fresh = dist <= FRESH_RISK_MULT * _raw and dist <= FRESH_LIM_ATR["reject"] * a
        if not fresh:
            out.update({"type": "HOLD",
                        "stale_setup": {"type": "BUY" if side == 1 else "SELL", "style": style,
                                        "edge": round(edge, 2), "dist_atr": round(dist / a, 2)},
                        "reason": (f"{style} fired but price is already {dist/a:.1f} ATR from "
                                   f"{'VAH' if edge == vah else 'VAL'} {edge:.2f} - the move ran "
                                   f"without it. A trade here is a chase, so it waits for price "
                                   f"to come back to the level.")})
            return out

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

    # A first target at a full 1R is a coin flip that spends most of its life underwater:
    # measured on 800 real 5m and 300 real 15m bars, the same trades reached 0.85R far more
    # often (56% and 68%) than 1R (52%), and sat in less drawdown on the way. TP1 is the
    # "get out of the red" target; TP2 stays the structural one.
    tp1_d = min(tp1_d, 0.85 * risk)
    if tp2_d <= tp1_d * 1.15:
        tp2_d = max(tp2_d, tp1_d * 1.6)

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


def _median(v):
    v = sorted(v)
    n = len(v)
    if not n:
        return None
    m = n // 2
    return v[m] if n % 2 else (v[m - 1] + v[m]) / 2.0


def _mad(v, med):
    if med is None or not v:
        return 0.0
    return _median([abs(x - med) for x in v]) * 1.4826


def verify(candles, atr=None, va=None, quote=None, tf_minutes=15,
           market_open=True, min_bars=60, now=None):
    """PRICE LOCK — verify the price before the strategy is allowed to act on it.

    The strategy can only be as right as the price it is reading. Every layer is
    checked and the answer is binary: either the tape is provably coherent and a
    BUY/SELL may be printed, or it is not and the strip is forced to HOLD with the
    failing reason attached. Nothing here claims a trade cannot lose money - it
    stops a trade being taken on a wrong, stale or contradicting price.

    Checks (block = the read is withheld):
      history   enough bars for a value area to mean anything           block
      tape      high>=low, close inside the bar's range, volume>0       block
      dupes     unique, ascending timestamps                            block
      fresh     last bar is younger than ~2 bars of the timeframe        block (open market)
      tick      live quote agrees with the newest bar's close            block
      spread    bid<ask and the spread is not absurd                    block
      spike     last close is not a lone outlier vs the last 20         block
      scale     price sits inside the visible range (catches decimal slips) block
    """
    out = {"ok": True, "checks": [], "blocked_by": [], "warned": [], "px": None}
    now = now or __import__("time").time()

    def add(cid, ok, label, val="", warn=False, fail_label=None):
        # `label` says what passed; `fail_label` says what actually went wrong. A reader who
        # sees "price lock: newest bar is from the live tape" while nothing prints has been
        # told the opposite of the truth.
        grade = "ok" if ok else ("warn" if warn else "block")
        out["checks"].append({"id": cid, "ok": bool(ok), "grade": grade,
                              "label": label, "val": val,
                              "fail": (None if ok else (fail_label or label))})
        if grade == "block":
            out["blocked_by"].append(fail_label or label)
        elif grade == "warn":
            out["warned"].append(fail_label or label)

    if not candles:
        add("history", False, "no bars at all")
        out["ok"] = False
        return out

    px = float(candles[-1]["close"])
    out["px"] = round(px, 6)

    # ---- 1. history
    n = len(candles)
    add("history", n >= min_bars, "%d bars in the profile" % n,
        "%s%d bars" % ("" if n >= min_bars else "of %d needed · " % min_bars, n))

    # ---- 2. tape integrity: a corrupted bar is worse than no bar
    bad = 0
    for c in candles[-120:]:
        try:
            hi, lo, cl, vol = float(c["high"]), float(c["low"]), float(c["close"]), float(c.get("volume") or 0)
        except Exception:
            bad += 1
            continue
        if hi < lo or cl > hi * 1.0005 or cl < lo * 0.9995 or vol < 0:
            bad += 1
    add("tape", bad == 0, "%d odd bars in the last 120" % bad if bad else "every bar is well formed",
        "" if bad == 0 else "%d bad" % bad)

    # ---- 3. timestamps
    ts = [int(c.get("time") or 0) for c in candles]
    dupes = len(ts) - len(set(ts))
    ordered = all(ts[i] >= ts[i - 1] for i in range(1, len(ts)))
    add("dupes", dupes == 0 and ordered,
        "bars are unique and in order" if dupes == 0 and ordered else "duplicate or out-of-order bars",
        "" if dupes == 0 and ordered else "%d dupes" % dupes)

    # ---- 4. freshness
    age = max(0.0, now - float(ts[-1])) if ts else 0.0
    if not market_open:
        add("fresh", True, "market closed · last real bar is the close",
            "%.0f h old" % (age / 3600.0) if age > 3600 else "%.0f min old" % (age / 60.0))
    else:
        # The newest bar is a CLOSED bar: it is normal for it to be up to one interval old,
        # and a feed that posts a bar a little late is still the live tape. Beyond three
        # intervals nothing is trading on it, and the tick check below is the second guard
        # (a stale tape whose price has moved away is refused there).
        # a one-minute chart must not be called dead because the feed posts a slower bar;
        # twenty minutes is the floor for any timeframe
        soft = max(300.0, tf_minutes * 60 * 2.0 + 120)
        hard = max(1200.0, tf_minutes * 60 * 3.0 + 300)
        ok = age <= hard
        add("fresh", ok, "newest bar is from the live tape",
            "%.0f min old" % (age / 60.0),
            warn=(ok and age > soft),
            fail_label="newest bar is %.0f min old · the feed has gone quiet (limit %.0f min)"
                       % (age / 60.0, hard / 60.0))

    # ---- 5. does the live quote agree with the newest bar?
    qpx = None
    if isinstance(quote, dict):
        qpx = quote.get("price") if quote.get("price") is not None else quote.get("mid")
    try:
        qpx = float(qpx) if qpx is not None else None
    except Exception:
        qpx = None
    if qpx is None or qpx <= 0:
        add("tick", False, "no live quote to cross-check the bar against", "chart only", warn=True)
    else:
        a = float(atr) if atr else max(px * 0.0005, 1e-9)
        gap = abs(qpx - px)
        tol = max(3.0 * a, px * 0.004)
        out["quote_px"] = round(qpx, 6)
        out["gap"] = round(gap, 6)
        add("tick", gap <= tol, "live quote agrees with the newest bar",
            "%.2f gap (limit %.2f)" % (gap, tol),
            fail_label="live quote is %.2f away from the newest close (limit %.2f)" % (gap, tol))

    # ---- 6. spread / crossed book
    if isinstance(quote, dict) and quote.get("bid") is not None and quote.get("ask") is not None:
        try:
            bid, ask = float(quote["bid"]), float(quote["ask"])
            mid = qpx or ((bid + ask) / 2.0)
            spread = ask - bid
            rel = spread / mid if mid else 1.0
            add("spread", bid > 0 and ask > bid and rel <= 0.0035,
                "book is not crossed and the spread is tight",
                "%.4f%% spread" % (rel * 100.0),
                fail_label="the book is crossed or the spread is %.3f%% wide" % (rel * 100.0))
        except Exception:
            add("spread", False, "book could not be read", "bid/ask unreadable")
    else:
        add("spread", True, "single-print feed · no book to cross", "n/a", warn=True)

    # ---- 7. outlier: one bad print must not become a signal
    prev = [float(c["close"]) for c in candles[-21:-1]]
    if len(prev) >= 8:
        med = _median(prev)
        dev = abs(px - med)
        mad = _mad(prev, med)
        a = float(atr) if atr else max(px * 0.0005, 1e-9)
        lim = max(6.0 * mad, 4.0 * a)
        add("spike", dev <= lim, "newest close is not a lone outlier",
            "%.2f from the 20-bar median (limit %.2f)" % (dev, lim),
            fail_label="newest close is %.2f from the 20-bar median (limit %.2f) - one print, not a move"
                       % (dev, lim))
    else:
        add("spike", True, "too few bars to test for a spike", "skipped", warn=True)

    # ---- 8. scale sanity: a price outside the visible range is a broken feed, not a move
    los = [float(c["low"]) for c in candles[-120:]]
    his = [float(c["high"]) for c in candles[-120:]]
    lo, hi = min(los), max(his)
    span = (hi - lo) or 1e-9
    pad = span * 0.15
    add("scale", (lo - pad) <= px <= (hi + pad), "price sits inside the range on screen",
        "%.2f in %.2f–%.2f" % (px, lo, hi),
        fail_label="price %.2f is outside the %.2f–%.2f range on screen - a decimal slip in the feed"
                   % (px, lo, hi))

    out["ok"] = not out["blocked_by"]
    out["grade"] = "ok" if out["ok"] and not out["warned"] else ("warn" if out["ok"] else "blocked")
    return out


def _atr_of(win, n=14):
    trs = []
    for i in range(1, len(win)):
        c, p = win[i], win[i - 1]
        trs.append(max(c["high"] - c["low"], abs(c["high"] - p["close"]), abs(c["low"] - p["close"])))
    return sum(trs[-n:]) / len(trs[-n:]) if trs else None


def reads_history(candles, n=16, rows=48, min_pct=10.0, window=150, tf_minutes=15):
    """The same rule table, replayed on the last `n` bars.

    It is not a backtest and claims nothing about money: it answers one question a
    reader actually asks - "when did this strategy last print a trade, and what was it
    looking at in between?" Each entry is the read as it stood at that bar's close,
    with the setup that fired (if any). Nothing here is simulated forward.
    """
    out = []
    if not candles or len(candles) < 60:
        return out
    W = min(window, len(candles))
    start = max(59, len(candles) - max(1, n))
    for i in range(start, len(candles)):
        # an older read is measured on the window that existed then, never on bars
        # from the future
        win = candles[max(0, i - W + 1):i + 1]
        if len(win) < 60:
            continue
        try:
            vwap, _used = daily_vwap(win)
            cl, poc, _step = clusters(profile_window(win, tf_minutes), rows, min_pct)
            a = _atr_of(win)
            va = value_area(cl, poc)
            sg = signal(win, vwap, cl, poc, a, min_pct, vwap_series(win), va=va)
        except Exception:
            continue
        out.append({"time": int(win[-1]["time"]), "price": round(float(win[-1]["close"]), 2),
                    "type": sg.get("type") or "HOLD", "style": sg.get("style") or "",
                    "reason": (sg.get("reason") or "")[:140]})
    return out


def analyse(candles, rows=48, min_pct=10.0, bias_from="5m", verify_quote=None,
            tf_minutes=15, market_open=True, min_bars=60):
    """Full pass: split -> vwap -> clusters -> signal."""
    if not candles:
        return {"status": "error", "error": "no candles"}
    vwap, used = daily_vwap(candles)
    # the profile is measured on the running session only (see profile_window);
    # ATR and the flow window still read the longer tape, which is what they are for
    prof = profile_window(candles, tf_minutes)
    cl, poc, step = clusters(prof, rows, min_pct)
    n = len(candles)
    trs = []
    for i in range(1, n):
        c, p = candles[i], candles[i - 1]
        trs.append(max(c["high"] - c["low"], abs(c["high"] - p["close"]), abs(c["low"] - p["close"])))
    atr = sum(trs[-14:]) / len(trs[-14:]) if trs else None
    va = value_area(cl, poc)
    sig = signal(candles, vwap, cl, poc, atr, min_pct, vwap_series(candles), va=va)
    sig["profile"] = {"scope": "session", "bars": len(prof),
                      "from": int(prof[0]["time"]) if prof else None,
                      "to": int(prof[-1]["time"]) if prof else None,
                      "tf_minutes": int(tf_minutes or 15)}

    # ---- PRICE LOCK: nothing is allowed to trade on a price we cannot prove ----
    ver = verify(candles, atr=atr, va=va, quote=verify_quote, tf_minutes=tf_minutes,
                 market_open=market_open, min_bars=min_bars)
    # A closed market is its own kind of wrong price: a setup struck on Friday's
    # last bar fills after a weekend gap at a price nobody traded. The read keeps
    # describing the tape, but it may not print a trade on it.
    if not market_open and sig.get("type") in ("BUY", "SELL"):
        ver["checks"].append({"id": "session", "ok": False, "grade": "block",
                              "label": "market is open when the trade would print",
                              "val": "closed · a setup here would fill through the gap"})
        ver["blocked_by"].append("market is closed — the entry would fill through the next open")
        ver["ok"] = False
        ver["grade"] = "blocked"

    sig = dict(sig or {})
    sig["verified"] = bool(ver["ok"])
    if not ver["ok"]:
        if sig.get("type") in ("BUY", "SELL"):
            sig["blocked"] = {"type": sig.get("type"), "entry": sig.get("entry"),
                              "sl": sig.get("sl"), "tp1": sig.get("tp1"),
                              "tp2": sig.get("tp2"), "price": sig.get("price")}
        sig["type"] = "HOLD"
        sig["lock"] = ver["blocked_by"]
        sig["reason"] = "HOLD — price lock: " + "; ".join(ver["blocked_by"][:2])
    out_ver = ver

    # ---- the full order flow: every bar's aggression and the running total ----
    # Each bar carries buy/sell (real taker split where the feed has it, close-location
    # estimate otherwise - the API already says which). Cumulative delta is the sum:
    # buyers lifting offers minus sellers hitting bids, from the session open to now.
    dser, cvd = [], 0.0
    for c in candles:
        b = c.get("buy")
        sl_ = c.get("sell")
        if b is None or sl_ is None:
            vol = float(c.get("volume") or 0)
            hi, lo, cl_ = float(c["high"]), float(c["low"]), float(c["close"])
            rng = (hi - lo) or 1e-9
            b = vol * (cl_ - lo) / rng
            sl_ = vol - b
        d = float(b) - float(sl_)
        cvd += d
        dser.append({"time": int(c["time"]), "buy": round(float(b), 4),
                     "sell": round(float(sl_), 4), "delta": round(d, 4),
                     "volume": round(float(c.get("volume") or 0), 4),
                     "cvd": round(cvd, 4)})

    # unbalanced rows: one side clearly dominant at that price = a level worth knowing
    imb = []
    for r in cl:
        tot = r["total"] or 1e-9
        share = r["delta"] / tot
        if abs(share) >= 0.35 and r["total"] >= (poc["total"] * 0.15 if poc else 0):
            imb.append({"bot": r["bot"], "top": r["top"], "delta": r["delta"],
                        "side": "buy" if share > 0 else "sell",
                        "share": round(share, 3), "total": r["total"]})
    imb = sorted(imb, key=lambda x: -abs(x["share"]))[:8]

    tot_buy = sum(x["buy"] for x in dser)
    tot_sell = sum(x["sell"] for x in dser)
    # when did this thing last print a trade? the reader deserves an answer, and it is
    # also the fastest way to tell "the strategy is broken" from "the strategy is waiting"
    reads = []
    try:
        reads = reads_history(candles, n=16, rows=rows, min_pct=min_pct)
    except Exception as _re:
        print("reads history", _re)
    last_trade = None
    for r in reversed(reads):
        if r.get("type") in ("BUY", "SELL"):
            last_trade = r
            break

    return {"status": "ok", "vwap_series": vwap_series(candles[-180:]),
            "reads": reads, "last_trade": last_trade,
            "reads_window": len(reads),
            "vwap": round(vwap, 2) if vwap else None,
            "vwap_bars": used, "rows": cl, "poc": poc,
            "value_area": va, "row_size": step,
            "signal": sig, "verify": out_ver,
            "atr": round(atr, 2) if atr else None,
            "bars": n,
            "delta_series": dser[-300:],
            "cvd": round(cvd, 2),
            "buy_total": round(tot_buy, 2), "sell_total": round(tot_sell, 2),
            "delta_total": round(tot_buy - tot_sell, 2),
            "imbalance": imb}
