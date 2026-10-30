"""
RENDER zone engine — a faithful Python port of the Pine Script RENDER indicator.

Rules (same as the indicator, no invention):
  · zones are born from CONFIRMED pivots only (kSwing bars each side)
  · a zone needs a real impulse away from the pivot (impAtr x ATR) within 48 bars
  · zone height must be <= zoneAtr x ATR
  · a "bounce" only counts if price travels bounceAtr x ATR in the rejection
    direction BEFORE the zone breaks - closed bars only, timeouts excluded
  · green box under price = demand = BUY   ·   red box above price = supply = SELL

Everything here is computed from the candle series passed in. No estimates.
"""
from __future__ import annotations


def atr_series(candles, n=14):
    """Wilder ATR, same as ta.atr(14)."""
    m = len(candles)
    out = [None] * m
    if m < 2:
        return out
    tr = []
    for i, c in enumerate(candles):
        if i == 0:
            tr.append(c["high"] - c["low"])
        else:
            pc = candles[i - 1]["close"]
            tr.append(max(c["high"] - c["low"], abs(c["high"] - pc), abs(c["low"] - pc)))
    if m < n:
        return out
    prev = sum(tr[:n]) / n
    out[n - 1] = prev
    for i in range(n, m):
        prev = (prev * (n - 1) + tr[i]) / n
        out[i] = prev
    return out


def find_pivots(candles, k=3):
    """Confirmed pivots. A pivot at bar p is only known at bar p+k."""
    highs, lows = [], []
    m = len(candles)
    for p in range(k, m - k):
        hl = [candles[j]["high"] for j in range(p - k, p)]
        hr = [candles[j]["high"] for j in range(p + 1, p + k + 1)]
        h = candles[p]["high"]
        if h >= max(hl) and h >= max(hr) and (h > max(hl) or h > max(hr)):
            highs.append(p)
        ll = [candles[j]["low"] for j in range(p - k, p)]
        lr = [candles[j]["low"] for j in range(p + 1, p + k + 1)]
        l = candles[p]["low"]
        if l <= min(ll) and l <= min(lr) and (l < min(ll) or l < min(lr)):
            lows.append(p)
    return highs, lows


def _box(candles, p, span=3):
    """Zone edges = high/low envelope of the pivot bar and the two after it."""
    hi = [candles[j]["high"] for j in range(p, min(p + span, len(candles)))]
    lo = [candles[j]["low"] for j in range(p, min(p + span, len(candles)))]
    return max(hi), min(lo)


