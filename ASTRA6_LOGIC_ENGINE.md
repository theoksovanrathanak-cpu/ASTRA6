# ASTRA6 LOGIC ENGINE — Pine v6 indicator + the same engine on the website

Two runtimes, one rule set:

| file | what it is |
|---|---|
| `astra6_logic_engine.pine` | the TradingView indicator (Pine v6), all 16 sections of the brief |
| `logic_engine.py` | the identical model in Python, used by the site and by every measurement below |
| `tools/logic_sweep.py` | the harness that measures it on real bars from more than one vendor |

The site and the chart cannot drift apart: both call the same seven conditions, in the
same order, on the same three timeframes.

---

## 1. Install (TradingView)

1. Open a **XAUUSD** chart, set the interval to **1 minute**.
2. *Pine Editor → Open → New indicator*, delete the template, paste all of
   `astra6_logic_engine.pine`.
3. **Save** (`ASTRA6 LOGIC ENGINE`) → **Add to chart**.
4. Leave the confirmation timeframe at **5** and the bias timeframe at **60** for the
   intended M1 model. On a 5m chart use confirmation 15; on 15m use 60.
5. Alerts: *Add alert → Condition: ASTRA6 LOGIC ENGINE → any alert() function call*, or
   pick the named conditions `ASTRA6 LE · BUY` / `· SELL`. Set *Once per bar close* —
   never *once per bar*, because the script decides on closed bars only.

Installing on a broker's own chart (Exness/IC Markets) works the same way; the symbol
just needs real M1 history, which is what the model consumes.

---

## 2. The trading conditions, in order

**H1 — market direction.** Swing highs and lows are taken with a 3-bar pivot. Two rising
highs *and* two rising lows = bullish; the mirror = bearish. If structure is mixed, price
against the 20-bar mean decides, and that scores lower.

**M5 — confirmation.** Four things, and all four must exist before an entry is even
considered:

1. **Liquidity sweep** — a bar trades through a known swing/equal level and *closes back
   through it*, with the overshoot at least 0.05 ATR. A wick alone is not a sweep.
2. **BOS / MSS** — after the sweep, a close beyond the last swing that printed *before*
   the sweep. The pivot must already be confirmed.
3. **Displacement** — a bar whose body is at least 1.2 × ATR in the trade's direction.
4. **FVG** — a three-bar imbalance created *by that displacement*, still unfilled. That
   gap is the entry zone; a gap from before the displacement is not part of this setup.

**M1 — entry.** Price retraces into the gap, the entry bar closes in the trade's
direction, and price is on the right side of the 9 EMA. Only then does a signal print.

**Score (100).** H1 alignment 20 (12 if only the mean agrees) · sweep 20 · BOS/MSS 15 (10
if it came more than 6 confirmation bars after the sweep) · displacement 15 · FVG 15 ·
entry momentum 15 (10 + 5). A trade needs the structural four *and* ≥ minimum score
(default 70; "Conservative" raises it to 75, "Aggressive" lowers it to 65).

**Risk.** Stop below the sweep low (BUY) or above the sweep high (SELL), plus 0.15 ATR of
buffer. TP1–TP4 at 1R / 1.5R / 2R / 3R from the *actual* entry, all adjustable. Optional
break-even after TP1 and ATR trailing after TP2.

---

## 3. What is honest about the statistics

* The dashboard counts **this indicator's own signals only**, booked by a stated model.
* A bar that touches both the stop and a target books the **stop**. Assuming the target
  inside an ambiguous bar is how a backtest flatters itself.
* Each TP mode is selectable; a trade that reached TP2 and then reversed books 1.5R at
  mode 2 and its real ending at modes 3–4.
* These are **simulated** results on real bars. They are not broker fills, not slippage,
  not spread beyond the optional input, and not a promise.

### Measured when this model was built (2026-09-26)

Same engine, real bars, 0.35 spread charged on every trade:

| sample | trades | TP1 | TP2 | TP4 | halves (TP2) |
|---|---|---|---|---|---|
| Yahoo GC=F M1, 7 sessions, M5 confirm, H1 bias | 21 | −0.118R | +0.027R | +0.183R | −0.361 / +0.379 |
| Yahoo GC=F M5, 60 days, M15 confirm, H1 bias | 41 | −0.323R | −0.269R | −0.062R | −0.105 / −0.425 |

The M1 sample is too small to conclude anything; the 60-day sample is large enough to say
this model, exactly as specified, does **not** have a measurable edge on gold intraday.
Every stop/target geometry tried on the same setups (stop at the sweep, at the FVG, the
tighter of the two, risk capped to 2–3 ATR, fresh-gap-only entries) was negative too.

Because of that, the website runs the engine but **the gate still decides what prints**:
a setup prints only when its bucket *and* its family are net positive and stable with at
least 12 closed trades. Right now they are not, so the card says HOLD and tells you why.
That is the honest state of this model, not a bug.

---

## 4. Non-repainting: what is guaranteed, and what it costs

* Decisions happen on `barstate.isconfirmed` — the signal is drawn on the bar that just
  closed, and the earliest possible fill is the next bar's open. **That is a one-bar
  delay by design.** An indicator that prints on the forming bar is advertising a price
  you could not have traded.
* Higher timeframes use `request.security(expr[1], lookahead_on)`. `[1]` pins the value
  to an already-closed bar; `lookahead_on` only means "this bar's value when it closes",
  and combined with `[1]` it cannot see the future. (`lookahead_off` + `[1]` would give
  you *two*-bar-old data instead of one.)
* Pivots are only referenced `pivotLen` bars after they print.
* Historical labels, lines and boxes are never moved.

**Unavoidable limit:** a Pine indicator cannot know real broker fills, spreads, swaps or
slippage. The prices plotted are chart prices. Simulated results will always be better
than a live account, and the dashboard says "simulated" for that reason.

---

## 5. Object limits and performance

Arrays are capped (400 confirmation bars, 240 bias bars, 20 levels, 40 boxes, 40 BOS
tags), and the most recent trade's six lines are reused instead of piling up. That keeps
the script inside TradingView's drawing limits on a 1-minute chart left running for days.

---

## 6. On the website

`/api/volume` now serves this engine's read. The card shows entry, SL, TP1–TP4, the score
out of 100 and the exact timeframe plan it used (`M1 entry · M5 confirmation · H1 bias`).
`/api/signals/stats` reports the engine's own replay as the `liquidity sweep` family, so
the two-level gate judges it exactly like every other family.
