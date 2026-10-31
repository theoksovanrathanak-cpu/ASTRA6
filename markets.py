"""The market roster: metals, forex and futures — all from real feeds.

Gold keeps its own proven path (xaus.com spot + the TradingView venue feed), so
nothing about the gold chart changes. Everything else is added here:

    METALS   silver, platinum, palladium   -> xaus.com spot candles (same family as gold)
    FOREX    EURUSD, GBPUSD, USDJPY        -> Yahoo Finance 15m/1h/1d bars
    FUTURES  S&P 500, Nasdaq 100, WTI      -> Yahoo Finance ES/NQ/CL contracts

Rules:
  * no price is invented: if a feed is down the caller gets an error, not a guess
  * every series reports how old its newest bar is, so the page can say so
  * bitcoin is deliberately absent
"""
import time

import requests

UA = {"User-Agent": "Mozilla/5.0 (compatible; ASTRA6/1.0)", "Accept": "application/json,text/plain,*/*"}

# id -> what it is and where it comes from
MARKETS = {
    "XAUUSD": {"name": "Gold",        "group": "Metals",  "src": "xaus",  "xaus": "xau",       "dec": 2, "unit": "$",  "vol": True},
    # the metals futures carry a volume on every bar, which is what a cluster needs
    "XAGUSD": {"name": "Silver",      "group": "Metals",  "src": "yahoo", "yahoo": "SI=F",     "dec": 3, "unit": "$",  "vol": True},
    "XPTUSD": {"name": "Platinum",    "group": "Metals",  "src": "yahoo", "yahoo": "PL=F",     "dec": 1, "unit": "$",  "vol": True},
    "XPDUSD": {"name": "Palladium",   "group": "Metals",  "src": "yahoo", "yahoo": "PA=F",     "dec": 1, "unit": "$",  "vol": True},
    "EURUSD": {"name": "Euro / Dollar", "group": "Forex", "src": "yahoo", "yahoo": "EURUSD=X", "dec": 5, "unit": "",   "vol": False},
    "GBPUSD": {"name": "Pound / Dollar", "group": "Forex", "src": "yahoo", "yahoo": "GBPUSD=X", "dec": 5, "unit": "",  "vol": False},
    "USDJPY": {"name": "Dollar / Yen", "group": "Forex",  "src": "yahoo", "yahoo": "USDJPY=X", "dec": 3, "unit": "",   "vol": False},
    "ES":     {"name": "S&P 500",     "group": "Futures", "src": "yahoo", "yahoo": "ES=F",     "dec": 2, "unit": "",   "vol": True},
    "NQ":     {"name": "Nasdaq 100",  "group": "Futures", "src": "yahoo", "yahoo": "NQ=F",     "dec": 2, "unit": "",   "vol": True},
    "CL":     {"name": "Crude Oil WTI", "group": "Futures", "src": "yahoo", "yahoo": "CL=F",   "dec": 2, "unit": "$",  "vol": True},
}
GROUPS = ["Metals", "Forex", "Futures"]

_TF_MIN = {"M1": 1, "M5": 5, "M15": 15, "M30": 30, "H1": 60, "H4": 240, "D": 1440, "W": 10080}
_XAUS_TF = {"M1": ("1m", "1d", 1), "M5": ("5m", "5d", 5), "M15": ("15m", "5d", 15),
            "M30": ("30m", "5d", 30), "H1": ("1h", "1mo", 60), "H4": ("4h", "1mo", 240),
            "D": ("1d", "1y", 1440), "W": ("1d", "1y", 1440)}
_YF_TF = {"M1": ("1m", "5d", 1), "M5": ("5m", "5d", 5), "M15": ("15m", "5d", 15),
          "M30": ("30m", "1mo", 30), "H1": ("60m", "1mo", 60), "H4": ("60m", "1mo", 60),
          "D": ("1d", "2y", 1440), "W": ("1d", "5y", 1440)}

_CACHE = {}


def _cached(key, ttl, fn):
    hit = _CACHE.get(key)
    now = time.time()
    if hit and now - hit["t"] < ttl:
        return hit["v"]
    v = fn()
    if v:
        _CACHE[key] = {"t": now, "v": v}
    elif hit:
        return hit["v"]          # a short outage keeps the last real series, flagged stale
    return v


def norm_tf(tf):
    tf = str(tf or "M15").upper().replace("D1", "D").replace("W1", "W")
    return tf if tf in _TF_MIN else "M15"


def meta(mid):
    return MARKETS.get(str(mid or "").upper())


def market_list():
    out = []
    for mid, m in MARKETS.items():
        out.append({"id": mid, "name": m["name"], "group": m["group"],
                    "dec": m["dec"], "unit": m["unit"], "volume": m["vol"],
                    "stale": None, "price": None, "change_pct": None})
    return out


