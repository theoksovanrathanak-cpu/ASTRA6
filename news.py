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
    return out[:limit]      # the cache keeps 60; the caller gets what it asked for


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


# === gold fundamentals: what the news means for XAUUSD =====================
# The user asked for a fundamentals reading that actually says BUY or SELL, built by
# collecting the news and knowing which way each story pushes gold - and that changes on a
# timetable, not at random. So:
#   * only gold-relevant stories are used (gold itself, or the macro drivers of gold:
#     the Fed, real yields, the dollar, inflation, safe-haven demand, central banks, ETFs);
#   * every story is scored by a fixed, published rule table - the same words always give
#     the same direction, so the reading is reproducible, not mood music;
#   * recent stories weigh more, with a fixed half-life (12 h), so the reading moves as time
#     passes rather than jumping around;
#   * the whole reading is rebuilt once per 5-minute clock bucket (:00, :05, :10 ...), so
#     "next update" is a time you can set a watch by, and the same bucket always returns the
#     same numbers.
# Nothing here predicts a price. It is a rule-based summary of what is already published,
# and the UI says so.

import math as _math
import re as _re

# (pattern, direction, weight, why)   direction +1 = bullish gold, -1 = bearish gold
GOLD_RULES = [
    # the Fed and the cost of money
    (r"\b(fed|fomc|powell)\b.{0,40}\b(cut|cuts|cutting|lower|ease|easing|dovish)\b", +1, 2.4,
     "Fed easing talk: lower policy rates pull real yields down, which supports gold"),
    (r"\b(rate cut|rate cuts|cuts rates|cut rates|dovish)\b", +1, 2.2,
     "rate-cut expectations: cheaper money and lower real yields help gold"),
    (r"\b(fed|fomc|powell)\b.{0,40}\b(hike|hikes|hiking|raise|raising|hawkish|higher for longer)\b", -1, 2.4,
     "Fed tightening talk: higher policy rates lift real yields, which weighs on gold"),
    (r"\b(rate hike|rate hikes|hikes rates|hawkish|tightening)\b", -1, 2.2,
     "rate-hike risk: higher real yields make a zero-yield metal less attractive"),
    # inflation
    (r"\b(inflation|consumer prices|cpi|pce)\b.{0,44}\b(hot|hotter|heats? up|accelerat|picks? up|rise|rises|jump|jumps|surge|surges|sticky|stubborn\w*|elevated|above)\b", +1, 1.8,
     "hotter inflation: gold is bought as an inflation hedge"),
    (r"\b(inflation|consumer prices|cpi|pce)\b.{0,44}\b(cool|cools|cooler|ease|eases|slow|slows|fall|falls|below|soft\w*)\b", -1, 1.1,
     "cooling inflation: less inflation hedging demand, though it can also mean earlier cuts"),
    # risk appetite: when equities are sold, some of that money lands in gold
    (r"\b(stocks|equities|shares|wall street|nasdaq|s&p)\b.{0,44}\b(sell[- ]?off|slump|slumps|tumble|tumbles|plunge|plunges|fall|falls|drop|drops|rout)\b", +1, 1.2,
     "equity sell-off: money leaving shares often parks in gold"),
    (r"\b(risk[- ]on|record high|rally|rallies|surge)\b.{0,30}\b(stocks|equities|shares)\b", -1, 0.9,
     "risk-on equity rally: less appetite for a defensive asset"),
    # the dollar
    (r"\b(dollar|dxy|greenback)\b.{0,40}\b(weaken|weakens|weaker|falls|fall|slides|slumps|drops|softer)\b", +1, 2.0,
     "weaker dollar: gold is priced in dollars, so a softer dollar lifts it"),
    (r"\b(dollar|dxy|greenback)\b.{0,40}\b(strengthen|strengthens|stronger|rises|rise|climbs|surges|firm)\b", -1, 2.0,
     "stronger dollar: a firmer dollar makes dollar-priced gold dearer for the rest of the world"),
    # yields
    (r"\b(treasury|bond|yield|yields)\b.{0,30}\b(fall|falls|slide|slides|slip|slips|drop|drops|lower|decline)\b", +1, 1.9,
     "falling yields: the opportunity cost of holding gold falls with them"),
    (r"\b(treasury|bond|yield|yields)\b.{0,30}\b(rise|rises|climb|climbs|jump|jumps|surge|surges|higher)\b", -1, 1.9,
     "rising yields: a higher risk-free rate competes with a metal that pays nothing"),
    # safe haven
    (r"\b(safe haven|safe-haven|haven|risk[- ]off|flight to safety)\b", +1, 2.0,
     "safe-haven demand: money runs to gold when risk appetite falls"),
    (r"\b(war|warfare|invasion|attack|attacks|strike|strikes|conflict|military|missile|tension|tensions|geopolitical|sanctions)\b", +1, 1.6,
     "geopolitical risk: conflict and sanctions raise demand for a haven asset"),
    (r"\b(recession|slowdown|downturn|hard landing|stagflation)\b", +1, 1.3,
     "recession worry: growth fear usually helps gold and hurts cyclical assets"),
    # price action in the metal itself
    (r"\b(gold|xau|bullion)\b.{0,40}\b(record high|all[- ]time high|surge|surges|soar|soars|rally|rallies|jump|jumps|climb|climbs|gain|gains|rise|rises|stronger)\b", +1, 1.4,
     "gold price action: the metal itself is being bought"),
    (r"\b(gold|xau|bullion)\b.{0,40}\b(slump|slumps|slip|slips|fall|falls|drop|drops|slide|slides|tumble|tumbles|plunge|plunges|sink|sinks|weaker|selloff|profit[- ]taking)\b", -1, 1.4,
     "gold price action: the metal itself is being sold"),
]

