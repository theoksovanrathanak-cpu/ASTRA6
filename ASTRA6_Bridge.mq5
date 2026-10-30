//+------------------------------------------------------------------+
//|                                                ASTRA6_Bridge.mq5 |
//|  ASTRA6 Elite - Best Gold Trading Signals 70%+ Winrate           |
//|  Bridge EA - No MetaAPI, No VPS, No password sharing             |
//|  Fetches signals from https://astra6.onrender.com                |
//|  Auto-trades on user's MT5 account perfectly                     |
//|                                                                  |
//|  How to use:                                                     |
//|  1. Copy to MT5 -> File -> Open Data Folder -> MQL5 -> Experts   |
//|  2. Compile in MetaEditor (F7) -> ASTRA6_Bridge.ex5              |
//|  3. Drag to XAUUSD chart M15                                     |
//|  4. Inputs: Email = same as website astra6render@gmail.com       |
//|  5. Allow WebRequest to https://astra6.onrender.com                |
//|  6. Bot will auto-trade your signals 24/7 free, no VPS           |
//+------------------------------------------------------------------+
#property copyright "ASTRA6 Elite"
#property link      "https://astra6.onrender.com"
#property version   "1.00"
#property description "ASTRA6 Bridge - Fetches signals from website and auto-trades on MT5, no MetaAPI, no VPS"

#include <Trade\Trade.mqh>
CTrade trade;

//--- Inputs
input string UserEmail = "astra6render@gmail.com"; // Email same as website
input string TelegramUsername = ""; // Optional Telegram @username without @
input bool AutoTrade = true; // Enable auto trading
input double LotSize = 0.1; // Lot size
input int MagicNumber = 20260927; // Magic number ASTRA6
input bool UseCurrentTF = true; // Use chart TF, else M15
input string ApiUrl = "https://astra6.onrender.com"; // Website API URL
input int ScanIntervalSeconds = 10; // Scan every 10 sec (M1 M5 M15 M30 H1)
input bool ShowLogs = true; // Show logs

//--- Globals
datetime lastScan = 0;
string lastSignalType = "";
double lastSignalPrice = 0;

//+------------------------------------------------------------------+
int OnInit()
{
   Print("🚀 ASTRA6_Bridge EA started - Email: ", UserEmail, " - Website: ", ApiUrl);
   Print("📊 Will fetch signals from ", ApiUrl, "/api/signals/current every ", ScanIntervalSeconds, " sec");
   Print("🔗 Make sure to allow WebRequest to ", ApiUrl, " in MT5 Tools -> Options -> Expert Advisors -> Allow WebRequest");
   
   // Set magic and deviation
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(30);
   
   // Timer for scanning
   EventSetTimer(ScanIntervalSeconds);
   
   // Initial scan
   FetchAndTrade();
   
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("🛑 ASTRA6_Bridge EA stopped - reason: ", reason);
}

//+------------------------------------------------------------------+
void OnTimer()
{
   FetchAndTrade();
}

//+------------------------------------------------------------------+
void OnTick()
{
   // Also check on tick for M1 if needed, but timer is main
   if(UseCurrentTF)
   {
      // For M1, check more frequently
      ENUM_TIMEFRAMES tf = Period();
      if(tf == PERIOD_M1 || tf == PERIOD_M5)
      {
         datetime now = TimeCurrent();
         if(now - lastScan >= ScanIntervalSeconds)
         {
            FetchAndTrade();
         }
      }
   }
}

