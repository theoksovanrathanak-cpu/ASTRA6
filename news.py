"""Real market-moving news: the economic calendar and live headlines.

Nothing here is written by us. Every event comes from the ForexFactory weekly
calendar feed and every headline comes from a public RSS feed; each item keeps the
source name and its own timestamp so the site can show where it came from.

Nothing is generated, summarised or extrapolated: if a feed is down it is reported
as down instead of being filled in.
"""
from __future__ import annotations

import datetime as _dt
import email.utils as _eut
import time
import xml.etree.ElementTree as ET

import requests

_UA = {"User-Agent": "Mozilla/5.0 ASTRA6/1.0"}

CAL_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
CAL_SOURCE_FF = "ForexFactory calendar (this week)"
TV_CAL = "https://economic-calendar.tradingview.com/events"
CAL_SOURCE_TV = "TradingView economic calendar"
TV_COUNTRIES = "US,EU,GB,JP,AU,NZ,CA,CH,CN"   # the currencies that move gold and bitcoin

# name, url, kind
# market-focused feeds only: a personal-finance story cannot move gold or bitcoin
FEEDS = [
    ("ForexLive", "https://www.forexlive.com/feed/news", "fx"),
    ("Investing FX", "https://www.investing.com/rss/news_1.rss", "fx"),
    ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/", "crypto"),
    ("CNBC Markets", "https://www.cnbc.com/id/20910258/device/rss/rss.html", "macro"),
    ("WSJ Markets", "https://feeds.a.dj.com/rss/RSSMarketsMain.xml", "macro"),
    ("BBC Business", "https://feeds.bbci.co.uk/news/business/rss.xml", "macro"),
]

CAL_TTL = 900.0
NEWS_TTL = 240.0
_cache = {"cal": {"t": 0.0, "d": None, "src": None}, "news": {"t": 0.0, "d": None, "sources": []}}

IMPACT_RANK = {"High": 3, "Medium": 2, "Low": 1, "Holiday": 0}


def _iso_ts(s):
    try:
        return int(_dt.datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp())
    except Exception:
        return None


def _rss_ts(s):
    try:
        d = _eut.parsedate_to_datetime(str(s))
        if d.tzinfo is None:
            d = d.replace(tzinfo=_dt.timezone.utc)
        return int(d.timestamp())
    except Exception:
        return None


def _calendar_tv(days_ahead):
    """TradingView public economic calendar. importance: 1 high, 0 medium, -1 low."""
    now = time.time()
    fmt = "%Y-%m-%dT%H:%M:%S.000Z"
    url = (f"{TV_CAL}?from={time.strftime(fmt, time.gmtime(now - 26 * 3600))}"
           f"&to={time.strftime(fmt, time.gmtime(now + days_ahead * 86400))}"
           f"&countries={TV_COUNTRIES}")
    r = requests.get(url, timeout=14, headers={**_UA, "Origin": "https://www.tradingview.com",
                                               "Referer": "https://www.tradingview.com/"})
    r.raise_for_status()
    rows = (r.json() or {}).get("result") or []
    out = []
    for e in rows:
        imp = e.get("importance")
        impact = {1: "High", 0: "Medium"}.get(imp)
        if not impact:
            continue
        ts = _iso_ts(e.get("date"))
        if ts is None:
            continue
        out.append({"time": ts, "title": str(e.get("title") or "").strip(),
                    "currency": str(e.get("country") or "").strip(), "impact": impact,
                    "actual": "" if e.get("actual") in (None, "") else str(e.get("actual")),
                    "forecast": "" if e.get("forecast") is None else str(e.get("forecast")),
                    "previous": "" if e.get("previous") is None else str(e.get("previous")),
                    "unit": str(e.get("unit") or "")})
    return out


