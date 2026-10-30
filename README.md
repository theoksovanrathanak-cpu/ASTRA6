# ASTRA6 — XAUUSD Real-Data Dashboard

Live gold dashboard (FastAPI + lightweight-charts). One page, free access, no sign-in,
**real market data only**.

## Trust policy: no fabricated data, ever

Every price and every candle comes from a real upstream source. If all sources fail the API
says so (`candle_feed_unavailable`) instead of inventing numbers. The old mock candle
generator (hardcoded base `4284.97`) was deleted — it was the reason the chart showed $4290
while the header showed $3874.

## Price chain (`/api/xauusd/fast-price`)

| # | Source | Notes |
|---|--------|-------|
| 0 | **xaus.com** `/api/v1/spot` | primary, free, no key, `data_state {fresh,stale,unavailable}` |
| 1 | yfinance `GC=F` | COMEX gold, real live market |
| 2 | Currency-API XAU→USD | jsdelivr CDN, real forex |
| 3 | gold-api.com | real spot |
| 4 | Coingecko PAXG | tokenized gold peg |

Honest 503 from xaus.com (`usage_exceeded`) → silently falls through to the next real source,
and reports which one answered in `source`.

## Candle chain (`/api/xauusd/history`)

| # | Source | Notes |
|---|--------|-------|
| 1 | OANDA `XAU_USD` | only if `OANDA_API_KEY` is set |
| 2 | **xaus.com** `/api/v1/chart?symbol=xau` | same spot instrument as the header — last candle == header price |
| 3 | xaus.com `/api/v1/history` | 5y daily closes → D1 / W1 |
| 4 | yfinance `GC=F` | real futures OHLCV fallback |
| — | none | returns `candle_feed_unavailable`, never fake |

Timeframes: `M1 M5 M15 M30 H1 H4 D W`. The newest candle is re-pinned to the live spot price
on every tick, so the chart moves with the header.

## API

| Endpoint | What |
|---|---|
| `/api/xauusd/fast-price` | live bid/ask/mid (1s updates) |
| `/api/xauusd/live` | live price + last complete / forming candle |
| `/api/xauusd/history?granularity=M15&count=150` | real OHLCV candles + `source` |
| `/api/signals/current` | current signal (price = real live price) |
| `/api/xauusd/yfinance` · `/gc` | GC=F live quote |
| `/api/xauusd/yfinance/history` | GC=F candles |
| `/api/xauusd/xaus/spot` | XAUS spot (with honest fallback flag) |
| `/api/xauusd/xaus/intraday` | 2–5 min first-party series |
| `/api/xauusd/xaus/history` | 5y daily |
| `/api/xauusd/xaus/chart` | multi-asset OHLCV |
| `/api/xauusd/xaus/reserves` | central-bank gold holdings |
| `/api/xauusd/sources` | all real sources side by side + average |
| `/api/xauusd/xaus/info` | integration docs |

Vendor docs for the gold API live in [`xaus-api/`](xaus-api) (from
[misix-git/xaus-api](https://github.com/misix-git/xaus-api.git), MIT).

## Live deployments

| Service | URL | Plan |
|---|---|---|
| `astra6-real` | https://astra6-real.onrender.com | Render free, Singapore |
| `renderbot-v2` | https://renderbot-v2.onrender.com | Render free, Singapore (now deploys from this repo) |

Both run this repo's `main` branch. Health check: `/health`.

## GoCharting integration

GoCharting's charting SDK is licensed (free tier with attribution, but you must request a
licence credential — the package is not on npm). Everything on our side is already wired:

| Endpoint | What |
|---|---|
| `/api/gocharting/config` | whether a credential is configured, symbols, resolutions |
| `/api/gocharting/udf/config` · `/time` · `/symbols` · `/history` | standard UDF datafeed |

`/api/gocharting/udf/history` returns **real** XAUS / TradingView venue candles in UDF shape
(`s, t, o, h, l, c, v`) — no synthetic bars, same series the site draws.

Activate the embedded widget by setting two env vars in Render:

```
GOCHARTING_LICENCE_KEY=<credential from gocharting.com/sdk/docs>
GOCHARTING_SDK_URL=https://<where the sdk bundle is served>/chart-sdk.js
```

Until then the panel shows a "Get the free licence" card and the
**Open XAUUSD in GoCharting** button deep-links to their terminal.

## Run

```bash
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

## Deploy (Render)

`render.yaml` is ready: Python web service, `pip install -r requirements.txt`,
`uvicorn main:app --host 0.0.0.0 --port $PORT`, health check `/health`, auto-deploy on push.

Optional env vars: `OANDA_API_KEY`, `OANDA_ACCOUNT_ID`, `SMTP_*`, `TELEGRAM_BOT_TOKEN`,
`BOT_TOKEN`, `EMAIL_WEBHOOK_URL`, `GITHUB_TOKEN`, `GITHUB_REPO_URL`.

## Security

`users.json`, `tokens.json`, `broker_accounts.json`, `signals.json` are **git-ignored and
never committed** — they hold password hashes, session tokens and broker credentials. They are
created at runtime; on Render's free tier the filesystem is ephemeral, so they reset on
redeploy unless `GITHUB_TOKEN` + `GITHUB_REPO_URL` are configured for backup.
