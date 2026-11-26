"""Order flow for gold, straight from the trader's own Exness account.

What this is
------------
A retail broker does not publish per-trade aggressor side, so there is no such thing as
exchange-grade volume delta on CFD gold. What the Exness Trading API *does* give us is a
signed WebSocket of live ticks for the account. From those ticks this module builds the
honest reading that is possible: a **tick-rule delta** - every time the quoted price
rises, the move is booked as buying; every time it falls, as selling. The sums are
labelled a proxy everywhere they surface, and the age of the last tick is always shown,
so a stale feed can never pass itself off as live pressure.

Credentials (server-side only, never sent to the browser):
    EXN_API_KEY             public key id, ``exnsk-...``
    EXN_PRIVATE_KEY         128 hex characters, or an unencrypted PKCS#8 PEM
    EXN_ACCOUNT_ID          the trading account the key can read
    EXN_DISCOVERY_BASE_URL  the Gateway host from Key Management (no trailing slash)

Nothing here invents a number: with no credentials, or before the first tick, the
snapshot says exactly that.
"""
from __future__ import annotations

import base64
import collections
import hashlib
import json
import os
import re
import threading
import time

try:                                     # the signing key
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    _CRYPTO = True
except Exception:                        # pragma: no cover - only on a broken install
    _CRYPTO = False

SYMBOL = (os.getenv("EXN_SYMBOL") or "XAUUSDM").upper()   # Exness lists gold as XAUUSDm
# Gold also exists as a 24/7 contract on the same account (XAUUSD247). It trades through
# the daily break, so the terminal can follow it when the ordinary contract is shut -
# always under its own name, never passed off as XAUUSD.
COMPANIONS = ("XAUUSD247",)
WINDOWS = (60, 300, 900)                 # 1m, 5m, 15m
KEEP_S = 900                             # how much tick history is held in memory
RECONNECT_S = 5.0

_STORE = None                            # the on-disk tape, opened on first use
_STORE_FAILED = False

_LOCK = threading.Lock()
_TICKS = collections.deque()             # (ts, price, side, volume, symbol)
_LAST_PX = {}                            # symbol -> last quoted price
_LAST_BOOK = {}                          # symbol -> (bid, ask, ts) as the wire sent them
_SEEN = {}                               # (sym, ts, price) -> when it was booked, for de-duplication
_SEEN_MAX = 8000
_LAST_TS = {}                            # symbol -> newest event timestamp accepted
_STATE = {
    "worker": False,                     # a thread is running
    "connected": False,
    "status": "idle",                    # idle / connecting / live / error / not_configured
    "error": "",
    "access_point": "",
    "gateway": "",
    "symbol_active": "",
    "instruments_n": 0,
    "gold_names": [],
    "symbol_error": "",
    "inst_error": "",
    "inst_raw": "",
    "last_tick": 0.0,
    "started": 0.0,
    "messages": 0,                       # frames seen
    "parsed": 0,                         # ticks recognised
    "duplicates": 0,                     # ticks that repeated one already booked
    "invalid": 0,                        # ticks with no usable price
    "late": 0,                           # ticks that arrived behind a newer one
    "rejected": 0,                       # ticks for an instrument this desk does not chart
    "sample": None,                      # the last raw frame, for field discovery
    "symbol_seen": "",
    "book": [],
}


def store():
    """The tick archive. Opened lazily; a read-only disk disables it, never the feed."""
    global _STORE, _STORE_FAILED
    if _STORE is not None or _STORE_FAILED:
        return _STORE
    try:
        import tape
        # A mounted disk wins if there is one: on Render that is /var/data, which is the
        # only place that survives a deploy. Without it the archive is per-instance and
        # the terminal says so rather than implying history it cannot keep.
        path = _env("TAPE_DB")
        if not path:
            mounted = "/var/data"
            path = (os.path.join(mounted, "tape.sqlite3") if os.path.isdir(mounted)
                    else os.path.join("data", "tape.sqlite3"))
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        _STORE = tape.Store(path)
    except Exception as e:                    # pragma: no cover - disk problems only
        _STORE_FAILED = True
        print("tape store unavailable:", str(e)[:120])
    return _STORE


