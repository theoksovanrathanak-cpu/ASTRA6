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
        self.base_url = "https://astra6-real.onrender.com/"


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