# ------------------------------------------------------------------ sources
def _agg(rows, secs):
    """Roll bars up (used for 4h and weekly) - arithmetic on real bars only."""
    if not rows:
        return rows
    out, cur = [], None
    for r in sorted(rows, key=lambda x: x["time"]):
        b = int(r["time"] // secs) * secs
        if cur is None or b != cur["time"]:
            if cur:
                out.append(cur)
            cur = dict(r, time=b)
        else:
            cur["high"] = max(cur["high"], r["high"])
            cur["low"] = min(cur["low"], r["low"])
            cur["close"] = r["close"]
            cur["volume"] = (cur.get("volume") or 0) + (r.get("volume") or 0)
    if cur:
        out.append(cur)
    return out


def _xaus_rows(sym, tf):
    interval, rng, _ = _XAUS_TF[tf]
    r = requests.get("https://xaus.com/api/v1/chart",
                     params={"symbol": sym, "range": rng, "interval": interval},
                     headers=UA, timeout=10)
    if r.status_code != 200:
        return [], f"xaus {r.status_code}"
    pts = (r.json() or {}).get("points") or []
    rows = [{"time": int(p["t"]), "open": float(p["o"]), "high": float(p["h"]),
             "low": float(p["l"]), "close": float(p["c"]),
             "volume": float(p.get("v") or 0)} for p in pts]
    return rows, "xaus.com spot"


def _yahoo_rows(symbol, tf):
    interval, rng, agg_min = _YF_TF[tf]
    r = requests.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}",
                     params={"interval": interval, "range": rng}, headers=UA, timeout=12)
    if r.status_code != 200:
        return [], f"yahoo {r.status_code}"
    try:
        res = (r.json() or {})["chart"]["result"][0]
    except Exception:
        return [], "yahoo shape"
    ts = res.get("timestamp") or []
    q = (res.get("indicators", {}).get("quote") or [{}])[0]
    o, h, l, c, v = (q.get(k) or [] for k in ("open", "high", "low", "close", "volume"))
    rows = []
    for i, t in enumerate(ts):
        try:
            if o[i] is None or h[i] is None or l[i] is None or c[i] is None:
                continue
            rows.append({"time": int(t), "open": float(o[i]), "high": float(h[i]),
                         "low": float(l[i]), "close": float(c[i]),
                         "volume": float(v[i] or 0) if i < len(v) else 0.0})
        except Exception:
            continue
    if agg_min > int(interval.replace("m", "")) if interval.endswith("m") else False:
        rows = _agg(rows, agg_min * 60)
    if tf == "W":
        rows = _agg(rows, 7 * 86400)
    return rows, "Yahoo Finance"


def candles(mid, tf="M15", count=150):
    """Real OHLCV bars for a market. Returns (rows, source, error)."""
    m = meta(mid)
    if not m:
        return [], None, "unknown_symbol"
    tf = norm_tf(tf)
    key = f"{mid}|{tf}|{count}"

    def load():
        if m["src"] == "xaus":
            rows, src = _xaus_rows(m["xaus"], tf)
        else:
            rows, src = _yahoo_rows(m["yahoo"], tf)
        if not rows:
            return None
        rows.sort(key=lambda r: r["time"])
        return {"rows": rows[-int(count):], "source": src}

    got = _cached(key, 12 if tf in ("M1", "M5") else 20, load)
    if not got:
        return [], None, "feed_unavailable"
    return got["rows"], got["source"], None


def age_minutes(rows):
    if not rows:
        return None
    return round((time.time() - rows[-1]["time"]) / 60.0, 1)


def is_stale(rows, tf):
    a = age_minutes(rows)
    if a is None:
        return False, None
    limit = max(_TF_MIN.get(norm_tf(tf), 15) * 3, 20)
    return a > limit, a


def _prev_daily_close(m):
    """Yesterday's real close, so the change is a day-on-day number, not bar-on-bar."""
    key = "prev|" + str(m.get("xaus") or m.get("yahoo"))
    def load():
        if m["src"] == "xaus":
            rows, _ = _xaus_rows(m["xaus"], "D")
        else:
            rows, _ = _yahoo_rows(m["yahoo"], "D")
        return rows[-2]["close"] if len(rows) > 1 else None
    try:
        return _cached(key, 600, load)
    except Exception:
        return None


def quote(mid, tf="M5"):
    """Live-ish price and change, from the same real series the chart draws."""
    m = meta(mid)
    if not m:
        return None
    rows, src, err = candles(mid, tf, 260)
    if not rows:
        return None
    last = rows[-1]
    prev = _prev_daily_close(m) or (rows[-2]["close"] if len(rows) > 1 else last["close"])
    chg = ((last["close"] - prev) / prev * 100.0) if prev else 0.0
    return {"id": mid, "price": round(last["close"], m["dec"]), "dec": m["dec"],
            "change_pct": round(chg, 2), "time": last["time"],
            "age_min": age_minutes(rows), "source": src, "real": True}


def board():
    """Every market with its price, for the menu and the home screen."""
    out = []
    for mid, m in MARKETS.items():
        q = quote(mid)
        item = {"id": mid, "name": m["name"], "group": m["group"], "dec": m["dec"],
                "unit": m["unit"], "volume": m["vol"], "price": None,
                "change_pct": None, "age_min": None, "source": None}
        if q:
            item.update({"price": q["price"], "change_pct": q["change_pct"],
                         "age_min": q["age_min"], "source": q["source"]})
        out.append(item)
    return {"status": "ok", "groups": GROUPS, "markets": out, "real": True}


def volume_rows(mid, tf="M15", count=200):
    """Bars for the cluster engine. Forex has no centralised volume: say so."""
    m = meta(mid)
    if not m:
        return None, "unknown_symbol"
    if not m["vol"]:
        return None, "no_volume"
    rows, src, err = candles(mid, tf, count)
    if not rows:
        return None, err or "feed_unavailable"
    rows = [r for r in rows if r["volume"] > 0]
    if len(rows) < 20:
        return None, "no_volume"
    return rows, src
