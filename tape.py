"""DESENTO tape engine - every order-flow number the terminal shows is computed here.

What Exness gives us: a stream of bid/ask quotes. What it does not give us: traded
volume at the bid or at the ask, aggressor side, or any per-trade size. So a footprint
built on this feed is an ESTIMATE, made by the tick rule: a quote that rises is booked
to the buy side, a quote that falls to the sell side, and a level's "bid x ask" cell is
the number of down-ticks and up-ticks that printed at that price.

Nothing in this module invents size. Where the wire ever carries a real size, that size
is used and the payload says so (vol_kind = "reported_size"); otherwise the weight is a
count and the payload says "tick_rule_estimate". These words travel with every response
so the interface cannot show an estimate as if it were a fact.

Pure functions over a list of points (ts, price, side, size) - no globals, no network,
so the whole engine can be checked against known sample datasets.
"""

import math
import sqlite3
import threading

PRICE_STEPS = (0.01, 0.05, 0.10, 0.25, 0.50, 1.00)   # configurable price aggregation
TIMEFRAMES = (15, 30, 60, 120, 300, 900)            # seconds per footprint candle
SESSION_START_UTC = 0                                # the trading day starts at 00:00 UTC

PROVENANCE = {
    "vol_kind": "tick_rule_estimate",
    "label": "estimated",
    "note": ("Exness publishes bid/ask quotes, not traded volume per price. Cells are "
             "counted ticks: an up-tick is booked to the buy side, a down-tick to the "
             "sell side, a repeated quote to neither. Direction is inferred, not "
             "reported by the exchange."),
}


def provenance(has_size: bool = False) -> dict:
    if has_size:
        return {"vol_kind": "reported_size", "label": "reported",
                "note": ("The feed carried a size for these quotes, so the cells are "
                         "that size. Aggressor side is still inferred by the tick rule.")}
    return dict(PROVENANCE)


# ------------------------------------------------------------------ the primitive
def decimals(step: float) -> int:
    return 2 if step >= 0.01 else 3


def bucket(price: float, step: float) -> float:
    """The price level a quote belongs to, on a fixed grid, without float drift."""
    if not price or price <= 0:
        return 0.0
    k = math.floor(price / step + 1e-9)
    return round(k * step, 6)


def classify(points):
    """Attach a side to each point by the tick rule: up = buy, down = sell, equal = flat.

    Returns (ts, price, side, weight, size_is_real). The first point has no predecessor
    and therefore votes for nobody.
    """
    out = []
    last = None
    has_size = False
    for p in points:
        ts, price = p[0], p[1]
        size = p[3] if len(p) > 3 else None
        if size:
            has_size = True
        if last is None or price == last:
            side = 0
        else:
            side = 1 if price > last else -1
        weight = float(size) if size else 1.0
        out.append((ts, price, side, weight))
        last = price
    return out, has_size


def _bars_index(ts: float, tf: int) -> int:
    return int(math.floor(ts / tf)) * tf


def footprint(points, tf: int = 60, step: float = 0.05, limit: int = 120) -> list:
    """Bid x ask cells per price level, per candle. Every cell is a counted estimate."""
    pts, has_size = classify(points)
    bars = {}
    order = []
    for ts, price, side, weight in pts:
        t0 = _bars_index(ts, tf)
        bar = bars.get(t0)
        if bar is None:
            bar = bars[t0] = {
                "t0": t0, "t1": t0 + tf, "open": price, "high": price, "low": price,
                "close": price, "buy": 0.0, "sell": 0.0, "flat": 0.0, "ticks": 0,
                "levels": {},
            }
            order.append(t0)
        bar["close"] = price
        bar["high"] = max(bar["high"], price)
        bar["low"] = min(bar["low"], price)
        bar["ticks"] += 1
        lvl = bucket(price, step)
        cell = bar["levels"].get(lvl)
        if cell is None:
            cell = bar["levels"][lvl] = [0.0, 0.0, 0.0]      # buy, sell, flat
        if side > 0:
            cell[0] += weight
            bar["buy"] += weight
        elif side < 0:
            cell[1] += weight
            bar["sell"] += weight
        else:
            cell[2] += weight
            bar["flat"] += weight
    out = []
    for t0 in order[-limit:]:
        b = bars[t0]
        b["delta"] = b["buy"] - b["sell"]
        b["volume"] = b["buy"] + b["sell"] + b["flat"]
        b["levels"] = [[p, round(v[0], 4), round(v[1], 4), round(v[2], 4)]
                       for p, v in sorted(b["levels"].items(), reverse=True)]
        b["buy"] = round(b["buy"], 4)
        b["sell"] = round(b["sell"], 4)
        b["flat"] = round(b["flat"], 4)
        b["delta"] = round(b["delta"], 4)
        b["volume"] = round(b["volume"], 4)
        b["estimated"] = not has_size
        out.append(b)
    return out


