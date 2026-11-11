"""ASTRA6 phone push - a real card on the lock screen while the app is shut.

How it works, honestly:
  * the page asks the phone for permission, then hands the browser's own push
    endpoint to this module;
  * the rules that travel with it are the trader's own - price above / below /
    cross, RSI above / below, and (opt-in) the market-read card;
  * a background thread re-reads real prices from the same feeds the chart uses
    and, when a rule is met, asks the browser's push service to wake the phone;
  * the service worker draws the card: title, the numbers, the market, the time.

House rules kept from the rest of the app:
  * nothing is invented - the pushed numbers come from the same candles the
    chart draws, and a feed that is down produces no push at all;
  * if the app is open on the screen the page's own alert already rang, so the
    push is skipped (a heartbeat from the page marks it awake);
  * the VAPID keys live in the environment, never in this file;
  * a dead subscription (404 / 410 from the push service) is dropped, not
    retried forever.
"""
import json
import os
import threading
import time

BASE = os.path.dirname(os.path.abspath(__file__))
# The subscription list used to live beside the code, which on a hosted instance is wiped by
# every deploy - so a phone that had asked to be told quietly stopped being told. It goes in
# the data directory with the rest of the app's own records, and the old path is still read
# once so an existing store is not lost.
_DATA = os.getenv("ASTRA6_DATA") or "/tmp"
SUBS_FILE = os.path.join(_DATA, "astra6_push_subs.json")
_OLD_FILE = os.path.join(BASE, "push_subs.json")
_LOCK = threading.Lock()
AWAKE_SECONDS = 45.0          # the page pings this often while it is on screen
READ_COOLDOWN = 5 * 60.0      # never two cards for the same symbol inside five minutes
MAX_PER_HOUR = 6              # and never more than six cards an hour, whatever happens
STARTED = [time.time()]
MAX_SUBS = 400
LAST_SCAN = [0.0]          # when the rule engine last walked the subscribers

# filled in by main.py at import time
_quote_fn = None
_rsi_fn = None
_read_fn = None
_fund_fn = None

# The news reading is a different kind of animal from a price rule: it is rebuilt on a
# fixed 5-minute clock and it can sit on one side for hours. So it may ring only when the
# reading actually turns over, and never more than a few times a day.
FUND_COOLDOWN = 45 * 60
FUND_MAX_DAY = 4
FUND_MIN_CONF = 45
FUND_MIN_SCORE = 0.45


def configure(quote_fn=None, rsi_fn=None, read_fn=None, fund_fn=None):
    global _quote_fn, _rsi_fn, _read_fn, _fund_fn
    if quote_fn:
        _quote_fn = quote_fn
    if rsi_fn:
        _rsi_fn = rsi_fn
    if read_fn:
        _read_fn = read_fn
    if fund_fn:
        _fund_fn = fund_fn


# ------------------------------------------------------------------ keys
def _env(name):
    return (os.getenv(name) or "").strip()


def private_key():
    return _env("VAPID_PRIVATE_KEY") or _env("VAPID_PRIV")


def public_key():
    return _env("VAPID_PUBLIC_KEY")


def subject():
    return _env("VAPID_SUBJECT") or "mailto:alerts@astra6.app"


def ready():
    return bool(private_key() and public_key())


def status():
    age = (time.time() - LAST_SCAN[0]) if LAST_SCAN[0] else None
    return {"status": "ok", "ready": ready(), "publicKey": public_key(),
            "subscribers": len(subscribers()), "awakeSeconds": AWAKE_SECONDS,
            "encoder": "webpush-aes128gcm",
            # the honest answer to "will it ring while my phone is in my pocket?"
            "lastScanAge": (round(age, 1) if age is not None else None),
            "watching": bool(LAST_SCAN[0] and age is not None and age < 120),
            "scanEvery": 20, "uptime": round(time.time() - STARTED[0], 1)}


# ------------------------------------------------------------------ storage
def _load():
    for path in (SUBS_FILE, _OLD_FILE):
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
                rows = d if isinstance(d, list) else []
            if path == _OLD_FILE and rows:
                _save(rows)          # migrate it to the data directory once
            return rows
        except Exception:
            continue
    return []


def _save(rows):
    try:
        with open(SUBS_FILE, "w", encoding="utf-8") as f:
            json.dump(rows[-MAX_SUBS:], f)
        return True
    except Exception as e:
        print("push store:", e)
        return False


STALE_DAYS = 30


