"""Telegram pushes - the alert reaches the phone when the tab is shut.

Rules, the same ones the page follows:
  * only a real BUY or SELL is pushed, never a HOLD
  * one push per box: the trade key is remembered, so a signal that is merely
    still on does not ring a second time
  * nothing is invented - the numbers pushed are the numbers the server computed
    from the same candles the chart draws
  * if no bot token is configured the module stays quiet and says so; it never
    pretends a message went out

The token lives in the environment (TELEGRAM_BOT_TOKEN or BOT_TOKEN) and is
never written into the repository.
"""
import json
import os
import time

import requests

BASE = os.path.dirname(os.path.abspath(__file__))
SUBS_FILE = os.path.join(BASE, "telegram_subs.json")
SEEN_FILE = os.path.join(BASE, "telegram_seen.json")
SITE = "https://astra6-real.onrender.com"
BOT_HANDLE = "@astra6renderbot"

_SEEN_CAP = 400


def token():
    return os.getenv("TELEGRAM_BOT_TOKEN") or os.getenv("BOT_TOKEN") or ""


def configured():
    return bool(token())


# ------------------------------------------------------------------ storage
def _load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _save(path, data):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
        return True
    except Exception as e:
        print("push store error:", e)
        return False


def subscribers():
    """Every chat that has messaged the bot, plus TELEGRAM_CHAT_ID if set."""
    subs = _load(SUBS_FILE, [])
    if not isinstance(subs, list):
        subs = []
    env_chat = os.getenv("TELEGRAM_CHAT_ID") or ""
    if env_chat and not any(str(s.get("chat_id")) == str(env_chat) for s in subs):
        subs.append({"chat_id": env_chat, "name": "env", "at": int(time.time())})
    return subs


def add(chat_id, name=""):
    if chat_id in (None, ""):
        return False
    subs = [s for s in subscribers() if str(s.get("chat_id")) != str(chat_id)]
    subs.append({"chat_id": str(chat_id), "name": (name or "")[:60], "at": int(time.time())})
    return _save(SUBS_FILE, subs[-50:])


def remove(chat_id):
    subs = [s for s in subscribers() if str(s.get("chat_id")) != str(chat_id)]
    return _save(SUBS_FILE, subs)


def status():
    subs = subscribers()
    return {
        "status": "ok",
        "configured": configured(),
        "bot": BOT_HANDLE,
        "subscribers": len(subs),
        "chats": [{"name": s.get("name", ""), "since": s.get("at")} for s in subs],
        "site": SITE,
        "how": ("Message the bot once and it is connected" if configured()
                else "Add TELEGRAM_BOT_TOKEN in Render -> Environment, then open the bot and press Start"),
    }


# ------------------------------------------------------------------ sending
def send(chat_id, text):
    if not configured():
        return {"ok": False, "error": "no_bot_token"}
    try:
        r = requests.post(
            "https://api.telegram.org/bot%s/sendMessage" % token(),
            json={"chat_id": chat_id, "text": text, "parse_mode": "HTML",
                  "disable_web_page_preview": True},
            timeout=10,
        )
        j = r.json()
        if not j.get("ok"):
            print("tg send refused:", str(j)[:200])
        return j
    except Exception as e:
        print("tg send error:", e)
        return {"ok": False, "error": str(e)}


def broadcast(text):
    if not configured():
        return {"ok": False, "error": "no_bot_token", "sent": 0}
    sent, failed = 0, 0
    for s in subscribers():
        res = send(s.get("chat_id"), text)
        if res.get("ok"):
            sent += 1
        else:
            failed += 1
    return {"ok": sent > 0, "sent": sent, "failed": failed}


# ------------------------------------------------------------------ the alert itself
NAME = {"XAUUSD": "GOLD", "BTCUSD": "BITCOIN"}


def _money(v):
    try:
        return "{:,.2f}".format(float(v))
    except Exception:
        return "-"


def signal_key(sym, sig):
    """One key per trade: symbol, side and the box the trade came from."""
    if not sig or sig.get("type") not in ("BUY", "SELL"):
        return None
    entry = sig.get("entry")
    if entry is None:
        entry = sig.get("price")
    row = sig.get("row") or {}
    box = ""
    if row.get("bot") is not None and row.get("top") is not None:
        box = "%s-%s" % (_money(row["bot"]), _money(row["top"]))
    return "%s|%s|%s|%s" % (sym, sig.get("type"), _money(entry), box)


def is_new(key):
    """True the first time a trade key is seen. Does not mark it - `mark` does that,
    so a push that failed to send is retried on the next pass instead of lost."""
    if not key:
        return False
    seen = _load(SEEN_FILE, [])
    if not isinstance(seen, list):
        return True
    return key not in seen


def mark(key):
    if not key:
        return False
    seen = _load(SEEN_FILE, [])
    if not isinstance(seen, list):
        seen = []
    if key in seen:
        return True
    seen.append(key)
    return _save(SEEN_FILE, seen[-_SEEN_CAP:])


def format_signal(sym, sig, tf="M15"):
    side = sig.get("type")
    row = sig.get("row") or {}
    lines = ["<b>ASTRA6 · %s %s</b>" % (NAME.get(sym, sym), side),
             "entry <b>%s</b>" % _money(sig.get("entry", sig.get("price"))),
             "stop %s" % _money(sig.get("sl")),
             "tp1 %s" % _money(sig.get("tp1")),
             "tp2 %s" % _money(sig.get("tp2"))]
    if row.get("bot") is not None and row.get("top") is not None:
        lines.append("")
        lines.append("cluster %s – %s" % (_money(row["bot"]), _money(row["top"])))
    if sig.get("vwap"):
        where = "above" if float(sig.get("price") or 0) >= float(sig["vwap"]) else "below"
        lines.append("%s VWAP %s" % (where, _money(sig["vwap"])))
    if sig.get("r") is not None:
        lines.append("tp2 %sR · volume clusters · %s" % (sig["r"], tf))
    lines.append("<a href=\"%s\">open ASTRA6</a>" % SITE)
    return "\n".join(lines)


def format_test():
    return ("<b>ASTRA6 · test</b>\n"
            "This is the phone alert channel.\n"
            "When a volume-cluster BUY or SELL prints on gold or bitcoin, "
            "you get one message like this with entry, stop and both targets.\n"
            "<a href=\"%s\">open ASTRA6</a>" % SITE)


def format_closed(sym):
    return ("<b>ASTRA6</b>\n%s market closed - no new candles until it reopens.\n"
            "<a href=\"%s\">open ASTRA6</a>" % (NAME.get(sym, sym), SITE))