# these only count when the story is actually about gold: a bitcoin ETF inflow is not a
# gold flow, and a central bank selling dollars is not a central bank selling bullion
GOLD_RULES_GOLD_ONLY = [
    (r"\b(central bank|central banks|pboc|rbi|pbc)\b.{0,44}\b(buy|buys|buying|purchase|purchases|add|adds|accumulat)\b", +1, 2.1,
     "official-sector buying: central-bank purchases remove physical supply from the market"),
    (r"\b(central bank|central banks)\b.{0,44}\b(sell|sells|selling|sold)\b", -1, 1.6,
     "official-sector selling: central-bank supply adds to the market"),
    (r"\b(etf|etfs|spdr|holdings)\b.{0,44}\b(inflow|inflows|rose|rise|added|adds|up)\b", +1, 1.5,
     "gold ETF inflows: investment demand is coming back into the metal"),
    (r"\b(etf|etfs|spdr|holdings)\b.{0,44}\b(outflow|outflows|fell|fall|cut|reduced|down)\b", -1, 1.5,
     "gold ETF outflows: investors are leaving the metal"),
]

GOLD_CORE = _re.compile(r"\b(gold|xau|bullion|precious metal|precious metals)\b", _re.I)
GOLD_DRIVER = _re.compile(
    r"\b(fed|fomc|powell|rate cut|rate hike|interest rate|inflation|cpi|pce|dollar|dxy|greenback|"
    r"treasury|yield|yields|safe haven|haven|risk[- ]off|central bank|etf|spdr|recession|"
    r"tariff|sanctions|geopolitic|war|conflict|nonfarm|payrolls|jobless|unemployment)\b", _re.I)

HALF_LIFE_H = 24.0          # a story half as important after a day (a weekend is not a gap)
BUCKET_S = 300              # the reading is rebuilt on the :00 :05 :10 ... clock
_gold_cache = {"bucket": -1, "d": None}


def _gold_text(story):
    return (str(story.get("title") or "") + " " + str(story.get("summary") or "")).strip()


