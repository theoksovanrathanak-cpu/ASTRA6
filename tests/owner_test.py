"""Owner publishing — the gates that must not leak.

    python3 tests/owner_test.py

Nothing here talks to Google or to the network: the Google check is exercised by its
refusals, and the session/validation/settings logic is tested directly.
"""
import os
import sys
import tempfile

os.environ.setdefault("ASTRA6_DATA_DIR", tempfile.mkdtemp(prefix="astra6-owner-"))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import owner as O  # noqa: E402
import orderflow as OF  # noqa: E402
import time  # noqa: E402

PASS = FAIL = 0


def check(name, cond, extra=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  PASS  " + name)
    else:
        FAIL += 1
        print("  FAIL  " + name + ("" if extra is None else "  " + repr(extra)))


def raises(fn, status=None):
    try:
        fn()
        return False
    except O.HTTPException as e:
        return status is None or e.status_code == status
    except Exception:
        return False


print("google verification")
check("no client id configured is a clear 503, not a silent pass",
      raises(lambda: O.verify_google("x" * 60), 503))
O.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com"
check("an empty credential is refused", raises(lambda: O.verify_google(""), 400))
check("a short credential is refused", raises(lambda: O.verify_google("abc"), 400))

print("session")
tok = O.make_session(O.OWNER_EMAIL)
check("a session is issued for the owner", isinstance(tok, str) and tok.count(".") == 1)


class FakeReq:
    def __init__(self, cookie=None):
        self.cookies = {O.COOKIE: cookie} if cookie else {}


check("a good session reads back as the owner", O.read_session(FakeReq(tok)) == O.OWNER_EMAIL)
check("a tampered session is rejected", O.read_session(FakeReq(tok[:-1] + ("a" if tok[-1] != "a" else "b"))) is None)
check("any signed-in Google address reads back, but only the owner may publish",
      O.read_session(FakeReq(O.make_session("visitor@gmail.com"))) == "visitor@gmail.com"
      and raises(lambda: O.require_owner(FakeReq(O.make_session("visitor@gmail.com"))), 403)
      and O.require_owner(FakeReq(O.make_session(O.OWNER_EMAIL))) == O.OWNER_EMAIL)
try:
    import pushweb as _PW
    _c = _PW.signal_card({"id": "s1", "side": "BUY", "entry": 3520.5, "sl": 3512.0, "tp1": 3532.0})
    check("a published signal builds a real card", _c["title"].startswith("Desento") and "3,520.50" in _c["body"]
          and "3,512.00" in _c["body"] and _c["kind"] == "signal")
    check("the card carries no invented number", set(_c.keys()) >= {"title", "body", "sym", "kind", "tag", "ts", "url"})
    check("broadcast exists and is callable", callable(_PW.broadcast))
except Exception as _e:
    check("push module usable: " + str(_e), False)
check("no cookie means no owner", O.read_session(FakeReq()) is None)
check("require_owner raises 401 without a session", raises(lambda: O.require_owner(FakeReq()), 401))

print("a published signal has to be a real trade")


def sig(**kw):
    return O._clean_signal(O.SignalBody(**kw))


ok = sig(side="sell", entry=3560, sl=3572, tp1=3540, tp2=3520, note="  spaced  ")
check("a valid SELL is accepted", ok["side"] == "SELL" and ok["entry"] == 3560.0)
check("the note is trimmed", ok["note"] == "spaced")
check("the status defaults to open", ok["status"] == "open")
check("HOLD is not a side", raises(lambda: sig(side="HOLD", entry=1, sl=2), 400))
check("a BUY stop above the entry is refused", raises(lambda: sig(side="BUY", entry=10, sl=12), 400))
check("a SELL stop below the entry is refused", raises(lambda: sig(side="SELL", entry=10, sl=8), 400))
check("a BUY target below the entry is refused", raises(lambda: sig(side="BUY", entry=10, sl=9, tp1=9.5), 400))
check("a SELL target above the entry is refused", raises(lambda: sig(side="SELL", entry=10, sl=11, tp1=10.5), 400))
check("TP2 closer than TP1 on a BUY is refused", raises(lambda: sig(side="BUY", entry=10, sl=9, tp1=12, tp2=11), 400))
check("an unknown status is refused", raises(lambda: sig(side="BUY", entry=10, sl=9, status="moon"), 400))
check("TP3 is kept when given", sig(side="BUY", entry=10, sl=9, tp1=11, tp2=12, tp3=13)["tp3"] == 13)

print("the owner can correct a published signal")


class REdit:
    cookies = {O.COOKIE: tok}


class RGuest:
    cookies = {}


O._write("signals.json", [{"id": "s-edit", "side": "BUY", "entry": 10.0, "sl": 9.0, "tp1": 11.0,
                           "tp2": 12.0, "tp3": 13.0, "status": "open", "note": "first", "ts": 0}])
try:
    row = O.signals_patch("s-edit", O.SignalPatch(side="sell", entry=10, sl=11, tp1=9, tp2=8, tp3=None,
                                                  replace=True, note="  fixed  ", status="tp1 hit"),
                          REdit())["signal"]
    check("the side can be flipped after posting", row["side"] == "SELL")
    check("the numbers are rewritten", (row["entry"], row["sl"], row["tp1"], row["tp2"]) == (10.0, 11.0, 9.0, 8.0))
    check("an emptied target is cleared, not kept", row["tp3"] is None)
    check("the note is trimmed on edit", row["note"] == "fixed")
    check("the status can be set on edit", row["status"] == "tp1 hit")
    check("without replace an empty target is left alone",
          O.signals_patch("s-edit", O.SignalPatch(tp3=7.0), REdit())["signal"]["tp3"] == 7.0)
    check("a stop on the wrong side of the edit is refused",
          raises(lambda: O.signals_patch("s-edit", O.SignalPatch(sl=8.0), REdit()), 400))
    check("a target on the wrong side of the edit is refused",
          raises(lambda: O.signals_patch("s-edit", O.SignalPatch(tp1=10.5), REdit()), 400))
    check("targets out of order after an edit are refused",
          raises(lambda: O.signals_patch("s-edit", O.SignalPatch(tp1=6.0), REdit()), 400))
    check("an unknown side is refused", raises(lambda: O.signals_patch("s-edit", O.SignalPatch(side="HOLD"), REdit()), 400))
    check("a visitor cannot edit a signal", raises(lambda: O.signals_patch("s-edit", O.SignalPatch(note="x"), RGuest()), 401))
    check("editing something that is gone is a 404",
          raises(lambda: O.signals_patch("nope", O.SignalPatch(note="x"), REdit()), 404))
    check("the owner can delete it", O.signals_delete("s-edit", REdit())["ok"] is True
          and O._read("signals.json", []) == [])
    check("a visitor cannot delete a signal", raises(lambda: O.signals_delete("s-edit", RGuest()), 401))
finally:
    O._write("signals.json", [])

print("order flow reads the broker's ticks and never invents one")


def _of_reset():
    OF._TICKS.clear()
    for k, v in (("last_tick", 0.0), ("parsed", 0), ("messages", 0), ("status", "idle")):
        OF._STATE[k] = v


_of_reset()
for env in ("EXN_API_KEY", "EXN_PRIVATE_KEY", "EXN_ACCOUNT_ID", "EXN_DISCOVERY_BASE_URL",
            "EXN_SYMBOL"):
    os.environ.pop(env, None)
check("with no credentials it says so, and shows nothing else",
      OF.snapshot()["status"] == "not_configured" and OF.snapshot()["windows"]["60s"]["ticks"] == 0)
check("it reports itself as a proxy", OF.snapshot()["proxy"] is True)
check("starting without credentials starts no thread", OF.start() is False)

# three shapes a tick stream can take
frames = [
    {"type": "tick", "data": {"symbol": "XAUUSD", "bid": 3520.10, "ask": 3520.30, "ts": 1773656070}},
    {"event": "ticks", "ticks": [{"instrument": "XAUUSD", "price": 3520.60, "volume": 2, "time": 1773656071}]},
    {"stream": "XAUUSD", "p": 3520.40, "v": 1, "t": 1773656072000},
]
got = []
for f in frames:
    got.extend(OF.parse_ticks(f))
check("bids and asks become a mid price", got[0]["price"] == 3520.2, got[0])
check("a plain price is kept as it is", got[1]["price"] == 3520.6 and got[1]["volume"] == 2)
check("milliseconds are turned into seconds", abs(got[2]["ts"] - 1773656072) < 1, got[2])
check("a frame with no price yields no tick", OF.parse_ticks({"type": "heartbeat"}) == [])

# the delta itself: up, up, down, flat
_OF_NOW = int(time.time())
OF.ingest([{"sym": "XAUUSD", "price": 100.0, "volume": None, "ts": _OF_NOW - 10},
           {"sym": "XAUUSD", "price": 101.0, "volume": None, "ts": _OF_NOW - 8},
           {"sym": "OTHER", "price": 5.0, "volume": None, "ts": _OF_NOW - 7},
           {"sym": "XAUUSD", "price": 100.5, "volume": None, "ts": _OF_NOW - 5}])
snap = OF.snapshot()
w = snap["windows"]["60s"]
check("a foreign symbol is ignored, and the first tick votes for nobody",
      w["ticks"] == 3 and w["flat"] == 1, w)
check("one buying tick and one selling tick", w["buy"] == 1 and w["sell"] == 1, w)
check("the delta is their difference", w["delta"] == 0, w)
check("gold is read as XAUUSDm by default, the name Exness lists it under",
      OF.SYMBOL == "XAUUSDM" and snap["sym"] == "XAUUSDM", snap["sym"])
check("the standard-account spelling XAUUSD is the same tape, not a foreign symbol",
      OF._same_instrument("XAUUSD") and OF._same_instrument("XAUUSDm")
      and OF._same_instrument("xauusdm") and not OF._same_instrument("EURUSD")
      and not OF._same_instrument("XAUUSDX-ONLY"), "instrument matching")
check("the price is the last one seen", snap["price"] == 100.5)
check("the unit is ticks when no size arrives", snap["unit"] == "ticks")
OF.ingest([{"sym": "XAUUSD", "price": 101.5, "volume": None, "ts": int(time.time())}])
w = OF.snapshot()["windows"]["60s"]
check("a fresh up tick is buying, and the delta follows", w["delta"] == 1, w)
check("stale is false while the tick is fresh", OF.snapshot()["stale"] is False)

OF.ingest([{"sym": "XAUUSD", "price": 99.0, "volume": None, "ts": int(time.time())}])
check("a down tick is selling", OF.snapshot()["windows"]["60s"]["delta"] == 0)
_OF_STALE = dict(OF._STATE)
OF._STATE["last_tick"] = time.time() - 300
check("a silent feed is called stale, not live", OF.snapshot()["stale"] is True)
OF._STATE.update(_OF_STALE)
check("the method says plainly that it is a proxy",
      "proxy" in OF.snapshot()["method"].lower())

# --- two keys and an account number are enough; the DNS-widget host is optional
os.environ["EXN_API_KEY"] = "exnsk-not-a-real-key"
os.environ["EXN_PRIVATE_KEY"] = "0" * 128
os.environ["EXN_ACCOUNT_ID"] = "12345678"
check("the key pair plus the account number configure it, with no gateway host set",
      OF.configured() is True and OF.missing() == [], OF.missing())
check("without the DNS-widget host the documented review hosts are tried in order",
      OF.gateways() == ["https://api.exness.com", "https://api.exness-api.com"], OF.gateways())
os.environ["EXN_DISCOVERY_BASE_URL"] = "https://gw.example/"
check("a host from the DNS widget is used alone, with any trailing slash dropped",
      OF.gateways() == ["https://gw.example"], OF.gateways())
os.environ.pop("EXN_DISCOVERY_BASE_URL", None)

_real_get = OF._get_json
def _fake_get(host, path):
    if host == "https://api.exness.com":
        raise RuntimeError("HTTP 403 from /v1/trading/access-point")
    return {"access_point": "https://ap-9.example/"}
OF._STATE["access_point"] = ""
OF._STATE["gateway"] = ""
OF._get_json = _fake_get
try:
    _ap = OF.access_point()
finally:
    OF._get_json = _real_get
check("when the first review host refuses, the next one answers and is remembered",
      _ap == "https://ap-9.example" and OF._STATE["gateway"] == "https://api.exness-api.com",
      (OF._STATE.get("gateway"), _ap))

try:
    from cryptography.hazmat.primitives import serialization as _ser
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey as _Ed
    _k = _Ed.generate()
    _seed = _k.private_bytes(_ser.Encoding.Raw, _ser.PrivateFormat.Raw, _ser.NoEncryption())
    _pub = _k.public_key().public_bytes(_ser.Encoding.Raw, _ser.PublicFormat.Raw)
    _good = (_seed + _pub).hex()
    _pasted = "\n  " + _good[:64] + "\n" + _good[64:] + "  \"\n"
    check("a private key pasted with line breaks, spaces or quotes is read cleanly",
          isinstance(OF._load_key(_pasted), _Ed))
    try:
        OF._load_key(("11" * 32) + _pub.hex())
        _refused = False
    except ValueError:
        _refused = True
    check("a key whose halves do not match is refused, not used anyway", _refused)
except Exception as _e:
    check("the key loader can be exercised in this environment", False, repr(_e))

check("the diagnostic state names the missing settings, never their values",
      set(OF.state()["missing"]) <= {"EXN_API_KEY", "EXN_PRIVATE_KEY", "EXN_ACCOUNT_ID"}
      and "exnsk-not-a-real-key" not in repr(OF.state()))
for _v in ("EXN_API_KEY", "EXN_PRIVATE_KEY", "EXN_ACCOUNT_ID"):
    os.environ.pop(_v, None)
OF._STATE["access_point"] = OF._STATE["gateway"] = ""
check("with the settings removed again it is unconfigured, not pretending", OF.configured() is False)
_of_reset()

print("site settings are clamped, never trusted")
saved = {"title": "x" * 80, "accent": "javascript:alert(1)", "theme": "neon",
         "banner": {"text": "y" * 400, "tone": "nonsense"},
         "signal_style": {"buy": "red", "sell": "#000000", "decimals": 99, "tps": -4},
         "nonsense_key": "dropped"}


class R2:
    cookies = {O.COOKIE: tok}


O._write("site.json", {})
res = O.site_put({k: v for k, v in saved.items() if k != "nonsense_key"}, R2())
site = res["site"]
check("an unsafe accent falls back to the default", site["accent"] == O.DEFAULT_SITE["accent"], site["accent"])
check("an unknown theme falls back to dark", site["theme"] == "dark")
check("the title is capped to 28 characters", len(site["title"]) == 28, len(site["title"]))
check("the banner text is capped to 160", len(site["banner"]["text"]) == 160)
check("an unknown banner tone falls back to info", site["banner"]["tone"] == "info")
check("a bad signal colour falls back to the default", site["signal_style"]["buy"] == O.DEFAULT_SITE["signal_style"]["buy"])
check("decimals cannot exceed 4 or go negative", site["signal_style"]["decimals"] == 4)
check("targets cannot exceed 3 or go negative", site["signal_style"]["tps"] == 0)
check("unknown keys are ignored", "nonsense_key" not in site)
check("sections merge rather than replace", site["sections"]["calendar"] is True)

print("the public site reader never returns an unset value")
pub = O.site_public()["site"]
check("every default key survives a partial save", set(O.DEFAULT_SITE) <= set(pub))
check("the saved accent is what the public reader returns", pub["accent"] == site["accent"])


print("the door")
_saved = (os.environ.get("REQUIRE_LOGIN"), O.GOOGLE_CLIENT_ID)
os.environ.pop("REQUIRE_LOGIN", None)
O.GOOGLE_CLIENT_ID = ""
check("with no client id the door stays open (never lock the owner out)", O.login_required() is False)
O.GOOGLE_CLIENT_ID = "abc.apps.googleusercontent.com"
check("the door closes by itself once Google is configured", O.login_required() is True)
os.environ["REQUIRE_LOGIN"] = "0"
check("REQUIRE_LOGIN=0 holds it open", O.login_required() is False)
os.environ["REQUIRE_LOGIN"] = "1"
O.GOOGLE_CLIENT_ID = ""
check("REQUIRE_LOGIN=1 closes it even without a client id", O.login_required() is True)


class R3:
    def __init__(self):
        self.base_url = "https://desento-real.onrender.com/"


page = O.signin_page(R3())
check("the sign-in page carries the client id", "abc.apps.googleusercontent.com" in page or "\"\"" in page)
check("the door page keeps its wiring off the screen",
      "Authorized" not in page and "console.cloud.google" not in page and "GOOGLE_CLIENT_ID" not in page)
check("it never leaks a doubled brace from the template", "{{" not in page and "}}" not in page)
check("it is styled, not a bare document", "--bg:#0b0e14" in page and "<style>" in page)
O.GOOGLE_CLIENT_ID = "abc.apps.googleusercontent.com"
page2 = O.signin_page(R3())
check("with a client id it is embedded for the Google button", "abc.apps.googleusercontent.com" in page2)
check("the door asks for a Google account, not a password", "Sign in with your Google account" in page2)
os.environ.pop("REQUIRE_LOGIN", None)
O.GOOGLE_CLIENT_ID = _saved[1]

print("\n%d passed, %d failed" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