def subscribers():
    with _LOCK:
        rows = _load()
    # an endpoint that has not been seen for a month is a phone that moved on. Keeping it
    # means one phone can receive the same card from three dead subscriptions at once,
    # which is exactly how "one alert" turns into a burst.
    now = time.time()
    live = [r for r in rows if now - float(r.get("seen") or r.get("added") or 0) < STALE_DAYS * 86400]
    return live


def _endpoint_of(sub):
    if isinstance(sub, dict):
        return sub.get("endpoint") or ""
    return ""


def add(rec):
    """One record per browser endpoint; re-subscribing replaces the old rules."""
    ep = _endpoint_of(rec.get("subscription"))
    if not ep:
        return False
    rec["endpoint"] = ep
    rec["added"] = rec.get("added") or time.time()
    rec["seen"] = time.time()
    with _LOCK:
        rows = [r for r in _load() if r.get("endpoint") != ep]
        rows.append(rec)
        rows = rows[-MAX_SUBS:]
        _save(rows)
    return True


def remove(endpoint):
    with _LOCK:
        rows = [r for r in _load() if r.get("endpoint") != endpoint]
        _save(rows)
    return True


def touch(endpoint):
    with _LOCK:
        rows = _load()
        for r in rows:
            if r.get("endpoint") == endpoint:
                r["seen"] = time.time()
        _save(rows)
    return True


def set_rules(endpoint, rules, read_card=None, awake=True):
    with _LOCK:
        rows = _load()
        for r in rows:
            if r.get("endpoint") != endpoint:
                continue
            old = {str(x.get("id")): x for x in (r.get("rules") or [])}
            new = []
            for x in (rules or [])[:40]:
                if not isinstance(x, dict) or not x.get("sym") or not x.get("kind"):
                    continue
                item = {"id": str(x.get("id") or ""), "sym": str(x["sym"]).upper(),
                        "kind": str(x["kind"]), "price": float(x.get("price") or 0)}
                # a rule that was already pushed is not pushed again until it is re-armed
                if item["id"] in (r.get("fired") or {}):
                    was = old.get(item["id"]) or {}
                    if abs(float(was.get("price") or 0) - item["price"]) < 1e-9:
                        item["done"] = True
                new.append(item)
            r["rules"] = new
            if read_card is not None:
                r["readCard"] = {"on": bool(read_card.get("on")),
                                 "syms": [str(s).upper() for s in (read_card.get("syms") or [])][:8]}
            # awake = the page is on screen; asleep means ring the phone right away
            r["seen"] = time.time() if awake else 0
        _save(rows)
    return True


# ------------------------------------------------------------------ sending
def _send(subscription, payload):
    """One push. Returns (ok, status_code)."""
    try:
        from pywebpush import webpush, WebPushException
    except Exception as e:
        return False, "no_encoder:" + str(e)[:60]
    try:
        webpush(subscription_info=subscription,
                data=json.dumps(payload, separators=(",", ":")),
                vapid_private_key=private_key(),
                vapid_claims={"sub": subject()},
                ttl=3600, timeout=12)
        return True, 201
    except Exception as e:
        code = None
        try:
            code = e.response.status_code          # WebPushException
        except Exception:
            pass
        return False, code or str(e)[:80]


def send_to(rec, payload):
    ok, code = _send(rec.get("subscription") or {}, payload)
    if not ok and code in (404, 410):
        remove(rec.get("endpoint"))
        print("push dropped dead endpoint", rec.get("endpoint", "")[:48])
    elif not ok:
        print("push failed", code)
    return ok, code


def card(title, body, sym=None, kind="alert", tag=None, extra=None):
    """The card the phone shows. Title is the line that fits a lock screen."""
    p = {"title": title[:90], "body": body[:300], "sym": (sym or "").upper(),
         "kind": kind, "tag": tag or "astra6-" + kind + "-" + (sym or "app"),
         "ts": int(time.time()),
         "url": "/?src=push" + ("&sym=" + sym.upper() if sym else "") + "#chart"}
    if extra:
        p.update(extra)
    return p


# ------------------------------------------------------------------ rules
def _money(v, sym=""):
    try:
        v = float(v)
    except Exception:
        return "—"
    dec = 2
    if sym == "XAGUSD":
        dec = 3
    elif sym in ("XPTUSD", "XPDUSD"):
        dec = 1
    return "$" + format(round(v, dec), ",." + str(dec) + "f")


def quote(sym):
    if not _quote_fn:
        return None
    try:
        q = _quote_fn(sym)
        if q and q.get("price"):
            return q
    except Exception as e:
        print("push quote", sym, str(e)[:80])
    return None