def cvd(bars, start: float = 0.0) -> list:
    """Cumulative volume delta across the candles handed in."""
    total = start
    out = []
    for b in bars:
        total += b["delta"]
        out.append(round(total, 4))
    return out


def session_start(ts: float) -> float:
    day = math.floor(ts / 86400.0) * 86400
    return day + SESSION_START_UTC * 3600


# ------------------------------------------------------------------ market hours
# XAUUSD on Exness: opens Sunday 22:05 GMT, closes Friday 20:58 GMT, and takes a
# daily break from 20:58 to 22:02 GMT. Outside those windows no quote exists at all,
# so a silent tape is the truth, not a fault - and the terminal should say which.
GOLD_OPEN_S = 22 * 3600 + 5 * 60         # Sunday
GOLD_CLOSE_S = 20 * 3600 + 58 * 60       # Friday
BREAK_START_S = 20 * 3600 + 58 * 60      # daily
BREAK_END_S = 22 * 3600 + 2 * 60


def market_state(now: float) -> dict:
    """Is the gold market open, and if not, when does it open again (UTC seconds)."""
    import datetime
    dt = datetime.datetime.fromtimestamp(now, tz=datetime.timezone.utc)
    wd = dt.weekday()                     # Mon 0 ... Sun 6
    secs = dt.hour * 3600 + dt.minute * 60 + dt.second
    day0 = now - secs                     # this UTC midnight

    def at(day_offset, sec):
        return day0 + day_offset * 86400 + sec

    if wd == 5:                                            # Saturday
        return {"open": False, "reason": "weekend", "opens_at": at(1, GOLD_OPEN_S),
                "detail": "Gold is closed for the weekend."}
    if wd == 6:                                            # Sunday
        if secs < GOLD_OPEN_S:
            return {"open": False, "reason": "weekend",
                    "opens_at": at(0, GOLD_OPEN_S),
                    "detail": "Gold opens Sunday 22:05 UTC."}
        return {"open": True, "reason": "open", "opens_at": None, "detail": ""}
    if wd == 4 and secs >= GOLD_CLOSE_S:                    # Friday after the close
        return {"open": False, "reason": "weekend",
                "opens_at": at(2, GOLD_OPEN_S),
                "detail": "Gold closed for the weekend at Friday 20:58 UTC."}
    if BREAK_START_S <= secs < BREAK_END_S:                 # Mon-Thu daily break
        return {"open": False, "reason": "daily_break",
                "opens_at": at(0, BREAK_END_S),
                "detail": "Gold is in its daily break, 20:58-22:02 UTC."}
    return {"open": True, "reason": "open", "opens_at": None, "detail": ""}


# ------------------------------------------------------------------ imbalances
def imbalances(bar: dict, ratio: float = 3.0, stack: int = 3) -> dict:
    """Diagonal bid/ask imbalance inside one candle.

    A buy imbalance at level i means the buying printed there is `ratio` times the
    selling printed one level below it, and the mirror for sell imbalances. Diagonal
    is the standard reading: it compares what traded at a price with what traded at the
    adjacent price on the opposite book.
    """
    lv = sorted(bar["levels"], key=lambda r: r[0])       # ascending price
    marks = []
    for i, (price, buy, sell, _flat) in enumerate(lv):
        # diagonal: buys at this level against the sells one level below,
        # and sells here against the buys one level above
        if i > 0:
            below_sell = lv[i - 1][2]
            if below_sell > 0 and buy / below_sell >= ratio:
                marks.append({"price": price, "side": "buy",
                              "ratio": round(buy / below_sell, 2)})
        if i < len(lv) - 1:
            above_buy = lv[i + 1][1]
            if above_buy > 0 and sell / above_buy >= ratio:
                marks.append({"price": price, "side": "sell",
                              "ratio": round(sell / above_buy, 2)})
    marks.sort(key=lambda m: -m["price"])
    # stacked runs: consecutive price levels marked on the same side
    by_side = {"buy": [m["price"] for m in marks if m["side"] == "buy"],
               "sell": [m["price"] for m in marks if m["side"] == "sell"]}
    stacks = []
    for side, prices in by_side.items():
        prices.sort()
        run = []
        for p in prices:
            if run and abs(p - run[-1] - _grid_gap(lv)) > 1e-9:
                if len(run) >= stack:
                    stacks.append({"side": side, "from": run[0], "to": run[-1],
                                   "levels": len(run)})
                run = []
            run.append(p)
        if len(run) >= stack:
            stacks.append({"side": side, "from": run[0], "to": run[-1],
                           "levels": len(run)})
    return {"marks": marks, "stacks": stacks}