def score_story(story, now_ts=None):
    """One story -> its gold direction, weight and the rules that fired. Deterministic."""
    now_ts = int(now_ts or time.time())
    text = _gold_text(story)
    low = text.lower()
    hits = []
    for pat, d, w, why in GOLD_RULES:
        if _re.search(pat, low):
            hits.append({"dir": d, "w": w, "why": why})
    if GOLD_CORE.search(low):
        for pat, d, w, why in GOLD_RULES_GOLD_ONLY:
            if _re.search(pat, low):
                hits.append({"dir": d, "w": w, "why": why})
    if not hits:
        return {"dir": 0, "score": 0.0, "why": "no rule matched: this headline is not a gold driver", "hits": 0}
    raw = sum(h["w"] * h["dir"] for h in hits)
    raw = max(-4.0, min(4.0, raw))
    age_h = max(0.0, (now_ts - int(story.get("time") or now_ts)) / 3600.0)
    recency = 0.5 ** (age_h / HALF_LIFE_H)
    if recency < 0.09:                 # older than ~3.5 days: context only, it does not vote
        return {"dir": 0, "score": 0.0, "why": "older than three days: shown for context, it does not vote",
                "hits": len(hits), "weight": 0}
    score = raw * recency
    # the strongest-magnitude rule explains the call; ties keep table order, so it is stable
    top = max(hits, key=lambda h: (h["w"], -hits.index(h)))
    return {"dir": (1 if score > 0 else (-1 if score < 0 else 0)), "score": round(score, 3),
            "why": top["why"], "hits": len(hits), "weight": int(round(top["w"]))}


def gold_market_open(now_ts=None):
    """Spot gold trades from Sunday 22:00 UTC to Friday 21:00 UTC."""
    g = time.gmtime(int(now_ts or time.time()))
    wd, hr = g.tm_wday, g.tm_hour          # Mon=0 ... Sun=6
    if wd == 5:
        return False
    if wd == 4 and hr >= 21:
        return False
    if wd == 6 and hr < 22:
        return False
    return True


def gold_reopen(now_ts=None):
    """The next Sunday-22:00-UTC style open, or None when gold is already trading."""
    t = int(now_ts or time.time())
    if gold_market_open(t):
        return None
    t -= t % 3600                     # opens land on the hour
    for i in range(0, 24 * 5):
        ts = t + i * 3600
        if gold_market_open(ts):
            return ts
    return None


def gold_stories(limit=14, now_ts=None):
    """Gold-only stories: the metal first, then the macro drivers that move it."""
    now_ts = int(now_ts or time.time())
    rows = headlines(60) or []
    out, used = [], set()
    for it in rows:
        text = _gold_text(it)
        core = bool(GOLD_CORE.search(text))
        if str(it.get("kind") or "") == "crypto" and not core:
            continue                      # bitcoin/ether news with no gold in it is not gold news
        driver = bool(GOLD_DRIVER.search(text))
        if not (core or driver):
            continue
        key = " ".join(str(it.get("title") or "").lower().split())[:90]
        if key in used:
            continue
        used.add(key)
        s = score_story(it, now_ts)
        if not core and not s["dir"]:
            continue          # a macro story that moves neither gold nor the dollar: not gold news
        if core and s["dir"]:
            s = dict(s, score=round(s["score"] * 1.3, 3))
        out.append({
            "title": it.get("title"), "url": it.get("url"), "time": it.get("time"),
            "source": it.get("source"), "kind": it.get("kind"),
            "gold": core,                       # True = about gold itself
            "impact": "BUY" if s["dir"] > 0 else ("SELL" if s["dir"] < 0 else "NEUTRAL"),
            "strength": abs(s["score"]),
            "why": s["why"],
            "weight": s.get("weight", 0),
        })
    # gold news that votes first, then every other voting driver, then gold context - newest first
    out.sort(key=lambda x: (0 if (x["gold"] and x["impact"] != "NEUTRAL") else
                            (1 if x["impact"] != "NEUTRAL" else 2), -(x["time"] or 0)))
    return out[:limit]