//+------------------------------------------------------------------+
void FetchAndTrade()
{
   if(!AutoTrade) return;
   
   datetime now = TimeCurrent();
   if(now - lastScan < ScanIntervalSeconds) return;
   lastScan = now;
   
   string tf = GetTFString();
   
   // Fetch signal from website
   string url = ApiUrl + "/api/signals/current?email=" + UserEmail + "&tf=" + tf;
   if(TelegramUsername != "") url += "&telegram=" + TelegramUsername;
   
   if(ShowLogs) Print("📡 Fetching signal: ", url);
   
   string headers = "Content-Type: application/json\r\n";
   char data[];
   char result[];
   string result_headers;
   
   // For GET, data empty
   int res = WebRequest("GET", url, headers, 5000, data, result, result_headers);
   
   if(res == -1)
   {
      Print("❌ WebRequest failed - Check Tools -> Options -> Expert Advisors -> Allow WebRequest for ", ApiUrl);
      Print("Error: ", GetLastError());
      return;
   }
   
   if(res != 200)
   {
      if(ShowLogs) Print("⚠️ API returned ", res, " - ", CharArrayToString(result));
      return;
   }
   
   string response = CharArrayToString(result);
   if(ShowLogs) Print("📥 Response: ", response);
   
   // Parse JSON simple - look for signal type
   string signalType = ParseJsonString(response, "signal");
   if(signalType == "") signalType = ParseJsonString(response, "type");
   if(signalType == "") signalType = ParseJsonString(response, "alert_type");
   
   // Also check for alerts array
   if(signalType == "" || signalType == "HOLD")
   {
      // Try parse first alert
      // Simple parsing for BUY/SELL in response
      if(StringFind(response, "\"BUY\"") >= 0 || StringFind(response, "\"buy\"") >= 0 || StringFind(response, "BUY") >= 0)
         signalType = "BUY";
      else if(StringFind(response, "\"SELL\"") >= 0 || StringFind(response, "\"sell\"") >= 0 || StringFind(response, "SELL") >= 0)
         signalType = "SELL";
   }
   
   if(signalType == "") signalType = "HOLD";
   
   // Avoid duplicate trades
   if(signalType == lastSignalType && signalType != "HOLD")
   {
      if(ShowLogs) Print("⏭️ Same signal as last: ", signalType, " - skipping to avoid duplicate");
      return;
   }
   
   double price = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   
   // Get SL/TP from response if available
   double sl = 0, tp1 = 0, tp2 = 0;
   string sl_str = ParseJsonNumber(response, "sl");
   string tp1_str = ParseJsonNumber(response, "tp1");
   string tp2_str = ParseJsonNumber(response, "tp2");
   
   if(sl_str != "") sl = StringToDouble(sl_str);
   if(tp1_str != "") tp1 = StringToDouble(tp1_str);
   if(tp2_str != "") tp2 = StringToDouble(tp2_str);
   
   // If no SL/TP from API, calculate based on price action (human style)
   if(sl == 0)
   {
      // SL below support / above resistance - simplified
      if(signalType == "BUY") sl = price * 0.998; // 0.2% SL
      if(signalType == "SELL") sl = ask * 1.002;
   }
   if(tp1 == 0)
   {
      double risk = MathAbs(price - sl);
      if(signalType == "BUY") tp1 = price + risk * 1.5;
      if(signalType == "SELL") tp1 = price - risk * 1.5;
   }
   
   // Execute trade
   if(signalType == "BUY")
   {
      Print("🟢 BUY Signal detected - Price: ", price, " SL: ", sl, " TP: ", tp1);
      if(TradeBuy(sl, tp1))
      {
         lastSignalType = "BUY";
         lastSignalPrice = price;
         ReportTrade("BUY", price, sl, tp1, response);
      }
   }
   else if(signalType == "SELL")
   {
      Print("🔴 SELL Signal detected - Price: ", price, " SL: ", sl, " TP: ", tp1);
      if(TradeSell(sl, tp1))
      {
         lastSignalType = "SELL";
         lastSignalPrice = price;
         ReportTrade("SELL", price, sl, tp1, response);
      }
   }
   else
   {
      if(ShowLogs) Print("⏸️ HOLD - No trade - ", response);
   }
}

//+------------------------------------------------------------------+
bool TradeBuy(double sl, double tp)
{
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   if(ask == 0) return false;
   
   // Check if already have buy position with same magic
   if(HasOpenPosition(POSITION_TYPE_BUY)) 
   {
      Print("⚠️ Already have BUY position - skipping");
      return false;
   }
   
   bool ok = trade.Buy(LotSize, _Symbol, ask, sl, tp, "ASTRA6 BUY " + UserEmail);
   if(ok)
      Print("✅ BUY order placed - Ticket: ", trade.ResultOrder(), " Price: ", ask);
   else
      Print("❌ BUY failed - Error: ", GetLastError(), " Result: ", trade.ResultRetcode());
   
   return ok;
}