def build_zones(candles, k=3, imp_atr=1.8, zone_atr=2.0, sl_buf=0.15,
                bounce_atr=1.0, weak_after=2, max_age=500, max_impulse_bars=48,
                eval_window=30):
    """Return every zone that was ever born, with its measured outcome."""
    atr = atr_series(candles, 14)
    m = len(candles)
    if m < k * 2 + 15:
        return [], atr
    highs, lows = find_pivots(candles, k)

    events = sorted([(p + k, "H", p) for p in highs] + [(p + k, "L", p) for p in lows])
    pending_h, pending_l = [], []
    born = []

    for confirm_i, kind, p in events:
        a = atr[p]
        if a is None or a <= 0 or p + 2 >= m:
            continue
        top, bot = _box(candles, p)
        if top <= bot:
            continue
        if kind == "H":  # a pivot high can complete a demand zone from an older low
            for (lp, lval, latr, ltop, lbot) in list(pending_l):
                impulse = candles[p]["high"] - lval
                if (p - lp <= max_impulse_bars and impulse >= imp_atr * latr
                        and (ltop - lbot) <= zone_atr * latr and ltop > lbot):
                    born.append({"side": 1, "top": ltop, "bot": lbot,
                                 "pivot_i": lp, "created_i": confirm_i,
                                 "atr0": latr, "born_price": candles[p]["high"]})
                pending_l.remove((lp, lval, latr, ltop, lbot))
            pending_h.append((p, candles[p]["high"], a, top, bot))
        else:  # a pivot low can complete a supply zone from an older high
            for (hp, hval, hatr, htop, hbot) in list(pending_h):
                impulse = hval - candles[p]["low"]
                if (p - hp <= max_impulse_bars and impulse >= imp_atr * hatr
                        and (htop - hbot) <= zone_atr * hatr and htop > hbot):
                    born.append({"side": -1, "top": htop, "bot": hbot,
                                 "pivot_i": hp, "created_i": confirm_i,
                                 "atr0": hatr, "born_price": candles[p]["low"]})
                pending_h.remove((hp, hval, hatr, htop, hbot))
            pending_l.append((p, candles[p]["low"], a, top, bot))

    # ---- walk each zone forward over closed bars only ----
    for z in born:
        side, zt, zb = z["side"], z["top"], z["bot"]
        touches = 0
        in_zone = False
        first_touch_i = None
        ev_start = ev_target = ev_break = None
        outcome = None          # "held" | "broke" | "timeout"
        outcome_i = None
        ev_touch_n = 0
        touch_out = []          # (touch_number, outcome) — the measured cohort

        broken_i = None
        expired_i = None
        for i in range(z["created_i"] + 1, m):
            c = candles[i]
            a = atr[i] or z["atr0"]
            if a <= 0:
                a = z["atr0"]
            # resolve an open evaluation first (target before break => held)
            if ev_start is not None and i > ev_start:
                resolved = None
                if side == 1:
                    if c["low"] <= ev_break:
                        resolved = "broke"
                    elif c["high"] >= ev_target:
                        resolved = "held"
                else:
                    if c["high"] >= ev_break:
                        resolved = "broke"
                    elif c["low"] <= ev_target:
                        resolved = "held"
                if resolved is None and i - ev_start > eval_window:
                    resolved = "timeout"
                if resolved is not None:
                    outcome, outcome_i, ev_start = resolved, i, None
                    if resolved in ("held", "broke"):
                        touch_out.append((ev_touch_n, resolved))
            touching = (c["low"] <= zt and c["close"] >= zb) if side == 1 else (c["high"] >= zb and c["close"] <= zt)
            if touching and not in_zone:
                touches += 1
                if first_touch_i is None:
                    first_touch_i = i
                broken_now = (c["low"] < zb - sl_buf * a) if side == 1 else (c["high"] > zt + sl_buf * a)
                if not broken_now and ev_start is None:
                    ev_start = i
                    ev_touch_n = touches
                    ev_target = (zt + bounce_atr * a) if side == 1 else (zb - bounce_atr * a)
                    ev_break = (zb - sl_buf * a) if side == 1 else (zt + sl_buf * a)
            in_zone = touching
            # zone death
            if (c["low"] < zb - sl_buf * a) if side == 1 else (c["high"] > zt + sl_buf * a):
                broken_i = i
                break
            if i - z["created_i"] > max_age:
                expired_i = i
                break
        z.update({"touch_out": touch_out, "touches": touches, "first_touch_i": first_touch_i,
                  "outcome": outcome, "outcome_i": outcome_i,
                  "broken_i": broken_i, "expired_i": expired_i,
                  "alive": broken_i is None and expired_i is None})
    born.sort(key=lambda z: z["created_i"])
    return born, atr


def cohort_stats(zones):
    """Measured hold rate by touch number (1st / 2nd / 3rd+), per side."""
    def bucket(tn):
        return 0 if tn <= 1 else (1 if tn == 2 else 2)
    w = [[0, 0, 0], [0, 0, 0]]
    n = [[0, 0, 0], [0, 0, 0]]
    for z in zones:
        si = 0 if z["side"] == 1 else 1
        for t_n, res in z.get("touch_out", []):
            b = bucket(t_n)
            n[si][b] += 1
            if res == "held":
                w[si][b] += 1
    return w, n


