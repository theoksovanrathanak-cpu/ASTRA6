# REAL Exness Trading - No Simulated, Pure Web Control

## For TRUE REAL Exness trading via MT5 Direct (not simulated)

### Option 1: Deriv REAL (Works NOW on Render free 24/7 via HTTP)
- Go to https://app.deriv.com/account/api-token
- Create token with Read, Trade, Trading info scopes
- Paste in ASTRA6 Account -> Connect Broker -> Deriv
- Bot will do REAL trades via WebSocket wss://ws.binaryws.com/websockets/v3
- Returns real contract ID, real balance

### Option 2: Exness REAL via Exness API (Vietnam only currently)
- Exness Personal Area -> API page -> Generate API key (needs verification + deposit)
- API docs: https://www.exness-api.com/
- Paste API key in Exness fields
- Backend calls https://api.exness.com/v1/accounts for real trading
- Note: Exness says "only available in Vietnam region at moment"

### Option 3: Exness REAL via MT5 Direct (TRUE REAL, needs MT5 terminal)
- Uses MetaTrader5 Python library: mt5.initialize(login, server, password) + mt5.order_send()
- This is REAL Exness trading, not simulated
- Requires:
  1. MT5 terminal running (on Windows) OR
  2. Docker with Wine + MT5 (xm-exness-mt5-linux) for Linux/Render
  3. MetaTrader5 pip package

#### For Render free (current deployment):
- Render is Linux, no MT5 terminal, so MetaTrader5 library fails
- We fallback to real attempt with real price but explain need for Docker
- For true real Exness on Render free, use Deriv (real via WebSocket works)

#### For TRUE REAL Exness on your own VPS/Docker:
1. Use xm-exness-mt5-linux: https://github.com/essamamdani/xm-exness-mt5-linux
   - Docker image with Wine + MT5 + REST API for multiple accounts
   - Supports Exness, XM, etc.
   - REST API to manage accounts, place trades

2. Or create your own Docker:
```dockerfile
FROM python:3.11-slim
RUN dpkg --add-architecture i386 && apt-get update && apt-get install -y wine64 wine32 xvfb
RUN pip install MetaTrader5 mt5linux fastapi uvicorn
COPY . /app
WORKDIR /app
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "10000"]
```

3. Run MT5 terminal via Wine:
```bash
xvfb-run wine mt5setup.exe
xvfb-run wine ~/.wine/drive_c/Program\ Files/MetaTrader\ 5/terminal64.exe
```

4. Then Python can connect:
```python
import MetaTrader5 as mt5
mt5.initialize(login=12345678, server="Exness-MT5Real5", password="your_password")
account_info = mt5.account_info()
print(account_info.balance)  # REAL balance
tick = mt5.symbol_info_tick("XAUUSD")
request = {
    "action": mt5.TRADE_ACTION_DEAL,
    "symbol": "XAUUSD",
    "volume": 0.01,
    "type": mt5.ORDER_TYPE_BUY,
    "price": tick.ask,
    "sl": 0.0,
    "tp": 0.0,
    "deviation": 20,
    "magic": 202406,
    "comment": "ASTRA6 REAL",
    "type_time": mt5.ORDER_TIME_GTC,
    "type_filling": mt5.ORDER_FILLING_IOC,
}
result = mt5.order_send(request)
print(result.order)  # REAL order ID
```

### Current ASTRA6 Implementation:
- `main.py` now has REAL Exness MT5 Direct code via MetaTrader5 library
- If MetaTrader5 not installed (Render free), it returns REAL attempt with real price and explains Docker setup
- For Deriv, it's already REAL via WebSocket and works on Render free

### For User in Phnom Penh, Cambodia:
- Deriv REAL works globally via WebSocket, free, no VPS needed, works on Render free
- Exness API is Vietnam only, so may not work for Cambodia
- Exness MT5 Direct via MetaTrader5 needs MT5 terminal + Wine Docker, which is possible on Render with Dockerfile but needs more RAM (free plan limited)

**Recommendation:**
- Use Deriv for TRUE REAL trading now on free hosting (works 24/7 via HTTP/WSS)
- For Exness TRUE REAL, deploy xm-exness-mt5-linux on a $5 VPS or use Exness WebTerminal automation

### Balance, Total Trades, Calendar:
- Now shows REAL balance from Deriv API (via WebSocket) or simulated PnL from trades
- Total trades counts real trades from broker_trades.json
- Calendar groups trades by date with daily PnL
- All stored in broker_trades.json, persists via git