# ONE MARKET: the site is a gold terminal. A rule saved for any other pair (from an older
# build) is ignored here rather than waking a phone for something that cannot be traded.
ALLOWED_SYMBOLS = ("XAUUSD",)


def eval_rules(rec):
    """Every armed rule on this device, checked against the real price now."""
    out = []
    rules = rec.get("rules") or []
    if not rules:
        return out
    last = rec.setdefault("last", {})
    fired = rec.setdefault("fired", {})
    for r in rules:
        if r.get("done") or str(r.get("id")) in fired:
            continue
        sym = r["sym"]
        if str(sym).upper() not in ALLOWED_SYMBOLS:
            continue          # a rule for a pair this site no longer carries is dead weight
        kind = r["kind"]
        lvl = float(r.get("price") or 0)
        # the signal rule rings with whatever side the read gives - SELL when the read
        # says sell, BUY when it says buy. read_buy / read_sell stay for older arms.
        if kind in ("signal", "read_buy", "read_sell"):
            rd = _read_fn(sym) if _read_fn else None
            if not rd:
                continue
            typ = (rd.get("state") or "").split("|")[0].upper()
            if typ not in ("BUY", "SELL"):
                continue
            want = typ
            if kind == "read_buy":
                want = "BUY"
            elif kind == "read_sell":
                want = "SELL"
            if typ == want:
                fired[str(r["id"])] = time.time()
                out.append(card(
                    rd.get("title") or ("%s · %s signal" % (sym, typ)),
                    (rd.get("body") or "") + " · a read of the volume, not a guarantee",
                    sym, "read", "astra6-signal-" + str(r["id"])))
            continue
        if not lvl:
            continue
        if kind.startswith("rsi"):
            rsi = _rsi_fn(sym) if _rsi_fn else None
            if rsi is None:
                continue
            up = kind == "rsi_above"
            if (up and rsi >= lvl) or (not up and rsi <= lvl):
                fired[str(r["id"])] = time.time()
                out.append(card(
                    "%s RSI(14) %s %s" % (sym, "above" if up else "below", _num(lvl, 1)),
                    "RSI(14) is %s now · read from the %s closes on the chart" % (_num(rsi, 1), sym),
                    sym, "alert", "astra6-rsi-" + str(r["id"])))
            continue
        q = quote(sym)
        if not q:
            continue
        px = float(q["price"])
        prev = last.get(sym)
        hit = False
        if kind == "above":
            hit = px >= lvl
        elif kind == "below":
            hit = px <= lvl
        elif kind == "cross":
            hit = prev is not None and ((prev < lvl <= px) or (prev > lvl >= px))
        if hit:
            fired[str(r["id"])] = time.time()
            chg = q.get("change_pct")
            chg_txt = ("%+.2f%% today" % float(chg)) if chg is not None else "live"
            out.append(card(
                "%s %s %s" % (sym, "above" if kind == "above" else ("below" if kind == "below" else "crossed"), _money(lvl, sym)),
                "price %s · %s · %s" % (_money(px, sym), chg_txt, q.get("source") or "live feed"),
                sym, "alert", "astra6-alt-" + str(r["id"])))
        last[sym] = px
    return out


def _num(v, dec=2):
    try:
        return format(round(float(v), dec), ",." + str(dec) + "f")
    except Exception:
        return "—"


def fund_decision(prev_side, side, score, conf, last_ts, day_count, now):
    """Should a fundamentals flip ring the phone? (ring, reason)

    Kept pure and separate so the rule can be tested without a push service. The point of
    the checks is that a headline reading is noisy: it must actually change side, be strong
    enough to mean something, and it may not wake anyone more than a few times a day.
    """
    side = str(side or "").upper()
    if side not in ("BUY", "SELL"):
        return False, "no side"
    if str(prev_side or "").upper() == side:
        return False, "same side"
    try:
        score, conf = abs(float(score or 0)), float(conf or 0)
    except Exception:
        return False, "no numbers"
    if score < FUND_MIN_SCORE:
        return False, "reading too weak"
    if conf < FUND_MIN_CONF:
        return False, "confidence too low"
    if last_ts and (now - float(last_ts)) < FUND_COOLDOWN:
        return False, "cooling down"
    if int(day_count or 0) >= FUND_MAX_DAY:
        return False, "daily cap"
    return True, "flipped"