def signal_now(candles, zones, atr, tp1_r=0.75, tp2_r=1.5, sl_buf=0.15, max_zones=30):
    """
    The strategy the desk asked for:
        price inside a GREEN box  -> BUY   (demand is being tested)
        price inside a RED box    -> SELL  (supply is being tested)
    Nothing else fires. Otherwise HOLD with the nearest boxes as the road map.
    """
    if not candles:
        return {"type": "HOLD", "reason": "no candles"}
    last = candles[-1]
    close = last["close"]
    a = atr[-1] or 0
    live = [z for z in zones if z["alive"]][-max_zones:]
    w, n = cohort_stats(zones)

    def held(side, tn):
        b = 0 if tn <= 1 else (1 if tn == 2 else 2)
        si = 0 if side == 1 else 1
        if n[si][b] == 0:
            return None
        return round(100.0 * w[si][b] / n[si][b])

    hit = None
    for z in live:
        zt, zb = z["top"], z["bot"]
        inside = (last["low"] <= zt and close >= zb) if z["side"] == 1 else (last["high"] >= zb and close <= zt)
        if inside:
            hit = z  # prefer the most recent zone
    if hit is None:
        for z in reversed(live):
            zt, zb = z["top"], z["bot"]
            if z["side"] == 1 and last["low"] <= zt and zb <= last["low"]:
                hit = z
                break
            if z["side"] == -1 and last["high"] >= zb and zt >= last["high"]:
                hit = z
                break

    above = [z for z in live if z["bot"] >= close]
    below = [z for z in live if z["top"] <= close]
    next_up = min(above, key=lambda z: z["bot"]) if above else None
    next_dn = max(below, key=lambda z: z["top"]) if below else None

    out = {
        "price": close, "atr": round(a, 2) if a else None,
        "zones_live": len(live),
        "next_up": None, "next_dn": None,
        "stats": {"demand": {"held": w[0], "n": n[0]}, "supply": {"held": w[1], "n": n[1]}},
    }
    if next_up:
        out["next_up"] = {"top": next_up["top"], "bot": next_up["bot"], "touches": next_up["touches"],
                          "dist_atr": round((next_up["bot"] - close) / a, 2) if a else None}
    if next_dn:
        out["next_dn"] = {"top": next_dn["top"], "bot": next_dn["bot"], "touches": next_dn["touches"],
                          "dist_atr": round((close - next_dn["top"]) / a, 2) if a else None}

    if hit is None:
        parts = []
        if next_up and a:
            parts.append(f"next red box {next_up['bot']:.2f} ({(next_up['bot'] - close) / a:.1f} ATR up)")
        elif next_up:
            parts.append(f"next red box {next_up['bot']:.2f}")
        if next_dn and a:
            parts.append(f"next green box {next_dn['top']:.2f} ({(close - next_dn['top']) / a:.1f} ATR down)")
        elif next_dn:
            parts.append(f"next green box {next_dn['top']:.2f}")
        out.update({"type": "HOLD", "zone": None,
                    "reason": "Price is between the boxes — no trade until it reaches one."
                              + (" · " + " · ".join(parts) if parts else "")})
        return out

    side = hit["side"]
    zt, zb = hit["top"], hit["bot"]
    kind = "Demand (green)" if side == 1 else "Supply (red)"
    held_pct = held(side, hit["touches"])
    entry = close
    sl = (zb - sl_buf * a) if side == 1 else (zt + sl_buf * a)
    risk = abs(entry - sl)
    tp1 = entry + side * tp1_r * risk
    tp2 = entry + side * tp2_r * risk
    out.update({
        "type": "BUY" if side == 1 else "SELL",
        "zone": {"side": side, "top": zt, "bot": zb, "touches": hit["touches"]},
        "entry": round(entry, 2), "sl": round(sl, 2),
        "tp1": round(tp1, 2), "tp2": round(tp2, 2),
        "risk": round(risk, 2),
        "held_pct": held_pct,
        "confidence": held_pct if held_pct is not None else 60,
        "reason": (f"{kind} box {zb:.2f}–{zt:.2f} · touch #{hit['touches']}"
                   + (f" · this box type held {held_pct}% of the time" if held_pct is not None else "")),
    })
    return out