def points(seconds: int = 900, sym: str = ""):
    """The tape for the last `seconds`, from the archive, falling back to memory."""
    now = time.time()
    st = store()
    if st is not None:
        try:
            got = st.range(now - seconds, now + 1, sym=sym or None)
            if got:
                return got
        except Exception:
            pass
    with _LOCK:
        return [(t[0], t[1], t[2], t[3]) for t in _TICKS
                if t[0] >= now - seconds and (not sym or _norm(t[4]) == _norm(sym))]


def quote(sym: str = "") -> dict:
    """The last bid/ask the account was quoted, exactly as the wire sent it.

    Returns an empty dict when this feed has not carried both sides - a spread is never
    inferred from a mid, so a page that cannot show a real one says nothing instead.
    """
    sym = sym or auto_symbol()
    now = time.time()
    with _LOCK:
        for name, (bid, ask, ts) in reversed(list(_LAST_BOOK.items())):
            if _norm(name) == _norm(sym):
                # six places is finer than any instrument this desk quotes in, and keeps
                # binary float noise (3571.9320000000002) out of the payload
                b6, a6 = round(bid, 6), round(ask, 6)
                return {"bid": b6, "ask": a6, "ts": ts,
                        "spread": round(a6 - b6, 6), "age": round(now - ts, 1),
                        "symbol": name}
    return {}


def auto_symbol() -> str:
    """Which gold contract is actually printing: the ordinary one, else the 24/7 one."""
    now = time.time()
    with _LOCK:
        fresh = {}
        for t in reversed(_TICKS):
            if now - t[0] > 300:
                break
            fresh.setdefault(t[4], t[0])
    order = [active_symbol(), "XAUUSD"] + list(COMPANIONS) + list(fresh.keys())
    for sym in order:
        for name in fresh:
            if _norm(name) == _norm(sym):
                return name
    try:
        import tape as _TP
        if not _TP.market_state(now)["open"]:
            for c in companions():
                return c
    except Exception:
        pass
    return active_symbol()


def feed_for(sym: str):
    """Last price and age for one instrument, so the header cannot mix two contracts."""
    now = time.time()
    with _LOCK:
        px = _LAST_PX.get(sym)
        ts = 0.0
        for t in reversed(_TICKS):
            if _norm(t[4]) == _norm(sym):
                ts = t[0]
                break
    return px, (now - ts if ts else None)


def archive_durable() -> bool:
    """True only when the tape sits on a mounted disk, so it outlives the instance."""
    p = _env("TAPE_DB") or ("/var/data/tape.sqlite3" if os.path.isdir("/var/data") else "")
    return bool(p) and p.startswith("/var/data/")


def archive_status() -> dict:
    st = store()
    if st is None:
        with _LOCK:
            n = len(_TICKS)
            first = _TICKS[0][0] if _TICKS else None
            last = _TICKS[-1][0] if _TICKS else None
        return {"ok": False, "ticks": n, "first_ts": first, "last_ts": last,
                "note": "in memory only, the disk archive is unavailable"}
    try:
        s = st.span()
        s["ok"] = True
        s["durable"] = archive_durable()
        s["path"] = getattr(st, "path", "")
        return s
    except Exception as e:                    # pragma: no cover
        return {"ok": False, "error": str(e)[:120]}


# ------------------------------------------------------------------ credentials
def _env(name):
    return (os.getenv(name) or "").strip()


def missing():
    """Which of the required settings are still absent. Names only, never values."""
    need = ("EXN_API_KEY", "EXN_PRIVATE_KEY", "EXN_ACCOUNT_ID")
    return [n for n in need if not _env(n)]


def configured():
    return not missing()


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _load_key(text: str):
    """128 hex characters (seed + public half) or an unencrypted PKCS#8 PEM."""
    if not _CRYPTO:
        raise RuntimeError("cryptography is not installed")
    text = text.strip()
    if text.startswith("-----BEGIN PRIVATE KEY-----"):
        key = serialization.load_pem_private_key(text.encode(), password=None)
        if not isinstance(key, Ed25519PrivateKey):
            raise ValueError("expected an Ed25519 private key")
        return key
    hexed = re.sub(r"[\s'\"]+", "", text)          # a copy from the portal may carry either
    if not re.fullmatch(r"[0-9a-fA-F]{128}", hexed):
        raise ValueError("expected 128 hex characters or an unencrypted PKCS#8 PEM")
    raw = bytes.fromhex(hexed)
    key = Ed25519PrivateKey.from_private_bytes(raw[:32])
    pub = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    if pub != raw[32:]:
        raise ValueError("private key public half does not match its seed")
    return key