def fund_cards(rec):
    """The gold-fundamentals card: rings when the news reading turns from one side to the other."""
    fc = rec.get("fundCard") or {}
    if not fc.get("on") or not _fund_fn:
        return []
    try:
        d = _fund_fn(fc.get("sym") or "XAUUSD")
    except Exception as e:
        print("push fund", str(e)[:80])
        return []
    if not d:
        return []
    side = str(d.get("side") or "").upper()
    state = rec.setdefault("fundState", {})
    key = fc.get("sym") or "XAUUSD"
    prev = state.get(key) or {}
    now = time.time()
    day = int(now // 86400)
    if int(prev.get("day") or 0) != day:
        prev = {"side": prev.get("side"), "day": day, "n": 0, "at": prev.get("at") or 0}
    ok, why = fund_decision(prev.get("side"), side, d.get("score"), d.get("confidence"),
                            prev.get("at"), prev.get("n"), now)
    # the first sighting is remembered, never rung: waking a phone to announce that
    # something has been true all day is exactly the spam this had to stop being
    first = not prev.get("side")
    state[key] = {"side": side or prev.get("side"), "day": day,
                  "n": prev.get("n") or 0, "at": prev.get("at") or 0}
    if first or not ok or not d.get("title"):
        return []
    state[key] = {"side": side, "day": day, "n": int(prev.get("n") or 0) + 1, "at": now}
    return [card(d.get("title"), d.get("body") or "", key, "fund", "astra6-fund-" + key)]


def read_cards(rec):
    """The market-read card, only when the read actually changes."""
    rc = rec.get("readCard") or {}
    if not rc.get("on") or not _read_fn:
        return []
    state = rec.setdefault("readState", {})
    out = []
    for sym in rc.get("syms") or []:
        if str(sym).upper() not in ALLOWED_SYMBOLS:
            continue
        try:
            d = _read_fn(sym)
        except Exception as e:
            print("push read", sym, str(e)[:80])
            continue
        if not d:
            continue
        now = d.get("state")
        if not now:
            continue
        if state.get(sym) == now:
            continue
        first = sym not in state
        # A HOLD is not news. The whole point of the card is "there is a signal now";
        # ringing the phone to say "nothing is happening" is the spam this used to be.
        _side = str(now).upper().split("|")[0]
        if _side not in ("BUY", "SELL"):
            state[sym] = now              # remember it, but stay quiet
            continue
        if first:
            state[sym] = now
            continue                      # only a change is news, not the first sighting
        stamp = rec.setdefault("readAt", {})
        if time.time() - float(stamp.get(sym) or 0) < READ_COOLDOWN:
            # blocked, so the change is NOT consumed: it rings when the window clears if
            # that side is still on. Dropping it would silently lose a real signal.
            continue
        state[sym] = now
        stamp[sym] = time.time()
        out.append(card(d.get("title") or (sym + " read"), d.get("body") or "",
                        sym, "read", "astra6-read-" + sym))
    return out


# ------------------------------------------------------------------ the loop
def scan_once(force=False):
    """Walk every subscriber once. Returns how many pushes actually left."""
    if not ready():
        return 0
    subs = subscribers()
    LAST_SCAN[0] = time.time()      # proof of life, even with nothing armed
    if not subs:
        return 0
    now = time.time()
    sent = 0
    for rec in subs:
        try:
            awake = (now - float(rec.get("seen") or 0)) < AWAKE_SECONDS
            events = []
            if not awake or force:
                events = eval_rules(rec) + read_cards(rec) + fund_cards(rec)
            if not events:
                continue
            hist = [t for t in (rec.get("sentAt") or []) if now - float(t) < 3600]
            rec["sentAt"] = hist
            for ev in events:
                if len(hist) >= MAX_PER_HOUR:
                    print("push hourly cap reached, holding the rest")
                    break
                ok, _ = send_to(rec, ev)
                if ok:
                    sent += 1
                    hist.append(now)
            # the fired marks and last prices are part of the record
            with _LOCK:
                rows = _load()
                for r in rows:
                    if r.get("endpoint") == rec.get("endpoint"):
                        r["fired"] = rec.get("fired") or {}
                        r["last"] = rec.get("last") or {}
                        r["readState"] = rec.get("readState") or {}
                        r["readAt"] = rec.get("readAt") or {}
                        r["fundState"] = rec.get("fundState") or {}
                        r["sentAt"] = rec.get("sentAt") or []
                _save(rows)
        except Exception as e:
            print("push scan", str(e)[:120])
    return sent


def _loop():
    time.sleep(25)
    while True:
        try:
            scan_once()
        except Exception as e:
            print("push loop", str(e)[:120])
        time.sleep(20)


def start():
    try:
        threading.Thread(target=_loop, daemon=True, name="webpush").start()
        print("webpush thread:", "ready" if ready() else "no VAPID keys")
    except Exception as e:
        print("webpush thread:", e)
