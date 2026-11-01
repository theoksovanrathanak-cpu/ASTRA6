"""End-to-end proof of the phone push, without a real phone.

A fake push service listens on 127.0.0.1 and records what the server sends. The
subscription carries real p256dh/auth keys, so the body is genuinely encrypted by
pywebpush and we decrypt it again here - which proves the card the phone would
draw, not just that a request left.
"""
import base64
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
import http_ece

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

RECEIVED = []


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        RECEIVED.append({"body": body, "headers": dict(self.headers), "path": self.path})
        self.send_response(201)
        self.end_headers()

    def log_message(self, *a):
        pass


def b64u(b):
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def make_sub(endpoint):
    priv = ec.generate_private_key(ec.SECP256R1())
    raw = priv.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    auth = b"\x01" * 16
    return priv, {
        "endpoint": endpoint,
        "keys": {"p256dh": b64u(raw), "auth": b64u(auth)},
        "expirationTime": None,
    }


def decrypt(rec, priv, auth_secret):
    # aes128gcm carries salt and the sender's key in the body header itself
    plain = http_ece.decrypt(rec["body"], private_key=priv,
                             auth_secret=auth_secret, version="aes128gcm")
    return json.loads(plain.decode("utf-8"))


def main():
    up = HTTPServer(("127.0.0.1", 8899), H)
    threading.Thread(target=up.serve_forever, daemon=True).start()

    base = "http://127.0.0.1:8010"
    # a clean slate: subscriptions left by an earlier run would decrypt to nothing
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        os.remove(os.path.join(here, "push_subs.json"))
    except OSError:
        pass
    st = requests.get(base + "/api/push/status", timeout=10).json()
    assert st.get("ready"), st
    print("status:", st)

    priv, sub = make_sub("http://127.0.0.1:8899/push/abc123")
    rules = [{"id": "r1", "sym": "XAUUSD", "kind": "above", "price": 100.0},
             {"id": "r2", "sym": "BTCUSD", "kind": "rsi_above", "price": 1.0}]
    r = requests.post(base + "/api/push/subscribe", json={
        "subscription": sub, "rules": rules, "readCard": {"on": False, "syms": []}}, timeout=20).json()
    print("subscribe:", r)
    assert r.get("status") == "ok", r

    # the tab went away -> the server must treat the phone as asleep and ring it
    requests.post(base + "/api/push/sync", json={
        "endpoint": sub["endpoint"], "rules": rules, "awake": False}, timeout=20)
    time.sleep(1)
    scan = requests.post(base + "/api/push/scan", timeout=40).json()
    print("scan:", scan)
    time.sleep(1)
    print("received:", len(RECEIVED))
    assert RECEIVED, "no push reached the fake service"

    for rec in RECEIVED:
        card = decrypt(rec, priv, b"\x01" * 16)
        print("CARD:", json.dumps(card, ensure_ascii=False))
        assert card["title"] and card["body"]
        assert card["sym"] in ("XAUUSD", "BTCUSD")
        assert card["url"].startswith("/?")

    # ---- the market-read card: only a CHANGE of read is news ----
    import pushweb
    subs = pushweb.subscribers()
    rec0 = [r for r in subs if r.get("endpoint") == sub["endpoint"]][0]
    assert rec0.get("fired"), "the fired marks were not stored"
    # arm the read card and let it see one state first
    requests.post(base + "/api/push/sync", json={
        "endpoint": sub["endpoint"], "rules": [],
        "readCard": {"on": True, "syms": ["XAUUSD"]}, "awake": False}, timeout=20)
    before = len(RECEIVED)
    requests.post(base + "/api/push/scan", timeout=60)     # first sighting: silent
    time.sleep(1)
    assert len(RECEIVED) == before, "the first sighting must not ring the phone"

    # now pretend the read changed since last time and scan again
    rows = json.load(open(os.path.join(os.path.dirname(os.path.abspath(pushweb.__file__)), "push_subs.json")))
    for r in rows:
        if r.get("endpoint") == sub["endpoint"]:
            r["readState"] = {"XAUUSD": "STALE|$0.00"}
    json.dump(rows, open(os.path.join(os.path.dirname(os.path.abspath(pushweb.__file__)), "push_subs.json"), "w"))
    requests.post(base + "/api/push/scan", timeout=60)
    time.sleep(1)
    assert len(RECEIVED) > before, "a changed read must reach the phone"
    card = decrypt(RECEIVED[-1], priv, b"\x01" * 16)
    print("READ CARD:", json.dumps(card, ensure_ascii=False))
    assert card["kind"] == "read" and "not a guarantee" in card["body"]

    # ---- a BUY / SELL setup rule rides the same read ----
    requests.post(base + "/api/push/subscribe", json={
        "subscription": sub, "readCard": {"on": False, "syms": []},
        "rules": [{"id": "r3", "sym": "XAUUSD", "kind": "read_buy", "price": 0},
                  {"id": "r4", "sym": "XAUUSD", "kind": "read_sell", "price": 0}]}, timeout=20)
    requests.post(base + "/api/push/sync", json={"endpoint": sub["endpoint"], "awake": False,
                 "rules": [{"id": "r3", "sym": "XAUUSD", "kind": "read_buy", "price": 0},
                           {"id": "r4", "sym": "XAUUSD", "kind": "read_sell", "price": 0}]}, timeout=20)
    before = len(RECEIVED)
    requests.post(base + "/api/push/scan", timeout=60)
    time.sleep(1)
    kinds = []
    for rec in RECEIVED[before:]:
        c = decrypt(rec, priv, b"\x01" * 16)
        kinds.append((c["kind"], c["title"]))
        assert "not a guarantee" in c["body"]
    for k in kinds:
        assert k[0] == "read"
    print("SETUP CARDS SENT:", len(kinds))

    # the setup branch itself, deterministically: BUY read -> BUY card, never a SELL card
    import pushweb
    pushweb.configure(read_fn=lambda s: {"state": "BUY|$1.00", "title": "TEST · BUY setup at $1.00",
                                         "body": "cluster read on 15m"})
    r_buy = {"endpoint": "x", "rules": [{"id": "b1", "sym": "XAUUSD", "kind": "read_buy", "price": 0}],
             "fired": {}, "last": {}}
    cards_buy = pushweb.eval_rules(r_buy)
    assert len(cards_buy) == 1 and cards_buy[0]["kind"] == "read", cards_buy
    assert "not a guarantee" in cards_buy[0]["body"]
    r_sell = {"endpoint": "x", "rules": [{"id": "s1", "sym": "XAUUSD", "kind": "read_sell", "price": 0}],
              "fired": {}, "last": {}}
    assert pushweb.eval_rules(r_sell) == [], "a BUY read must never fire a SELL alert"
    print("SETUP BRANCH OK:", cards_buy[0]["title"])

    # a test card always goes out, awake or not
    t = requests.post(base + "/api/push/test", json={"endpoint": sub["endpoint"], "sym": "BTCUSD"},
                      timeout=40).json()
    print("test:", t)
    assert t.get("sent") == 1
    print("ALL PUSH CHECKS PASSED")


if __name__ == "__main__":
    main()