def _base_url(value: str) -> str:
    from urllib.parse import urlsplit
    u = urlsplit(value.strip())
    if u.scheme != "https" or not u.hostname or u.username or u.password or u.query or u.fragment:
        raise ValueError("EXN_DISCOVERY_BASE_URL must be an https base URL")
    return "https://" + u.netloc


def signed_headers(path_with_query: str, method: str = "GET", body: bytes = b"",
                   idempotency: str = "", key=None, api_key: str = "") -> dict:
    """The EXN-* headers. Signs the exact bytes that are sent, base64url without padding."""
    api_key = api_key or _env("EXN_API_KEY")
    key = key or _load_key(_env("EXN_PRIVATE_KEY"))
    ts = int(time.time() * 1000)
    payload = json.dumps({
        "api_key": api_key,
        "idempotency_key": idempotency,
        "timestamp": ts,
        "sign_version": 1,
        "method": method.upper(),
        "path": path_with_query,
        "body_hash": _b64url(hashlib.sha256(body or b"").digest()),
    }, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return {
        "EXN-API-KEY": api_key,
        "EXN-IDEMPOTENCY-KEY": idempotency,
        "EXN-TIMESTAMP": str(ts),
        "EXN-SIGN-VERSION": "1",
        "EXN-DATA": _b64url(payload),
        "EXN-SIGN": _b64url(key.sign(payload)),
    }


def _get_json(host: str, path_with_query: str) -> dict:
    import requests
    r = requests.get(host + path_with_query, headers=signed_headers(path_with_query),
                     timeout=15, allow_redirects=False)
    if r.status_code != 200:
        raise RuntimeError("HTTP %d from %s" % (r.status_code, path_with_query.split("?")[0]))
    return r.json()


# The docs name these as review hosts for the Trader API and say the DNS widget host is
# the real one. They are only tried, in order, when EXN_DISCOVERY_BASE_URL is not set -
# and whichever answers is recorded, so the setting can be pinned afterwards.
REVIEW_HOSTS = ("https://api.exness.com", "https://api.exness-api.com")


def gateways() -> list:
    given = _env("EXN_DISCOVERY_BASE_URL")
    if given:
        return [_base_url(given)]
    return list(REVIEW_HOSTS)


def access_point(force: bool = False) -> str:
    """Resolve (and cache) the account's Access Point from the Gateway."""
    with _LOCK:
        hit = _STATE["access_point"]
    if hit and not force:
        return hit
    acc = _env("EXN_ACCOUNT_ID")
    if not re.fullmatch(r"[1-9][0-9]*", acc):
        raise ValueError("EXN_ACCOUNT_ID must be the numeric trading account number")
    tried = []
    for gw in gateways():
        try:
            d = _get_json(gw, "/v1/trading/access-point?account_id=" + acc)
        except Exception as e:
            tried.append("%s (%s)" % (gw, str(e)[:60]))
            continue
        ap = d.get("access_point") if isinstance(d, dict) else None
        if not isinstance(ap, str) or not ap:
            tried.append("%s (no access_point)" % gw)
            continue
        ap = ap.rstrip("/")
        with _LOCK:
            _STATE["access_point"] = ap
            _STATE["gateway"] = gw
        return ap
    raise RuntimeError("discovery failed: " + "; ".join(tried))


def account() -> dict:
    """Read-only account details - also the cheapest way to prove the key works."""
    ap = access_point()
    return _get_json(ap, "/v1/configuration/accounts/%s/account" % _env("EXN_ACCOUNT_ID"))


def _names(node, out=None) -> list:
    """Every instrument name a list response carries, whatever its shape.

    Exness answers {"instruments": ["XAUUSD", ...]} - plain strings - but other shapes
    are accepted too, so a schema change cannot quietly empty the list.
    """
    if out is None:
        out = []
    if isinstance(node, str):
        name = node.strip()
        if name and name not in out:
            out.append(name)
    elif isinstance(node, dict):
        picked = False
        for k in ("name", "symbol", "instrument", "code", "ticker"):
            v = node.get(k)
            if isinstance(v, str) and v.strip():
                if v.strip() not in out:
                    out.append(v.strip())
                picked = True
                break
        for v in node.values():
            if isinstance(v, (dict, list, str)) and not (picked and v is node.get(k)):
                _names(v, out)
    elif isinstance(node, list):
        for v in node:
            _names(v, out)
    return out


def instruments() -> list:
    """The account's own instrument names - the only spelling the tick socket accepts."""
    ap = access_point()
    paths = ("/v1/configuration/accounts/%s/instruments" % _env("EXN_ACCOUNT_ID"),
             "/v1/trading/accounts/%s/instruments" % _env("EXN_ACCOUNT_ID"),
             "/v1/configuration/instruments")
    tried = []
    for path in paths:
        try:
            d = _get_json(ap, path)
        except Exception as e:
            tried.append("%s -> %s" % (path.split("/instruments")[0].rsplit("/", 1)[-1],
                                       str(e)[:70]))
            continue
        names = _names(d)
        with _LOCK:
            _STATE["inst_raw"] = (json.dumps(d)[:800] if not isinstance(d, list)
                                  else json.dumps(d)[:800])
            _STATE["inst_error"] = ""
        if names:
            return names
        tried.append("%s -> no names in %d bytes" % (path, len(json.dumps(d))))
    with _LOCK:
        _STATE["inst_error"] = "; ".join(tried)[:400]
    return []


def _norm(name) -> str:
    return "".join(ch for ch in str(name or "").upper() if ch.isalnum())


def pick_gold(names, wanted=None) -> str:
    """Choose the gold contract out of the account's own list.

    Exact name first, then the plain XAUUSD spelling, then any gold contract, so a
    suffix such as XAUUSDm is found instead of being rejected by the exchange.
    """
    clean = [n for n in names if isinstance(n, str) and n.strip()]
    if not clean:
        return ""
    want = _norm(wanted or "")
    for n in clean:
        if _norm(n) == want:
            return n
    for n in clean:
        if _norm(n) == "XAUUSD":
            return n
    for n in clean:
        if _norm(n).startswith("XAUUSD"):
            return n
    for n in clean:
        if _norm(n).startswith("XAU"):
            return n
    return ""


def resolve_symbol(force: bool = False) -> str:
    """Ask the account which gold instrument it actually has, and use that exact name."""
    with _LOCK:
        hit = _STATE["symbol_active"]
    if hit and not force:
        return hit
    try:
        names = instruments()
    except Exception as e:
        _set(symbol_error=str(e)[:120])
        return _STATE["symbol_active"] or SYMBOL
    pick = pick_gold(names, SYMBOL) or SYMBOL
    golds = [n for n in names if _norm(n).startswith("XAU")][:12]
    _set(symbol_active=pick, instruments_n=len(names), gold_names=golds, symbol_error="")
    return pick


def active_symbol() -> str:
    return _STATE["symbol_active"] or SYMBOL


# ------------------------------------------------------------------ tick parsing
_NUM_PATHS = {
    "bid": ("bid", "b", "bidPrice", "bid_price"),
    "ask": ("ask", "a", "askPrice", "ask_price"),
    "price": ("price", "p", "last", "lastPrice", "last_price", "value"),
    "volume": ("volume", "vol", "v", "size", "qty", "quantity", "amount"),
    "sym": ("symbol", "instrument", "sym", "ticker", "instrument_id"),
    "ts": ("ts", "time", "timestamp", "t", "datetime", "created_at",
           "time_ms", "timestamp_ms"),
}


def _walk(node, out):
    """Every dict inside the frame, depth first - the tick schema is not assumed."""
    if isinstance(node, dict):
        out.append(node)
        for v in node.values():
            _walk(v, out)
    elif isinstance(node, list):
        for v in node:
            _walk(v, out)
    return out


def _first(d: dict, names):
    for n in names:
        if n in d and d[n] not in (None, ""):
            return d[n]
    return None


def _to_float(v):
    try:
        f = float(v)
        return f if f == f and abs(f) != float("inf") else None
    except Exception:
        return None


def _to_ts(v):
    """Seconds, from an ISO stamp, seconds, milliseconds, microseconds or nanoseconds.

    Exness stamps its ticks as ISO-8601 text ("2026-11-26T15:35:21.28Z"), so a number
    parser alone would drop every timestamp and fall back to arrival time.
    """
    if isinstance(v, str) and ("-" in v and ":" in v):
        import datetime
        try:
            txt = v.strip().replace("Z", "+00:00")
            dt = datetime.datetime.fromisoformat(txt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=datetime.timezone.utc)
            return dt.timestamp()
        except Exception:
            return None
    f = _to_float(v)
    if f is None or f <= 0:
        return None
    while f > 1e11:            # anything above ~year 5138 in seconds is a finer unit
        f /= 1000.0
    return f


def parse_ticks(frame) -> list:
    """Pull every (sym, price, volume, ts) this frame carries, whatever shape it has.

    A tick is a frame node that has a price and (optionally) a timestamp. Bid and ask are
    used when there is no last/mid price, and the mid of the two is the price.
    """
    out = []
    for node in _walk(frame, []):
        bid = _to_float(_first(node, _NUM_PATHS["bid"]))
        ask = _to_float(_first(node, _NUM_PATHS["ask"]))
        price = _to_float(_first(node, _NUM_PATHS["price"]))
        if price is None and bid is not None and ask is not None:
            price = (bid + ask) / 2.0
        if price is None or price <= 0:
            continue
        vol = _to_float(_first(node, _NUM_PATHS["volume"]))
        sym = _first(node, _NUM_PATHS["sym"])
        ts = _to_ts(_first(node, _NUM_PATHS["ts"]))
        out.append({
            "sym": str(sym).upper() if sym is not None else "",
            "price": price,
            "volume": vol if (vol is not None and vol > 0) else None,
            "ts": ts or time.time(),
            # the two sides of the quote are kept: they are the only honest source for a
            # bid, an ask and a spread, and they are never derived from the mid
            "bid": bid if (bid is not None and bid > 0) else None,
            "ask": ask if (ask is not None and ask > 0) else None,
        })
    return out


def companions() -> list:
    return [c for c in COMPANIONS if c != active_symbol()]


def _is_companion(sym) -> bool:
    return _norm(sym) in [_norm(c) for c in COMPANIONS]


def _same_instrument(sym) -> bool:
    """Do these two names mean the same gold contract?

    Exness lists the standard account's gold as XAUUSDm and the raw/other feeds as
    XAUUSD, and the wire may send either whatever it was asked for. Comparing the
    letters only, and accepting either as a prefix of the other, keeps the tape
    intact instead of silently dropping every tick.
    """
    a = _norm(sym)
    b = _norm(active_symbol())
    if not a or not b:
        return not a                       # a tick with no name is the feed we asked for
    return a == b or a.startswith(b) or b.startswith(a)


def _seen_before(sym: str, stamp: float, price: float, now: float) -> bool:
    """Has this exact quote already been booked? A re-delivered frame must not double volume."""
    key = (sym, round(stamp, 3), round(price, 6))
    when = _SEEN.get(key)
    if when is not None and now - when < 5.0:
        return True
    _SEEN[key] = now
    if len(_SEEN) > _SEEN_MAX:
        for k in list(_SEEN)[:_SEEN_MAX // 2]:
            _SEEN.pop(k, None)
    return False


def ingest(ticks) -> int:
    """Book the ticks, classifying each as buying (price rose) or selling (it fell).

    A tick is dropped only when it cannot be a trade at all: no usable price, an
    instrument this desk does not chart, or an exact re-delivery of one already booked.
    A tick that arrives behind a newer one is kept - the candle builder sorts by event
    time, so the candle's close is still the last quote of the interval - and counted
    as late so the diagnostics can say so.
    """
    added = 0
    now = time.time()
    with _LOCK:
        rows_to_write = []
        for t in ticks:
            sym = t.get("sym") or active_symbol()
            if not (_same_instrument(sym) or _is_companion(sym)):
                _STATE["rejected"] += 1
                continue
            price = t.get("price")
            try:
                price = float(price)
            except (TypeError, ValueError):
                price = None
            if price is None or price <= 0 or price != price:
                _STATE["invalid"] += 1
                continue
            stamp = t["ts"] or now
            if _seen_before(sym, stamp, price, now):
                _STATE["duplicates"] += 1
                continue
            newest = _LAST_TS.get(sym)
            if newest is not None and stamp < newest - 0.5:
                _STATE["late"] += 1
            else:
                _LAST_TS[sym] = stamp
            last = _LAST_PX.get(sym)
            if last is None or price == last:
                side = 0                      # a repeat of the same quote votes for nobody
            else:
                side = 1 if price > last else -1
            _TICKS.append((stamp, price, side, t.get("volume"), sym))
            _LAST_PX[sym] = price
            bid, ask = t.get("bid"), t.get("ask")
            if bid and ask and ask >= bid:
                _LAST_BOOK[sym] = (bid, ask, stamp)
            rows_to_write.append((stamp, price, side, t.get("volume"), sym))
            added += 1
        if added:
            _STATE["last_tick"] = now
            _STATE["parsed"] += added
            if ticks and ticks[-1].get("sym"):
                _STATE["symbol_seen"] = ticks[-1]["sym"]
        cutoff = now - KEEP_S
        while _TICKS and _TICKS[0][0] < cutoff:
            _TICKS.popleft()
    if added:
        st = store()
        if st is not None:
            try:
                st.add(rows_to_write)
                if int(now) % 600 < 2:        # prune roughly every ten minutes
                    st.prune(now)
            except Exception as e:            # pragma: no cover - disk problems only
                print("tape write:", str(e)[:120])
    return added


# ------------------------------------------------------------------ the reading
def snapshot(sym: str = "") -> dict:
    """What the tape says now, over three windows. Every number is counted, not modelled."""
    now = time.time()
    sym = sym or auto_symbol()
    with _LOCK:
        ticks = [t for t in _TICKS if _norm(t[4]) == _norm(sym)]
        state = dict(_STATE)
    last_price = ticks[-1][1] if ticks else None
    age = (now - state["last_tick"]) if state["last_tick"] else None
    windows = {}
    for w in WINDOWS:
        cut = now - w
        buy = sell = flat = 0.0
        n = 0
        first_px = None
        for ts, px, side, vol, *rest in ticks:
            if ts < cut:
                continue
            n += 1
            if first_px is None:
                first_px = px
            weight = vol if vol else 1.0     # lots when the wire sends them, ticks otherwise
            if side > 0:
                buy += weight
            elif side < 0:
                sell += weight
            else:
                flat += weight
        total = buy + sell
        windows["%ds" % w] = {
            "buy": round(buy, 3), "sell": round(sell, 3), "flat": round(flat, 3),
            "delta": round(buy - sell, 3),
            "ratio": (round(buy / total, 3) if total else None),
            "ticks": n,
            "change": (round(px_change(first_px, last_price), 4)
                       if first_px is not None and last_price is not None else None),
        }
    status = "not_configured" if not configured() else state["status"]
    # a socket that is up but has printed nothing for a while is quiet, not live -
    # including the case where it has never printed anything at all
    if status == "live":
        quiet_for = age if age is not None else (
            (now - state["started"]) if state.get("started") else None)
        if quiet_for is not None and quiet_for > 90:
            status = "quiet"
    return {
        "status": status,
        "proxy": True,
        "sym": sym,
        "unit": ("lots" if any(t[3] for t in ticks) else "ticks"),
        "price": (round(last_price, 4) if last_price is not None else None),
        "age": (round(age, 1) if age is not None else None),
        "stale": bool(age is None or age > 60),
        "windows": windows,
        "source": "Exness Trading API · ticks",
        "windows_s": list(WINDOWS),
        "connected": state["connected"],
        "error": state["error"],
        "method": ("Each tick is booked as buying when the quoted price rises and selling "
                   "when it falls; the delta is their difference. A retail broker does not "
                   "publish per-trade aggressor side, so this is a tick-rule proxy, not "
                   "exchange order flow."),
    }


def px_change(a, b):
    if a is None or b is None or not a:
        return None
    return (b - a) / a * 100.0


def state() -> dict:
    with _LOCK:
        s = dict(_STATE)
    s["configured"] = configured()
    s["missing"] = missing()
    s["gateway"] = s.get("gateway") or ""
    s["symbol"] = SYMBOL
    s["symbol_active"] = active_symbol()
    s["crypto"] = _CRYPTO
    return s


# ------------------------------------------------------------------ the worker
def _set(**kw):
    with _LOCK:
        _STATE.update(kw)


def _ws_loop():
    import websocket                      # websocket-client, already a dependency
    backoff = RECONNECT_S
    while True:
        try:
            # The published hours are a guide, not a command: the socket is tried even
            # during the scheduled break, because a real quote outranks a calendar.
            import tape as _TP
            shut = not _TP.market_state(time.time())["open"]
            _set(status="closed" if shut else "connecting", connected=False, error="")
            ap = access_point()
            host = ap.split("://", 1)[1]
            sym = resolve_symbol()
            path = "/v1/server-events/accounts/%s/ws/ticks" % _env("EXN_ACCOUNT_ID")
            headers = signed_headers(path, method="GET")
            ws = websocket.create_connection("wss://" + host + path, header=headers, timeout=20)
            _set(connected=True, status="live", error="", started=time.time())
            book = [sym] + companions()
            ws.send(json.dumps({"id": "ticks-%s" % _norm(sym).lower(),
                                "subscribe": {"event": "ticks", "instruments": book}}))
            _set(book=book)
            while True:
                raw = ws.recv()
                if not raw:
                    continue
                try:
                    frame = json.loads(raw)
                except Exception:
                    continue
                with _LOCK:
                    _STATE["messages"] += 1
                    _STATE["sample"] = raw[:900]
                err = frame.get("error_message") if isinstance(frame, dict) else None
                if err:
                    _set(error="%s: %s" % (frame.get("code"), str(err)[:120]))
                    if "INSTRUMENT_NOT_FOUND" in str(err).upper():
                        _set(symbol_active="", symbol_error=str(err)[:120])  # re-resolve
                got = parse_ticks(frame)
                if got:
                    ingest(got)
        except Exception as e:            # auth, network, schema - all recoverable
            msg = str(e)[:160]
            try:
                import tape as _TP
                shut = not _TP.market_state(time.time())["open"]
            except Exception:
                shut = False
            _set(connected=False, status="closed" if shut else "error",
                 error="" if shut else msg)
            print("orderflow:", msg)
            time.sleep(max(backoff, 30.0) if shut else backoff)
            backoff = min(backoff * 1.6, 60.0)
        else:                             # pragma: no cover
            time.sleep(RECONNECT_S)


def probe(symbols, seconds: int = 5) -> dict:
    """Owner-only: ask the exchange, per instrument, whether it is printing anything.

    This is the difference between "my calendar says gold is shut" and "the exchange
    answered for these instruments and stayed silent for gold" - so a quiet feed can be
    diagnosed instead of argued about.
    """
    import websocket
    out = {"at": time.time(), "access_point": "", "results": {}, "known_gold": []}
    try:
        ap = access_point()
        out["access_point"] = ap
        host = ap.split("://", 1)[1]
        try:
            out["known_gold"] = [n for n in instruments() if _norm(n).startswith("XAU")][:12]
        except Exception:
            pass
        path = "/v1/server-events/accounts/%s/ws/ticks" % _env("EXN_ACCOUNT_ID")
        for sym in [s.strip() for s in symbols if s and s.strip()][:6]:
            row = {"ticks": 0, "frames": 0, "error": "", "sample": None}
            try:
                ws = websocket.create_connection("wss://" + host + path,
                                                 header=signed_headers(path, method="GET"),
                                                 timeout=6)
                ws.send(json.dumps({"id": "probe-%s-%d" % (_norm(sym).lower(), int(time.time())),
                                    "subscribe": {"event": "ticks", "instruments": [sym]}}))
                t0 = time.time()
                ws.settimeout(1.0)
                while time.time() - t0 < seconds:
                    try:
                        raw = ws.recv()
                    except Exception:
                        continue
                    if not raw:
                        continue
                    row["frames"] += 1
                    try:
                        frame = json.loads(raw)
                    except Exception:
                        continue
                    err = frame.get("error_message") if isinstance(frame, dict) else None
                    if err:
                        row["error"] = str(err)[:120]
                        break
                    got = parse_ticks(frame)
                    if got:
                        row["ticks"] += len(got)
                        row["sample"] = row["sample"] or raw[:200]
                ws.close()
            except Exception as e:
                row["error"] = str(e)[:120]
            out["results"][sym] = row
    except Exception as e:
        out["error"] = str(e)[:160]
    return out


def start() -> bool:
    """One worker thread, started from the first request that needs it."""
    if not configured():
        _set(status="not_configured")
        return False
    with _LOCK:
        if _STATE["worker"]:
            return True
        _STATE["worker"] = True
    threading.Thread(target=_ws_loop, daemon=True, name="exness-orderflow").start()
    return True