def gold_fundamentals(limit=12, now_ts=None):
    """The gold reading for the current 5-minute bucket: BUY / SELL / NEUTRAL + the reasons."""
    now_ts = int(now_ts or time.time())
    bucket = (now_ts // BUCKET_S) * BUCKET_S
    next_at = bucket + BUCKET_S
    if _gold_cache["bucket"] == bucket and _gold_cache["d"] is not None:
        d = dict(_gold_cache["d"])
        d["now"] = now_ts
        d["next_in"] = max(0, next_at - now_ts)
        return d

    stories = gold_stories(max(limit, 12), now_ts)
    # only the stories that actually push gold count towards the reading; a neutral
    # headline is shown but has no vote
    voters = [s for s in stories if s["impact"] != "NEUTRAL"]
    raw = sum((s["strength"] if s["impact"] == "BUY" else -s["strength"]) for s in voters)
    # normalise: 3 strong stories in agreement = a full-strength reading
    norm = _math.tanh(raw / 3.5) if voters else 0.0
    norm = round(norm, 3)
    buy = sum(1 for s in voters if s["impact"] == "BUY")
    sell = sum(1 for s in voters if s["impact"] == "SELL")
    newest = max([s["time"] or 0 for s in stories], default=0)
    freshest_h = round((now_ts - newest) / 3600.0, 1) if newest else None
    if norm >= 0.16:
        bias, label = "BUY", "gold-positive headlines"
    elif norm <= -0.16:
        bias, label = "SELL", "gold-negative headlines"
    elif voters:
        bias, label = "NEUTRAL", "the headlines cancel each other out"
    else:
        bias, label = "NEUTRAL", "no fresh gold headline to score"
    confidence = int(round(min(0.9, abs(norm)) * 100))
    cal = calendar() or []
    soon = [e for e in cal if e["time"] >= now_ts - 3600 and e["impact"] == "High"][:4]
    watch = []
    for e in soon:
        t = (e.get("title") or "").lower()
        if any(k in t for k in ("cpi", "inflation", "pce")):
            note = "hot print: gold bid as an inflation hedge · soft print: gold offered"
        elif any(k in t for k in ("nonfarm", "payroll", "unemployment", "jobless")):
            note = "strong jobs: yields up, gold pressured · weak jobs: cuts priced, gold bid"
        elif any(k in t for k in ("fed", "fomc", "rate")):
            note = "dovish surprise: gold bid · hawkish surprise: gold offered"
        elif any(k in t for k in ("gdp", "retail", "ism", "pmi")):
            note = "strong growth: gold pressured · weak growth: gold bid as a haven"
        else:
            note = "a high-impact surprise usually moves gold; direction depends on the surprise"
        watch.append({"time": e["time"], "title": e.get("title"), "currency": e.get("currency"),
                      "impact": e.get("impact"), "note": note})

    d = {
        "status": "ok",
        "market": "XAUUSD",
        "bias": bias,                 # BUY / SELL / NEUTRAL - what the news says about gold
        "label": label,
        "score": round(norm, 3),      # -1 .. +1
        "confidence": confidence,     # 0 .. 90, how one-sided the headlines are
        "buy": buy, "sell": sell, "voters": len(voters),
        "freshest_h": freshest_h,          # how old the newest headline is, in hours
        "stale": len(voters) == 0,
        "market_open": gold_market_open(now_ts),
        "reopen_at": gold_reopen(now_ts),
        "stories": stories,
        "watch": watch,
        "generated_at": bucket,
        "next_update": next_at,
        "now": now_ts,
        "next_in": max(0, next_at - now_ts),
        "period_s": BUCKET_S,
        "schedule": "rebuilt every 5 minutes on the clock (:00, :05, :10, ...)",
        "method": ("Every gold headline is read by a fixed rule table: Fed and rate language, "
                   "inflation, the dollar, Treasury yields, safe-haven flows, central-bank buying "
                   "and ETF flows. Newer stories weigh more (12-hour half-life). The sum is the "
                   "reading; it is a summary of published news, not a forecast or advice."),
        "real": True,
        "sources": _cache["news"].get("sources", []),
    }
    _gold_cache["bucket"] = bucket
    _gold_cache["d"] = d
    return d