def _grid_gap(levels) -> float:
    if len(levels) < 2:
        return 0.0
    return round(abs(levels[1][0] - levels[0][0]), 6)


def bar_imbalances(bars, ratio: float = 3.0, stack: int = 3) -> list:
    out = []
    for b in bars:
        if not b["levels"]:
            continue
        out.append({"t0": b["t0"], **imbalances(b, ratio, stack)})
    return out


# ------------------------------------------------------------------ behaviour
def absorption(bars, step: float, mult: float = 2.0, touches: int = 3) -> list:
    """Zones where volume piled up at one price without the price going anywhere.

    A level qualifies when it holds at least `mult` times the average volume of a single
    level in the window, the price visited it in at least `touches` separate candles, and
    its net delta is small next to its volume - two-way churn, which is what absorption
    looks like from quotes.
    """
    totals = {}
    visit = {}
    buy = {}
    sell = {}
    for b in bars:
        for price, bv, sv, _f in b["levels"]:
            key = bucket(price, step)
            totals[key] = totals.get(key, 0.0) + bv + sv
            buy[key] = buy.get(key, 0.0) + bv
            sell[key] = sell.get(key, 0.0) + sv
            visit.setdefault(key, set()).add(b["t0"])
    filled = [v for v in totals.values() if v > 0]
    if not filled:
        return []
    avg = sum(filled) / len(filled)
    zones = []
    for price, vol in totals.items():
        if vol < mult * avg or len(visit[price]) < touches:
            continue
        net = abs(buy[price] - sell[price])
        if vol and net / vol > 0.15:
            continue
        zones.append({"price": price, "volume": round(vol, 2),
                      "buy": round(buy[price], 2), "sell": round(sell[price], 2),
                      "candles": len(visit[price]),
                      "net_share": round(net / vol, 3)})
    zones.sort(key=lambda z: -z["volume"])
    return zones[:6]


def exhaustion(bars, mult: float = 2.0) -> list:
    """High effort, no result: the biggest-volume candles that barely moved.

    Defined as volume at least `mult` times the average of the window while the candle's
    own range is no more than half the average range. That is the bar where size was
    spent and price refused to travel.
    """
    usable = [b for b in bars if b["volume"] > 0]
    if len(usable) < 3:
        return []
    avg_v = sum(b["volume"] for b in usable) / len(usable)
    ranges = [b["high"] - b["low"] for b in usable]
    avg_r = sum(ranges) / len(ranges) or 1e-9
    out = []
    for b in usable:
        rng = b["high"] - b["low"]
        if b["volume"] >= mult * avg_v and rng <= 0.5 * avg_r:
            out.append({"t0": b["t0"], "volume": round(b["volume"], 2),
                        "range": round(rng, 4), "delta": round(b["delta"], 2),
                        "side": "buy" if b["delta"] > 0 else ("sell" if b["delta"] < 0 else "flat")})
    return out[-6:]


def aggressive(bars, share: float = 0.65) -> list:
    """Candles where one side clearly dominated: |delta| / volume at or above `share`."""
    out = []
    for b in bars:
        if b["volume"] <= 0:
            continue
        s = abs(b["delta"]) / b["volume"]
        if s >= share:
            out.append({"t0": b["t0"], "side": "buy" if b["delta"] > 0 else "sell",
                        "share": round(s, 3), "delta": round(b["delta"], 2)})
    return out[-8:]


def divergence(bars, lookback: int = 40) -> list:
    """Price and cumulative delta disagreeing - the classic exhaustion warning.

    Bearish: a higher price high while CVD makes a lower high. Bullish: the mirror.
    Only closed candles are compared, so the forming candle cannot fake a signal.
    """
    closed = list(bars)[:-1]              # the forming candle cannot prove a divergence
    if len(closed) < 6:
        return []
    closed = closed[-lookback:]
    series = cvd(closed)
    out = []
    highs = [b["high"] for b in closed]
    lows = [b["low"] for b in closed]
    for i in range(3, len(closed)):
        prev_hi = max(highs[:i])
        prev_cvd_hi = max(series[:i])
        if highs[i] > prev_hi and series[i] < prev_cvd_hi:
            out.append({"t0": closed[i]["t0"], "side": "bearish",
                        "price": round(highs[i], 4), "cvd": round(series[i], 2)})
        prev_lo = min(lows[:i])
        prev_cvd_lo = min(series[:i])
        if lows[i] < prev_lo and series[i] > prev_cvd_lo:
            out.append({"t0": closed[i]["t0"], "side": "bullish",
                        "price": round(lows[i], 4), "cvd": round(series[i], 2)})
    return out[-5:]