def analyse(candles, tf="M15"):
    zones, atr = build_zones(candles)
    sig = signal_now(candles, zones, atr)
    last_t = candles[-1]["time"] if candles else 0
    live = [z for z in zones if z["alive"]][-30:]
    out_zones = []
    for z in live:
        t1 = candles[z["pivot_i"]]["time"] if z["pivot_i"] < len(candles) else last_t
        out_zones.append({
            "side": "demand" if z["side"] == 1 else "supply",
            "top": round(z["top"], 2), "bot": round(z["bot"], 2),
            "from": int(t1), "touches": z["touches"],
            "state": "WEAK" if z["touches"] >= 2 else ("TESTED" if z["touches"] else "FRESH"),
            "held": z["outcome"] == "held",
            "first": z["pivot_i"],
        })
    w, n = cohort_stats(zones)
    return {
        "status": "ok", "tf": tf, "zones": out_zones, "signal": sig,
        "measured": {
            "demand": [{"held": w[0][i], "n": n[0][i]} for i in range(3)],
            "supply": [{"held": w[1][i], "n": n[1][i]} for i in range(3)],
            "zones_total": len(zones),
            "zones_live": len(live),
        },
    }


def _ema(vals, n):
    if not vals:
        return None
    k = 2.0 / (n + 1)
    e = vals[0]
    for v in vals[1:]:
        e = v * k + e * (1 - k)
    return e


def _rsi(vals, n=14):
    if len(vals) < n + 1:
        return None
    g = l = 0.0
    for i in range(1, n + 1):
        d = vals[i] - vals[i - 1]
        g += d if d > 0 else 0
        l += -d if d < 0 else 0
    g /= n
    l /= n
    for i in range(n + 1, len(vals)):
        d = vals[i] - vals[i - 1]
        g = (g * (n - 1) + (d if d > 0 else 0)) / n
        l = (l * (n - 1) + (-d if d < 0 else 0)) / n
    if l == 0:
        return 100.0
    rs = g / l
    return 100 - 100 / (1 + rs)


def layers(candles, atr, zones, sig):
    """The five layers, all measured from the same closed candles."""
    closes = [c["close"] for c in candles]
    e9, e21 = _ema(closes, 9), _ema(closes, 21)
    r = _rsi(closes, 14)
    macd = (_ema(closes, 12) or 0) - (_ema(closes, 26) or 0)
    a_now = atr[-1]
    hist = [a for a in atr if a]
    regime, pct_rank = "—", None
    if a_now and hist:
        lo = min(hist)
        hi = max(hist)
        pct_rank = round(100.0 * (a_now - lo) / (hi - lo)) if hi > lo else 50
        regime = "QUIET" if pct_rank < 30 else ("WILD" if pct_rank > 70 else "NORMAL")
    highs, lows = find_pivots(candles, 3)
    struct = "—"
    if len(highs) >= 2 and len(lows) >= 2:
        hh = candles[highs[-1]]["high"] > candles[highs[-2]]["high"]
        hl = candles[lows[-1]]["low"] > candles[lows[-2]]["low"]
        struct = "up (HH/HL)" if hh and hl else ("down (LH/LL)" if not hh and not hl else "range")
    import datetime as _dt
    hour = _dt.datetime.utcfromtimestamp(candles[-1]["time"]).hour if candles else 0
    z = sig.get("zone")
    zone_txt = "—"
    zone_note = "between the boxes"
    if z:
        zone_txt = f"{'demand' if z['side'] == 1 else 'supply'} {z['bot']:.2f}–{z['top']:.2f}"
        zone_note = f"touch #{z['touches']}"
    return [
        {"k": "zone", "label": "Zone", "value": zone_txt, "note": zone_note},
        {"k": "trend", "label": "Trend", "value": struct,
         "note": f"EMA9 {e9:.2f} · EMA21 {e21:.2f}" if e9 and e21 else ""},
        {"k": "momentum", "label": "Momentum", "value": f"RSI {r:.1f}" if r else "—",
         "note": f"MACD {macd:+.2f}"},
        {"k": "volatility", "label": "Volatility", "value": regime,
         "note": f"ATR {a_now:.2f}" + (f" · {pct_rank}th pct" if pct_rank is not None else "") if a_now else ""},
        {"k": "session", "label": "Session", "value": f"{hour:02d}:00 UTC",
         "note": "dead zone (21–01)" if (hour >= 21 or hour < 1) else "active"},
    ]