//+------------------------------------------------------------------+
bool TradeSell(double sl, double tp)
{
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(bid == 0) return false;
   
   if(HasOpenPosition(POSITION_TYPE_SELL))
   {
      Print("⚠️ Already have SELL position - skipping");
      return false;
   }
   
   bool ok = trade.Sell(LotSize, _Symbol, bid, sl, tp, "ASTRA6 SELL " + UserEmail);
   if(ok)
      Print("✅ SELL order placed - Ticket: ", trade.ResultOrder(), " Price: ", bid);
   else
      Print("❌ SELL failed - Error: ", GetLastError(), " Result: ", trade.ResultRetcode());
   
   return ok;
}

//+------------------------------------------------------------------+
bool HasOpenPosition(ENUM_POSITION_TYPE type)
{
   for(int i=0; i<PositionsTotal(); i++)
   {
      if(PositionGetSymbol(i) == _Symbol)
      {
         if(PositionGetInteger(POSITION_MAGIC) == MagicNumber)
         {
            if(PositionGetInteger(POSITION_TYPE) == type)
               return true;
         }
      }
   }
   return false;
}

//+------------------------------------------------------------------+
void ReportTrade(string type, double price, double sl, double tp, string apiResponse)
{
   string url = ApiUrl + "/api/mt5/trade";
   string json = StringFormat("{\"email\":\"%s\",\"telegram_username\":\"%s\",\"type\":\"%s\",\"symbol\":\"%s\",\"price\":%f,\"sl\":%f,\"tp\":%f,\"lot\":%f,\"magic\":%d,\"time\":\"%s\"}",
      UserEmail, TelegramUsername, type, _Symbol, price, sl, tp, LotSize, MagicNumber, TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS));
   
   if(ShowLogs) Print("📤 Reporting trade: ", json);
   
   string headers = "Content-Type: application/json\r\n";
   char data[];
   char result[];
   string result_headers;
   
   StringToCharArray(json, data);
   
   int res = WebRequest("POST", url, headers, 5000, data, result, result_headers);
   if(res == 200)
      Print("✅ Trade reported to website");
   else
      Print("⚠️ Report failed ", res, " - ", CharArrayToString(result));
}

//+------------------------------------------------------------------+
string GetTFString()
{
   if(UseCurrentTF)
   {
      ENUM_TIMEFRAMES tf = Period();
      if(tf == PERIOD_M1) return "M1";
      if(tf == PERIOD_M5) return "M5";
      if(tf == PERIOD_M15) return "M15";
      if(tf == PERIOD_M30) return "M30";
      if(tf == PERIOD_H1) return "H1";
      if(tf == PERIOD_H4) return "H4";
      return "M15";
   }
   return "M15";
}

//+------------------------------------------------------------------+
string ParseJsonString(string json, string key)
{
   string search = "\"" + key + "\"";
   int pos = StringFind(json, search);
   if(pos < 0) return "";
   pos = StringFind(json, ":", pos);
   if(pos < 0) return "";
   pos++;
   // Skip spaces and quotes
   while(pos < StringLen(json) && (StringGetCharacter(json, pos) == ' ' || StringGetCharacter(json, pos) == '"' || StringGetCharacter(json, pos) == 39))
      pos++;
   int start = pos;
   // Find end quote or comma or }
   while(pos < StringLen(json))
   {
      int c = StringGetCharacter(json, pos);
      if(c == '"' || c == ',' || c == '}' || c == 10 || c == 13) break;
      pos++;
   }
   string val = StringSubstr(json, start, pos - start);
   // Clean
   val = StringTrim(val);
   // Remove quotes if any
   StringReplace(val, "\"", "");
   return val;
}

//+------------------------------------------------------------------+
string ParseJsonNumber(string json, string key)
{
   string search = "\"" + key + "\"";
   int pos = StringFind(json, search);
   if(pos < 0) return "";
   pos = StringFind(json, ":", pos);
   if(pos < 0) return "";
   pos++;
   // Skip spaces
   while(pos < StringLen(json) && StringGetCharacter(json, pos) == ' ') pos++;
   int start = pos;
   while(pos < StringLen(json))
   {
      int c = StringGetCharacter(json, pos);
      if((c < '0' || c > '9') && c != '.' && c != '-') break;
      pos++;
   }
   if(pos <= start) return "";
   return StringSubstr(json, start, pos - start);
}

//+------------------------------------------------------------------+
string StringTrim(string s)
{
   StringTrimLeft(s);
   StringTrimRight(s);
   return s;
}