# ------------------------------------------------------------------ volume profile
def profile(points, step: float = 0.05, t0: float = 0.0, t1: float = 1e18,
            value_area: float = 0.70, hvn_mult: float = 1.5, lvn_mult: float = 0.5) -> dict:
    """Session or custom-range volume profile: POC, VAH, VAL, HVN, LVN.

    The value area grows outwards from the POC, taking whichever neighbouring level holds
    more volume, until it covers `value_area` of the range's volume - the standard
    treatment, done on estimated volume like everything else here.
    """
    pts, has_size = classify([p for p in points if t0 <= p[0] < t1])
    levels = {}
    for _ts, price, side, weight in pts:
        lvl = bucket(price, step)
        cell = levels.get(lvl)
        if cell is None:
            cell = levels[lvl] = [0.0, 0.0, 0.0]
        if side > 0:
            cell[0] += weight
        elif side < 0:
            cell[1] += weight
        else:
            cell[2] += weight
    total = sum(sum(v) for v in levels.values())
    if not levels or total <= 0:
        return {"levels": [], "poc": None, "vah": None, "val": None, "total": 0,
                "hvn": [], "lvn": [], "provenance": provenance(has_size)}
    prices = sorted(levels, reverse=True)
    vol = {p: sum(levels[p]) for p in prices}
    poc = max(prices, key=lambda p: (vol[p], p))
    # value area: expand from the POC, always taking the richer neighbour
    idx = {p: i for i, p in enumerate(prices)}
    lo = hi = idx[poc]
    acc = vol[poc]
    target = total * value_area
    while acc < target and (lo > 0 or hi < len(prices) - 1):
        up = vol[prices[hi - 1]] if hi > 0 else -1.0
        down = vol[prices[lo + 1]] if lo < len(prices) - 1 else -1.0
        if up >= down:
            hi -= 1
            acc += max(up, 0)
        else:
            lo += 1
            acc += max(down, 0)
    vah, val = prices[hi], prices[lo]
    vals = [vol[p] for p in prices]
    med = sorted(vals)[len(vals) // 2] or 1e-9
    hvn, lvn = [], []
    for i, p in enumerate(prices):
        left = vol[prices[i - 1]] if i > 0 else None
        right = vol[prices[i + 1]] if i < len(prices) - 1 else None
        neighbours = [n for n in (left, right) if n is not None]
        if neighbours and all(vol[p] > n for n in neighbours) and vol[p] >= hvn_mult * med:
            hvn.append(p)
        if neighbours and all(vol[p] < n for n in neighbours) and vol[p] <= lvn_mult * med:
            lvn.append(p)
    return {
        "levels": [[p, round(levels[p][0], 2), round(levels[p][1], 2),
                    round(levels[p][2], 2), round(vol[p], 2)]
                   for p in prices],
        "poc": poc, "vah": vah, "val": val, "total": round(total, 2),
        "value_area": value_area, "hvn": hvn[:8], "lvn": lvn[:8],
        "step": step, "estimate": True,
        "provenance": provenance(has_size),
    }


# ------------------------------------------------------------------ one payload
def snapshot(points, tf: int = 60, step: float = 0.05, bars: int = 90,
             ratio: float = 3.0, stack: int = 3, profile_minutes: int = 240,
             session_delta=None, session_quotes=None) -> dict:
    """Everything the terminal needs for one frame, computed from the same points."""
    pts = sorted(points, key=lambda p: p[0])
    _classified, has_size = classify(pts)
    fp = footprint(pts, tf=tf, step=step, limit=bars)
    cvd_series = cvd(fp)
    now = pts[-1][0] if pts else 0
    sess0 = session_start(now) if now else 0
    if session_delta is None:             # window-only fallback when no archive exists
        sess_delta = 0.0
        for _ts, _pr, side, weight in _classified:
            if _ts >= sess0:
                sess_delta += weight if side > 0 else (-weight if side < 0 else 0.0)
        sess_quotes = sum(1 for _t, _p, _s, _w in _classified if _t >= sess0)
        sess_source = "window"
    else:
        sess_delta = float(session_delta)
        sess_quotes = int(session_quotes or 0)
        sess_source = "archive"
    prof = profile(pts, step=step, t0=(now - profile_minutes * 60) if now else 0, t1=now + 1)
    imbs = bar_imbalances(fp, ratio, stack)
    return {
        "symbol": None,
        "tf": tf,
        "step": step,
        "decimals": decimals(step),
        "points": len(pts),
        "first_ts": (pts[0][0] if pts else None),
        "last_ts": (pts[-1][0] if pts else None),
        "bars": fp,
        "cvd": cvd_series,
        "session": {"start": sess0, "delta": round(sess_delta, 2),
                    "quotes": sess_quotes, "source": sess_source},
        "imbalance": {"ratio": ratio, "stacked": stack, "bars": imbs},
        "absorption": absorption(fp, step),
        "exhaustion": exhaustion(fp),
        "aggressive": aggressive(fp),
        "divergence": divergence(fp),
        "profile": prof,
        "provenance": provenance(has_size),
        "note": ("Bid x Ask cells are counted ticks, not reported volume. POC, VAH, VAL "
                 "and every delta are computed from those counts. Nothing here is "
                 "simulated, but direction is inferred, so it is an estimate."),
    }


# ------------------------------------------------------------------ the archive
class Store:
    """Ticks on disk, so history survives a page reload and a worker reconnect.

    SQLite in WAL mode, one row per quote. Writes are batched by the caller; reads are
    short range scans over an index. The volume of this feed (tens of quotes a minute)
    is tiny for SQLite, which is why there is no need for anything heavier.
    """

    KEEP_S = 86400 * 4          # four days of tape, then the oldest is dropped

    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS ticks ("
            " ts REAL NOT NULL, price REAL NOT NULL, side INTEGER NOT NULL,"
            " size REAL, sym TEXT)")
        self.db.execute("CREATE INDEX IF NOT EXISTS ticks_ts ON ticks (ts)")
        self.db.commit()

    def add(self, rows) -> int:
        """rows: (ts, price, side, size[, symbol]). Returns how many were written."""
        clean = []
        for r in rows:
            r = tuple(r)
            if not r or not r[0]:
                continue
            if len(r) == 4:
                r = r + ("",)
            clean.append((r[0], r[1], r[2], r[3], r[4]))
        if not clean:
            return 0
        with self.lock:
            self.db.executemany(
                "INSERT INTO ticks (ts, price, side, size, sym) VALUES (?,?,?,?,?)", clean)
            self.db.commit()
        return len(clean)

    def prune(self, now: float) -> int:
        with self.lock:
            cur = self.db.execute("DELETE FROM ticks WHERE ts < ?", (now - self.KEEP_S,))
            self.db.commit()
            return cur.rowcount or 0

    def range(self, t0: float, t1: float, limit: int = 200000, sym: str = None) -> list:
        with self.lock:
            if sym:
                cur = self.db.execute(
                    "SELECT ts, price, side, size FROM ticks WHERE ts >= ? AND ts < ?"
                    " AND upper(sym) = upper(?) ORDER BY ts LIMIT ?",
                    (t0, t1, sym, limit))
            else:
                cur = self.db.execute(
                    "SELECT ts, price, side, size FROM ticks WHERE ts >= ? AND ts < ?"
                    " ORDER BY ts LIMIT ?", (t0, t1, limit))
            return [(r[0], r[1], r[2], r[3]) for r in cur.fetchall()]

    def side_totals(self, t0: float, t1: float, sym: str = None):
        """(buy, sell, quotes) between two instants - used for the true session delta."""
        with self.lock:
            if sym:
                cur = self.db.execute(
                    "SELECT SUM(CASE WHEN side > 0 THEN COALESCE(size, 1) ELSE 0 END),"
                    "       SUM(CASE WHEN side < 0 THEN COALESCE(size, 1) ELSE 0 END),"
                    "       COUNT(*) FROM ticks WHERE ts >= ? AND ts < ? AND upper(sym)=upper(?)",
                    (t0, t1, sym))
            else:
                cur = self.db.execute(
                    "SELECT SUM(CASE WHEN side > 0 THEN COALESCE(size, 1) ELSE 0 END),"
                    "       SUM(CASE WHEN side < 0 THEN COALESCE(size, 1) ELSE 0 END),"
                    "       COUNT(*) FROM ticks WHERE ts >= ? AND ts < ?", (t0, t1))
            b, s, n = cur.fetchone()
        return (b or 0.0, s or 0.0, n or 0)

    def span(self):
        with self.lock:
            cur = self.db.execute(
                "SELECT COUNT(*), MIN(ts), MAX(ts) FROM ticks")
            n, a, b = cur.fetchone()
        return {"ticks": n or 0, "first_ts": a, "last_ts": b}
