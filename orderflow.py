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
WINDOWS = (60, 300, 900)                 # 1m, 5m, 15m
KEEP_S = 900                             # how much tick history is held in memory
RECONNECT_S = 5.0

_LOCK = threading.Lock()
_TICKS = collections.deque()             # (ts, price, side, volume)
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
    "sample": None,                      # the last raw frame, for field discovery
    "symbol_seen": "",
}


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
    "ts": ("ts", "time", "timestamp", "t", "time_ms", "timestamp_ms"),
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
    """Seconds, from seconds, milliseconds, microseconds or nanoseconds."""
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
        })
    return out


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


def ingest(ticks) -> int:
    """Book the ticks, classifying each as buying (price rose) or selling (it fell)."""
    added = 0
    now = time.time()
    with _LOCK:
        last = _TICKS[-1][1] if _TICKS else None
        for t in ticks:
            if not _same_instrument(t.get("sym")):
                continue
            price = t["price"]
            if last is None or price == last:
                side = 0                      # a repeat of the same quote votes for nobody
            else:
                side = 1 if price > last else -1
            _TICKS.append((t["ts"] or now, price, side, t.get("volume")))
            last = price
            added += 1
        if added:
            _STATE["last_tick"] = now
            _STATE["parsed"] += added
            if ticks and ticks[-1].get("sym"):
                _STATE["symbol_seen"] = ticks[-1]["sym"]
        cutoff = now - KEEP_S
        while _TICKS and _TICKS[0][0] < cutoff:
            _TICKS.popleft()
    return added


# ------------------------------------------------------------------ the reading
def snapshot() -> dict:
    """What the tape says now, over three windows. Every number is counted, not modelled."""
    now = time.time()
    with _LOCK:
        ticks = list(_TICKS)
        state = dict(_STATE)
    last_price = ticks[-1][1] if ticks else None
    age = (now - state["last_tick"]) if state["last_tick"] else None
    windows = {}
    for w in WINDOWS:
        cut = now - w
        buy = sell = flat = 0.0
        n = 0
        first_px = None
        for ts, px, side, vol in ticks:
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
    return {
        "status": status,
        "proxy": True,
        "sym": active_symbol(),
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
            _set(status="connecting", connected=False, error="")
            ap = access_point()
            host = ap.split("://", 1)[1]
            sym = resolve_symbol()
            path = "/v1/server-events/accounts/%s/ws/ticks" % _env("EXN_ACCOUNT_ID")
            headers = signed_headers(path, method="GET")
            ws = websocket.create_connection("wss://" + host + path, header=headers, timeout=20)
            _set(connected=True, status="live", error="", started=time.time())
            ws.send(json.dumps({"id": "ticks-%s" % _norm(sym).lower(),
                                "subscribe": {"event": "ticks", "instruments": [sym]}}))
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
            _set(connected=False, status="error", error=msg)
            print("orderflow:", msg)
            time.sleep(backoff)
            backoff = min(backoff * 1.6, 60.0)
        else:                             # pragma: no cover
            time.sleep(RECONNECT_S)


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