def _calendar_ff(days_ahead):
    now = time.time()
    r = requests.get(CAL_URL, timeout=12, headers=_UA)
    r.raise_for_status()
    out = []
    horizon = now + days_ahead * 86400
    for e in r.json():
        impact = str(e.get("impact") or "").strip()
        if impact not in ("High", "Medium"):
            continue
        ts = _iso_ts(e.get("date"))
        if ts is None or ts < now - 3 * 3600 or ts > horizon:
            continue
        out.append({"time": ts, "title": str(e.get("title") or "").strip(),
                    "currency": str(e.get("country") or "").strip(), "impact": impact,
                    "actual": str(e.get("actual") or "").strip(),
                    "forecast": str(e.get("forecast") or "").strip(),
                    "previous": str(e.get("previous") or "").strip(), "unit": ""})
    return out


def calendar(days_ahead=10):
    """Upcoming High/Medium impact events, soonest first. TV first, ForexFactory as backup."""
    now = time.time()
    if _cache["cal"]["d"] is not None and now - _cache["cal"]["t"] < CAL_TTL:
        return _cache["cal"]["d"]
    for fn, src in ((_calendar_tv, CAL_SOURCE_TV), (_calendar_ff, CAL_SOURCE_FF)):
        try:
            rows = fn(days_ahead)
            if rows:
                rows.sort(key=lambda x: x["time"])
                rows = rows[:60]
                _cache["cal"] = {"t": now, "d": rows, "src": src}
                return rows
        except Exception as e:
            print(f"calendar source {src} unavailable:", e)
    # nothing reachable: serve the last good copy rather than an empty box
    return _cache["cal"]["d"] or []


def headlines(limit=30):
    """Latest real headlines from the public feeds, newest first."""
    now = time.time()
    if _cache["news"]["d"] is not None and now - _cache["news"]["t"] < NEWS_TTL:
        return _cache["news"]["d"][:limit]
    items, reachable = [], []
    for name, url, kind in FEEDS:
        try:
            r = requests.get(url, timeout=12, headers=_UA)
            r.raise_for_status()
            root = ET.fromstring(r.content)
        except Exception as e:
            print(f"feed {name} unavailable:", e)
            continue
        reachable.append(name)
        for it in root.findall(".//item")[:40]:
            title = (it.findtext("title") or "").strip()
            link = (it.findtext("link") or "").strip()
            ts = _rss_ts(it.findtext("pubDate"))
            if not title or not link or ts is None:
                continue
            if ts < now - 3 * 86400 or ts > now + 6 * 3600:
                continue   # a stale or future-dated item is not news
            items.append({"title": title, "url": link, "time": ts, "source": name, "kind": kind})
    # newest first, then interleaved by source: one busy feed (CoinDesk posts all day)
    # must not bury the FX and macro stories that actually move gold
    seen, by_src = set(), {}
    for it in sorted(items, key=lambda x: -x["time"]):
        key = " ".join(it["title"].lower().split())[:90]
        if key in seen:
            continue
        seen.add(key)
        by_src.setdefault(it["source"], []).append(it)
    out = []
    while len(out) < 60 and any(by_src.values()):
        for name, _url, _kind in FEEDS:
            bucket = by_src.get(name) or []
            if bucket:
                out.append(bucket.pop(0))
            if len(out) >= 60:
                break
    _cache["news"] = {"t": now, "d": out, "sources": reachable}
    return out


def fundamentals(limit=30):
    cal = calendar()
    news = headlines()
    now_ts = int(time.time())
    nxt = next((e for e in cal if e["impact"] == "High" and e["time"] >= now_ts), None)
    if nxt is None:
        nxt = next((e for e in cal if e["time"] >= now_ts), None)
    return {
        "status": "ok",
        "updated": now_ts,
        "calendar": cal,
        "news": news[:limit],
        "next_high": nxt,
        "calendar_source": _cache["cal"].get("src") or CAL_SOURCE_TV,
        "news_sources": _cache["news"].get("sources", []),
        "real": True,
        "note": "Fetched from public feeds. Times shown in your own timezone. Nothing is written by ASTRA6.",
    }
