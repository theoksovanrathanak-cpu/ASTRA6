"""Owner-only publishing for ASTRA6.

Three things live here, and nothing else:

  1. Gmail sign-in.  Google Identity Services hands the page a signed ID token. This
     module verifies it with Google itself (`oauth2.googleapis.com/tokeninfo`) — that
     checks the signature, the audience and the expiry, so a forged token cannot pass.
     Only the one owner address is allowed in.

  2. Published signals.  The owner posts a trade, everyone else reads it. Stored in a
     JSON file so it survives a restart when the data directory is on a disk.

  3. Site settings.  Title, accent, banner, which sections show, and how the signal card
     looks. Public to read, owner-only to write.

Nothing here invents a trade. A visitor can never write anything; every write checks the
signed session cookie first.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from typing import Any, Dict, List, Optional

import requests
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

OWNER_EMAIL = (os.environ.get("OWNER_EMAIL") or "theoksovanrathanak@gmail.com").strip().lower()
GOOGLE_CLIENT_ID = (os.environ.get("GOOGLE_CLIENT_ID") or "").strip()
SESSION_DAYS = 30

_LOCK = threading.Lock()
_TOKENINFO = "https://oauth2.googleapis.com/tokeninfo"


# ----------------------------------------------------------------- data directory
def data_dir() -> str:
    """A disk when there is one, the repo when there is not.

    Render free has no persistent disk, so a redeploy wipes the folder. That is stated
    in the UI rather than hidden: `persistent` is reported by /api/site.
    """
    forced = os.environ.get("ASTRA6_DATA_DIR")
    if forced:
        p = forced
    elif os.path.isdir("/var/data"):
        p = "/var/data"                      # a Render disk mounted at /var/data
    else:
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
    try:
        os.makedirs(p, exist_ok=True)
    except Exception:
        p = "/tmp/astra6-data"
        os.makedirs(p, exist_ok=True)
    return p


def persistent() -> bool:
    d = data_dir()
    return d.startswith("/var/data") or bool(os.environ.get("ASTRA6_DATA_DIR"))


def _read(name: str, default: Any) -> Any:
    path = os.path.join(data_dir(), name)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _write(name: str, value: Any) -> None:
    path = os.path.join(data_dir(), name)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def _secret() -> bytes:
    """A secret that outlives a restart when the data directory does."""
    path = os.path.join(data_dir(), "session_secret")
    if os.path.exists(path):
        try:
            return open(path, "rb").read()
        except Exception:
            pass
    s = secrets.token_bytes(32)
    try:
        with open(path, "wb") as f:
            f.write(s)
    except Exception:
        pass
    return s


# ----------------------------------------------------------------- Google sign-in
def verify_google(credential: str) -> Dict[str, Any]:
    """Verify a Google ID token. Raises HTTPException on anything that is not the owner."""
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=503, detail={
            "error": "google_not_configured",
            "how": "Set GOOGLE_CLIENT_ID in the environment (Render -> Environment). "
                   "It is the public OAuth client id from Google Cloud Console, not a secret.",
        })
    if not credential or len(credential) < 40:
        raise HTTPException(status_code=400, detail={"error": "no_credential"})
    try:
        r = requests.get(_TOKENINFO, params={"id_token": credential}, timeout=12)
    except Exception as e:
        raise HTTPException(status_code=502, detail={"error": "google_unreachable", "detail": str(e)[:120]})
    if r.status_code != 200:
        raise HTTPException(status_code=401, detail={"error": "google_rejected", "detail": r.text[:160]})
    try:
        info = r.json()
    except Exception:
        raise HTTPException(status_code=502, detail={"error": "google_bad_json"})
    aud = str(info.get("aud") or "")
    if aud != GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=401, detail={"error": "wrong_audience", "aud": aud})
    email = str(info.get("email") or "").strip().lower()
    verified = str(info.get("email_verified")).lower() in ("true", "1")
    if email != OWNER_EMAIL or not verified:
        raise HTTPException(status_code=403, detail={"error": "not_the_owner", "email": email})
    try:
        exp = int(info.get("exp") or 0)
    except Exception:
        exp = 0
    if exp and exp < time.time():
        raise HTTPException(status_code=401, detail={"error": "token_expired"})
    return {"email": email, "sub": info.get("sub"), "name": info.get("name"),
            "picture": info.get("picture")}


# ----------------------------------------------------------------- session cookie
COOKIE = "astra6_owner"


def _sign(payload: str) -> str:
    return hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()


def make_session(email: str) -> str:
    exp = int(time.time()) + SESSION_DAYS * 86400
    body = base64.urlsafe_b64encode(json.dumps({"e": email, "x": exp}).encode()).decode()
    return body + "." + _sign(body)


def read_session(request: Request) -> Optional[str]:
    raw = request.cookies.get(COOKIE) or ""
    if "." not in raw:
        return None
    body, sig = raw.rsplit(".", 1)
    if not hmac.compare_digest(sig, _sign(body)):
        return None
    try:
        d = json.loads(base64.urlsafe_b64decode(body.encode()))
    except Exception:
        return None
    if int(d.get("x") or 0) < time.time():
        return None
    email = str(d.get("e") or "").lower()
    return email if email == OWNER_EMAIL else None


def require_owner(request: Request) -> str:
    email = read_session(request)
    if not email:
        raise HTTPException(status_code=401, detail={"error": "owner_only"})
    return email


# ----------------------------------------------------------------- shapes
class LoginBody(BaseModel):
    credential: str


class SignalBody(BaseModel):
    side: str
    entry: float
    sl: float
    tp1: Optional[float] = None
    tp2: Optional[float] = None
    tp3: Optional[float] = None
    note: str = ""
    status: str = "open"


class SignalPatch(BaseModel):
    status: Optional[str] = None
    note: Optional[str] = None
    tp1: Optional[float] = None
    tp2: Optional[float] = None
    tp3: Optional[float] = None
    entry: Optional[float] = None
    sl: Optional[float] = None


DEFAULT_SITE = {
    "title": "ASTRA6",
    "tagline": "gold · xauusd · live",
    "accent": "#2962ff",
    "theme": "dark",
    "banner": {"text": "", "tone": "info"},
    "sections": {"calendar": True, "fundamentals": True, "journal": True, "tools": True},
    "signal_style": {"buy": "#12b981", "sell": "#f4525f", "decimals": 2, "tps": 2},
}

ALLOWED_STATUS = ("open", "tp1 hit", "tp2 hit", "stopped", "closed", "cancelled")


def _clean_signal(b: SignalBody) -> Dict[str, Any]:
    side = (b.side or "").upper()
    if side not in ("BUY", "SELL"):
        raise HTTPException(status_code=400, detail={"error": "side_must_be_buy_or_sell"})
    if not isinstance(b.entry, (int, float)) or not isinstance(b.sl, (int, float)):
        raise HTTPException(status_code=400, detail={"error": "entry_and_stop_are_numbers"})
    up = side == "BUY"
    if up and not b.sl < b.entry:
        raise HTTPException(status_code=400, detail={"error": "a_buy_stop_sits_below_the_entry"})
    if not up and not b.sl > b.entry:
        raise HTTPException(status_code=400, detail={"error": "a_sell_stop_sits_above_the_entry"})
    for v, name in ((b.tp1, "tp1"), (b.tp2, "tp2"), (b.tp3, "tp3")):
        if v is None:
            continue
        if up and not v > b.entry:
            raise HTTPException(status_code=400, detail={"error": name + "_must_be_above_the_entry"})
        if not up and not v < b.entry:
            raise HTTPException(status_code=400, detail={"error": name + "_must_be_below_the_entry"})
    if b.tp1 is not None and b.tp2 is not None:
        if up and b.tp2 < b.tp1:
            raise HTTPException(status_code=400, detail={"error": "tp2_cannot_be_closer_than_tp1"})
        if not up and b.tp2 > b.tp1:
            raise HTTPException(status_code=400, detail={"error": "tp2_cannot_be_closer_than_tp1"})
    status = (b.status or "open").lower()
    if status not in ALLOWED_STATUS:
        raise HTTPException(status_code=400, detail={"error": "unknown_status"})
    return {"side": side, "entry": float(b.entry), "sl": float(b.sl),
            "tp1": b.tp1, "tp2": b.tp2, "tp3": b.tp3,
            "note": (b.note or "").strip()[:200], "status": status}


# ----------------------------------------------------------------- router
router = APIRouter()


@router.get("/api/owner/me")
def owner_me(request: Request):
    email = read_session(request)
    return {"owner": bool(email), "email": email or None, "owner_email": OWNER_EMAIL,
            "google_ready": bool(GOOGLE_CLIENT_ID), "client_id": GOOGLE_CLIENT_ID or None,
            "persistent": persistent()}


@router.post("/api/owner/login")
def owner_login(body: LoginBody, request: Request, response: Response):
    who = verify_google(body.credential)
    token = make_session(who["email"])
    response.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True,
                        samesite="lax", secure=(request.url.scheme == "https"), path="/")
    return {"owner": True, "email": who["email"], "name": who.get("name"),
            "picture": who.get("picture"), "persistent": persistent()}


@router.post("/api/owner/logout")
def owner_logout(response: Response):
    response.delete_cookie(COOKIE, path="/")
    return {"owner": False}


@router.get("/api/signals")
def signals_public():
    with _LOCK:
        rows = _read("signals.json", [])
    if not isinstance(rows, list):
        rows = []
    rows.sort(key=lambda r: r.get("at") or 0, reverse=True)
    return {"signals": rows, "persistent": persistent(), "count": len(rows)}


@router.post("/api/signals")
def signals_post(body: SignalBody, request: Request):
    require_owner(request)
    clean = _clean_signal(body)
    row = dict(clean, id="s" + secrets.token_hex(6), at=int(time.time()), by="owner")
    with _LOCK:
        rows = _read("signals.json", [])
        if not isinstance(rows, list):
            rows = []
        rows.insert(0, row)
        rows = rows[:120]
        _write("signals.json", rows)
    return {"ok": True, "signal": row, "persistent": persistent()}


@router.patch("/api/signals/{sid}")
def signals_patch(sid: str, body: SignalPatch, request: Request):
    require_owner(request)
    with _LOCK:
        rows = _read("signals.json", [])
        hit = None
        for r in rows:
            if r.get("id") == sid:
                hit = r
                break
        if hit is None:
            raise HTTPException(status_code=404, detail={"error": "no_such_signal"})
        if body.status is not None:
            if body.status.lower() not in ALLOWED_STATUS:
                raise HTTPException(status_code=400, detail={"error": "unknown_status"})
            hit["status"] = body.status.lower()
        if body.note is not None:
            hit["note"] = body.note.strip()[:200]
        for f in ("tp1", "tp2", "tp3", "entry", "sl"):
            v = getattr(body, f)
            if v is not None:
                hit[f] = float(v)
        _write("signals.json", rows)
    return {"ok": True, "signal": hit}


@router.delete("/api/signals/{sid}")
def signals_delete(sid: str, request: Request):
    require_owner(request)
    with _LOCK:
        rows = _read("signals.json", [])
        keep = [r for r in rows if r.get("id") != sid]
        if len(keep) == len(rows):
            raise HTTPException(status_code=404, detail={"error": "no_such_signal"})
        _write("signals.json", keep)
    return {"ok": True, "deleted": sid, "count": len(keep)}


@router.get("/api/site")
def site_public():
    with _LOCK:
        saved = _read("site.json", {})
    out = json.loads(json.dumps(DEFAULT_SITE))       # a deep copy, never the module dict
    if isinstance(saved, dict):
        for k, v in saved.items():
            if k in out and isinstance(out[k], dict) and isinstance(v, dict):
                out[k].update(v)
            elif k in out:
                out[k] = v
    return {"site": out, "persistent": persistent()}


@router.put("/api/site")
def site_put(body: Dict[str, Any], request: Request):
    require_owner(request)
    cur = site_public()["site"]
    for k, v in (body or {}).items():
        if k not in DEFAULT_SITE:
            continue
        if isinstance(DEFAULT_SITE[k], dict) and isinstance(v, dict):
            cur[k].update({kk: vv for kk, vv in v.items() if kk in DEFAULT_SITE[k]})
        else:
            cur[k] = v
    # nothing here is allowed to break the page: clamp it
    accent = str(cur.get("accent") or "")
    if not (len(accent) in (4, 7) and accent.startswith("#")):
        cur["accent"] = DEFAULT_SITE["accent"]
    cur["theme"] = cur.get("theme") if cur.get("theme") in ("dark", "light") else "dark"
    cur["title"] = (str(cur.get("title") or "ASTRA6"))[:28]
    cur["tagline"] = (str(cur.get("tagline") or ""))[:48]
    b = cur.get("banner") or {}
    cur["banner"] = {"text": str(b.get("text") or "")[:160],
                     "tone": b.get("tone") if b.get("tone") in ("info", "warn", "up") else "info"}
    st = cur.get("signal_style") or {}
    for k in ("buy", "sell"):
        c = str(st.get(k) or "")
        st[k] = c if (len(c) in (4, 7) and c.startswith("#")) else DEFAULT_SITE["signal_style"][k]
    try:
        st["decimals"] = max(0, min(4, int(st.get("decimals", 2))))
    except Exception:
        st["decimals"] = 2
    try:
        st["tps"] = max(0, min(3, int(st.get("tps", 2))))
    except Exception:
        st["tps"] = 2
    cur["signal_style"] = st
    with _LOCK:
        _write("site.json", cur)
    return {"ok": True, "site": cur, "persistent": persistent()}

# ----------------------------------------------------------------- the door
def login_required() -> bool:
    """True when the site is meant to sit behind the owner sign-in.

    `REQUIRE_LOGIN` decides, and it defaults to "on the moment Google is configured".
    If the client id is missing there is no way in, so the door stays open rather than
    locking the owner out of his own site — and says so on the sign-in sheet.
    """
    raw = (os.environ.get("REQUIRE_LOGIN") or "auto").strip().lower()
    if raw in ("0", "false", "off", "no"):
        return False
    if raw in ("1", "true", "on", "yes"):
        return True
    return bool(GOOGLE_CLIENT_ID)


SIGNIN_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>ASTRA6 · sign in</title>
<style>
 :root{{--bg:#0b0e14;--card:#141922;--line:#232b38;--ink:#e8edf6;--mut:#8b97a8;--brand:#2962ff}}
 *{{box-sizing:border-box}} body{{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);
   font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
   display:grid;place-items:center;padding:24px}}
 .card{{width:100%;max-width:430px;background:var(--card);border:1px solid var(--line);
   border-radius:18px;padding:26px 22px;text-align:center}}
 .mark{{width:54px;height:54px;border-radius:16px;margin:0 auto 14px;
   background:linear-gradient(150deg,#ff7a59,#f5b642);display:grid;place-items:center;
   font-weight:900;color:#1a1207;font-size:20px}}
 h1{{font-size:20px;margin:0 0 6px;letter-spacing:-.2px}}
 p{{color:var(--mut);font-size:13px;margin:8px 0}}
 code{{background:#0d1219;border:1px solid var(--line);border-radius:6px;padding:2px 6px;
   font:12px ui-monospace,monospace;color:#f5b642;word-break:break-all}}
 #g{{min-height:44px;display:flex;justify-content:center;margin:18px 0 6px}}
 .note{{font-size:11.5px;color:var(--mut);margin-top:14px;line-height:1.6}}
 a{{color:var(--brand)}}
</style></head><body>
 <div class="card">
   <div class="mark">A6</div>
   <h1>ASTRA6 is private</h1>
   <p>Sign in with the owner Google account to open it.</p>
   <div id="g"></div>
   <div id="msg" class="note"></div>
   <div class="note">{extra}</div>
 </div>
<script src="https://accounts.google.com/gsi/client" async defer></script>
<script>
const CLIENT_ID = {client_id};
async function onCredential(r) {{
  const msg = document.getElementById('msg');
  msg.textContent = 'checking with Google…';
  try {{
    const res = await fetch('/api/owner/login', {{ method:'POST', credentials:'same-origin',
      headers:{{'Content-Type':'application/json'}}, body: JSON.stringify({{credential: r.credential}}) }});
    if (!res.ok) {{
      const d = await res.json().catch(()=>({{}}));
      msg.textContent = (d && d.detail && d.detail.error) ? d.detail.error.replace(/_/g,' ')
                        : 'That account is not allowed in.';
      return;
    }}
    location.reload();
  }} catch (e) {{ msg.textContent = 'Network error: ' + e.message; }}
}}
function draw() {{
  if (!window.google || !google.accounts || !CLIENT_ID) return;
  google.accounts.id.initialize({{ client_id: CLIENT_ID, callback: onCredential }});
  google.accounts.id.renderButton(document.getElementById('g'),
    {{ theme:'filled_black', size:'large', text:'signin_with', shape:'pill', width:280 }});
}}
window.addEventListener('load', () => setTimeout(draw, 300));
setTimeout(draw, 1200);
</script>
</body></html>"""


def signin_page(request: Request) -> str:
    origin = str(request.base_url).rstrip("/")
    if not GOOGLE_CLIENT_ID:
        extra = ("<b>No client id is configured on this server.</b> Add GOOGLE_CLIENT_ID in "
                 "Render → Environment (the public OAuth client id from Google Cloud Console) "
                 "and reload. Authorized JavaScript origin: <code>" + origin + "</code>")
    else:
        extra = ("Only <b>" + OWNER_EMAIL + "</b> can open this site. Authorized origin: "
                 "<code>" + origin + "</code>")
    page = SIGNIN_PAGE.replace("{{", "{").replace("}}", "}")   # the template is not an f-string
    return page.replace("{client_id}", json.dumps(GOOGLE_CLIENT_ID or "")).replace("{extra}", extra)
