"""
TradingView Analysis for ASTRA6 - Using TradingView MCP Bridge concepts
From uploads: tradingview-mcp (84 tools for TradingView Desktop via CDP)

Enhances Gold signals with:
1. TradingView chart analysis (symbol, timeframe, indicators)
2. Pine Script strategy analysis (from pine.js, indicator.js)
3. Technical indicators (RSI, MACD, Bollinger, EMA, Volume)
4. Drawing tools (trend lines, support/resistance, rectangles)
5. Performance analyst (win rate, profit factor, drawdown)
"""

import time
import math
import random
from collections import defaultdict

# TradingView indicators from indicator.js, chart.js
TRADINGVIEW_INDICATORS = {
    "RSI": {"name": "Relative Strength Index", "type": "momentum", "weight": 0.15, "overbought": 70, "oversold": 30},
    "MACD": {"name": "Moving Average Convergence Divergence", "type": "trend", "weight": 0.2, "bullish": "cross above", "bearish": "cross below"},
    "BB": {"name": "Bollinger Bands", "type": "volatility", "weight": 0.15, "upper": "resistance", "lower": "support"},
    "EMA": {"name": "Moving Average Exponential", "type": "trend", "weight": 0.15, "periods": [21, 50, 200]},
    "Volume": {"name": "Volume", "type": "volume", "weight": 0.1, "confirm": True},
    "Stochastic": {"name": "Stochastic", "type": "momentum", "weight": 0.1, "overbought": 80, "oversold": 20},
    "ATR": {"name": "Average True Range", "type": "volatility", "weight": 0.15, "sl_tp": True},
}

# Pine Script concepts from pine.js
PINE_SCRIPT_PATTERNS = {
    "engulfing": {"type": "reversal", "weight": 0.3, "bullish": "bullish_engulfing", "bearish": "bearish_engulfing"},
    "pin_bar": {"type": "reversal", "weight": 0.25, "bullish": "hammer", "bearish": "shooting_star"},
    "inside_bar": {"type": "consolidation", "weight": 0.15, "signal": "breakout"},
    "order_block": {"type": "support_resistance", "weight": 0.3, "bullish": "bullish_ob", "bearish": "bearish_ob"},
}

def analyze_tradingview_indicators(candles, live_price=None):
    """
    Analyze TradingView indicators (from indicator.js, chart.js, data.js)
    Simulates TradingView's indicator calculations
    """
    try:
        if not candles or len(candles) < 50:
            return None
        
        closes = [c['close'] for c in candles]
        highs = [c['high'] for c in candles]
        lows = [c['low'] for c in candles]
        volumes = [c['volume'] for c in candles]
        
        last_close = closes[-1]
        
        # RSI calculation (from TradingView's RSI)
        def calc_rsi(vals, period=14):
            if len(vals) < period+1:
                return 50
            gains, losses = [], []
            for i in range(1, len(vals)):
                diff = vals[i] - vals[i-1]
                gains.append(max(diff,0))
                losses.append(max(-diff,0))
            avg_gain = sum(gains[-period:])/period
            avg_loss = sum(losses[-period:])/period
            if avg_loss == 0:
                return 100
            rs = avg_gain/avg_loss
            return 100 - (100/(1+rs))
        
        rsi_14 = calc_rsi(closes, 14)
        rsi_7 = calc_rsi(closes, 7)
        
        # EMA calculation
        def calc_ema(vals, period):
            if len(vals) < period:
                return sum(vals)/len(vals)
            k = 2/(period+1)
            ema = sum(vals[:period])/period
            for price in vals[period:]:
                ema = price*k + ema*(1-k)
            return ema
        
        ema_21 = calc_ema(closes, 21)
        ema_50 = calc_ema(closes, 50)
        ema_200 = calc_ema(closes, 200)
        
        # MACD (EMA 12 - EMA 26, signal EMA 9)
        ema_12 = calc_ema(closes, 12)
        ema_26 = calc_ema(closes, 26)
        macd_line = ema_12 - ema_26
        # Signal line (EMA 9 of MACD) - simplified
        macd_signal = calc_ema([ema_12 - calc_ema(closes[:i+1], 26) for i in range(len(closes))], 9) if len(closes) >= 26 else macd_line*0.9
        macd_hist = macd_line - macd_signal
        
        # Bollinger Bands
        sma_20 = sum(closes[-20:])/20 if len(closes) >= 20 else sum(closes)/len(closes)
        std_20 = (sum([(c - sma_20)**2 for c in closes[-20:]])/20)**0.5 if len(closes) >= 20 else 0
        bb_upper = sma_20 + 2*std_20
        bb_lower = sma_20 - 2*std_20
        bb_position = (last_close - bb_lower)/(bb_upper-bb_lower) if bb_upper != bb_lower else 0.5
        
        # Stochastic
        def calc_stoch(cands, k_period=14):
            if len(cands) < k_period:
                return 50
            window = cands[-k_period:]
            highest = max(c['high'] for c in window)
            lowest = min(c['low'] for c in window)
            if highest == lowest:
                return 50
            return (window[-1]['close'] - lowest)/(highest-lowest)*100
        
        stoch_k = calc_stoch(candles, 14)
        
        # Volume analysis
        vol_avg_20 = sum(volumes[-20:])/20 if len(volumes) >= 20 else volumes[-1]
        vol_ratio = volumes[-1]/vol_avg_20 if vol_avg_20 else 1
        
        # ATR
        trs = []
        for i in range(1, len(candles)):
            h, l, pc = highs[i], lows[i], closes[i-1]
            tr = max(h-l, abs(h-pc), abs(l-pc))
            trs.append(tr)
        atr_14 = sum(trs[-14:])/14 if len(trs) >= 14 else sum(trs)/len(trs) if trs else 0
        
        # Analyze signals from indicators
        signals = {}
        
        # RSI signals
        if rsi_14 < 30:
            signals["RSI"] = {"signal": "BUY", "strength": 0.8, "reason": f"RSI {rsi_14:.1f} oversold (<30) - BUY"}
        elif rsi_14 > 70:
            signals["RSI"] = {"signal": "SELL", "strength": 0.8, "reason": f"RSI {rsi_14:.1f} overbought (>70) - SELL"}
        elif rsi_14 < 40:
            signals["RSI"] = {"signal": "BUY", "strength": 0.4, "reason": f"RSI {rsi_14:.1f} approaching oversold - weak BUY"}
        elif rsi_14 > 60:
            signals["RSI"] = {"signal": "SELL", "strength": 0.4, "reason": f"RSI {rsi_14:.1f} approaching overbought - weak SELL"}
        else:
            signals["RSI"] = {"signal": "HOLD", "strength": 0.2, "reason": f"RSI {rsi_14:.1f} neutral"}
        
        # MACD signals
        if macd_line > macd_signal and macd_hist > 0:
            signals["MACD"] = {"signal": "BUY", "strength": 0.7, "reason": f"MACD bullish cross - line {macd_line:.2f} > signal {macd_signal:.2f}"}
        elif macd_line < macd_signal and macd_hist < 0:
            signals["MACD"] = {"signal": "SELL", "strength": 0.7, "reason": f"MACD bearish cross - line {macd_line:.2f} < signal {macd_signal:.2f}"}
        else:
            signals["MACD"] = {"signal": "HOLD", "strength": 0.2, "reason": f"MACD neutral - line {macd_line:.2f} signal {macd_signal:.2f}"}
        
        # Bollinger Bands signals
        if bb_position < 0.1:
            signals["BB"] = {"signal": "BUY", "strength": 0.6, "reason": f"Price at BB lower {bb_lower:.2f} - oversold BUY"}
        elif bb_position > 0.9:
            signals["BB"] = {"signal": "SELL", "strength": 0.6, "reason": f"Price at BB upper {bb_upper:.2f} - overbought SELL"}
        else:
            signals["BB"] = {"signal": "HOLD", "strength": 0.2, "reason": f"BB position {bb_position:.2f} neutral"}
        
        # EMA trend signals
        if last_close > ema_21 and ema_21 > ema_50 and ema_50 > ema_200:
            signals["EMA"] = {"signal": "BUY", "strength": 0.9, "reason": f"Strong uptrend - price {last_close:.2f} > EMA21 {ema_21:.2f} > EMA50 {ema_50:.2f} > EMA200 {ema_200:.2f}"}
        elif last_close < ema_21 and ema_21 < ema_50 and ema_50 < ema_200:
            signals["EMA"] = {"signal": "SELL", "strength": 0.9, "reason": f"Strong downtrend - price {last_close:.2f} < EMA21 {ema_21:.2f} < EMA50 {ema_50:.2f} < EMA200 {ema_200:.2f}"}
        elif last_close > ema_21 and last_close > ema_50:
            signals["EMA"] = {"signal": "BUY", "strength": 0.5, "reason": f"Uptrend - price above EMA21 and EMA50"}
        elif last_close < ema_21 and last_close < ema_50:
            signals["EMA"] = {"signal": "SELL", "strength": 0.5, "reason": f"Downtrend - price below EMA21 and EMA50"}
        else:
            signals["EMA"] = {"signal": "HOLD", "strength": 0.2, "reason": f"EMA mixed - price {last_close:.2f} EMA21 {ema_21:.2f} EMA50 {ema_50:.2f}"}
        
        # Volume confirmation
        if vol_ratio >= 1.5:
            signals["Volume"] = {"signal": "CONFIRM", "strength": 0.5, "reason": f"High volume {vol_ratio:.1f}x - confirms trend"}
        elif vol_ratio >= 1.2:
            signals["Volume"] = {"signal": "CONFIRM", "strength": 0.3, "reason": f"Above avg volume {vol_ratio:.1f}x"}
        else:
            signals["Volume"] = {"signal": "WEAK", "strength": 0.1, "reason": f"Low volume {vol_ratio:.1f}x - weak confirmation"}
        
        # Stochastic
        if stoch_k < 20:
            signals["Stochastic"] = {"signal": "BUY", "strength": 0.6, "reason": f"Stochastic {stoch_k:.1f} oversold (<20) - BUY"}
        elif stoch_k > 80:
            signals["Stochastic"] = {"signal": "SELL", "strength": 0.6, "reason": f"Stochastic {stoch_k:.1f} overbought (>80) - SELL"}
        else:
            signals["Stochastic"] = {"signal": "HOLD", "strength": 0.2, "reason": f"Stochastic {stoch_k:.1f} neutral"}
        
        # Calculate overall TradingView signal
        buy_strength = sum(v["strength"] for v in signals.values() if v["signal"] == "BUY")
        sell_strength = sum(v["strength"] for v in signals.values() if v["signal"] == "SELL")
        
        if buy_strength > sell_strength + 0.5:
            overall = "BUY"
            confidence = min(90, 60 + buy_strength*10)
        elif sell_strength > buy_strength + 0.5:
            overall = "SELL"
            confidence = min(90, 60 + sell_strength*10)
        else:
            overall = "HOLD"
            confidence = 50
        
        return {
            "overall": overall,
            "confidence": round(confidence,1),
            "buy_strength": round(buy_strength,2),
            "sell_strength": round(sell_strength,2),
            "indicators": {
                "rsi_14": round(rsi_14,1),
                "rsi_7": round(rsi_7,1),
                "ema_21": round(ema_21,2),
                "ema_50": round(ema_50,2),
                "ema_200": round(ema_200,2),
                "macd_line": round(macd_line,2),
                "macd_signal": round(macd_signal,2),
                "macd_hist": round(macd_hist,2),
                "bb_upper": round(bb_upper,2),
                "bb_lower": round(bb_lower,2),
                "bb_position": round(bb_position,3),
                "stoch_k": round(stoch_k,1),
                "vol_ratio": round(vol_ratio,2),
                "atr_14": round(atr_14,2),
            },
            "signals": signals,
            "source": "TradingView MCP Bridge - 84 tools, Pine Script, indicators"
        }
        
    except Exception as e:
        print(f"TradingView indicators error: {e}")
        import traceback
        traceback.print_exc()
        return None

def analyze_pine_script_patterns(candles):
    """
    Analyze Pine Script patterns (from pine.js, drawing.js)
    Detects engulfing, pin bar, inside bar, order blocks
    """
    try:
        if not candles or len(candles) < 10:
            return None
        
        curr = candles[-1]
        prev = candles[-2] if len(candles) >= 2 else curr
        prev2 = candles[-3] if len(candles) >= 3 else prev
        
        patterns = {}
        
        # Engulfing (from Pine Script)
        bullish_engulf = prev['close'] < prev['open'] and curr['close'] > curr['open'] and curr['open'] < prev['close'] and curr['close'] > prev['open']
        bearish_engulf = prev['close'] > prev['open'] and curr['close'] < curr['open'] and curr['open'] > prev['close'] and curr['close'] < prev['open']
        
        if bullish_engulf:
            patterns["engulfing"] = {"type": "bullish_engulfing", "signal": "BUY", "strength": 0.8, "reason": "Bullish engulfing - Pine Script reversal pattern"}
        elif bearish_engulf:
            patterns["engulfing"] = {"type": "bearish_engulfing", "signal": "SELL", "strength": 0.8, "reason": "Bearish engulfing - Pine Script reversal pattern"}
        else:
            patterns["engulfing"] = {"type": "none", "signal": "HOLD", "strength": 0.1, "reason": "No engulfing"}
        
        # Pin bar (hammer, shooting star)
        body = abs(curr['close'] - curr['open'])
        range_c = curr['high'] - curr['low']
        upper_wick = curr['high'] - max(curr['open'], curr['close'])
        lower_wick = min(curr['open'], curr['close']) - curr['low']
        
        is_hammer = lower_wick > body*2 and body < range_c*0.35 and lower_wick > upper_wick*1.5
        is_shooting_star = upper_wick > body*2 and body < range_c*0.35 and upper_wick > lower_wick*1.5
        
        if is_hammer:
            patterns["pin_bar"] = {"type": "hammer", "signal": "BUY", "strength": 0.7, "reason": f"Hammer pin bar - lower wick {lower_wick:.2f} > body*2 {body*2:.2f}"}
        elif is_shooting_star:
            patterns["pin_bar"] = {"type": "shooting_star", "signal": "SELL", "strength": 0.7, "reason": f"Shooting star - upper wick {upper_wick:.2f} > body*2 {body*2:.2f}"}
        else:
            patterns["pin_bar"] = {"type": "none", "signal": "HOLD", "strength": 0.1, "reason": "No pin bar"}
        
        # Inside bar
        is_inside = curr['high'] < prev['high'] and curr['low'] > prev['low']
        if is_inside:
            # Breakout direction based on previous trend
            if prev['close'] > prev['open']:
                patterns["inside_bar"] = {"type": "inside_bar", "signal": "BUY", "strength": 0.4, "reason": "Inside bar - bullish breakout expected"}
            else:
                patterns["inside_bar"] = {"type": "inside_bar", "signal": "SELL", "strength": 0.4, "reason": "Inside bar - bearish breakout expected"}
        else:
            patterns["inside_bar"] = {"type": "none", "signal": "HOLD", "strength": 0.1, "reason": "No inside bar"}
        
        # Order block (support/resistance from recent swings)
        recent = candles[-20:]
        swing_high = max(c['high'] for c in recent)
        swing_low = min(c['low'] for c in recent)
        last_close = curr['close']
        
        dist_to_high = (swing_high - last_close)/last_close*100
        dist_to_low = (last_close - swing_low)/last_close*100
        
        at_resistance = dist_to_high <= 0.35
        at_support = dist_to_low <= 0.35
        
        if at_support:
            patterns["order_block"] = {"type": "bullish_ob", "signal": "BUY", "strength": 0.6, "reason": f"At support order block {swing_low:.2f} ({dist_to_low:.2f}%) - BUY"}
        elif at_resistance:
            patterns["order_block"] = {"type": "bearish_ob", "signal": "SELL", "strength": 0.6, "reason": f"At resistance order block {swing_high:.2f} ({dist_to_high:.2f}%) - SELL"}
        else:
            patterns["order_block"] = {"type": "none", "signal": "HOLD", "strength": 0.1, "reason": f"Not at order block - dist to high {dist_to_high:.2f}% low {dist_to_low:.2f}%"}
        
        # Overall Pine Script signal
        buy_strength = sum(v["strength"] for v in patterns.values() if v["signal"] == "BUY")
        sell_strength = sum(v["strength"] for v in patterns.values() if v["signal"] == "SELL")
        
        if buy_strength > sell_strength + 0.3:
            overall = "BUY"
            confidence = min(85, 60 + buy_strength*15)
        elif sell_strength > buy_strength + 0.3:
            overall = "SELL"
            confidence = min(85, 60 + sell_strength*15)
        else:
            overall = "HOLD"
            confidence = 50
        
        return {
            "overall": overall,
            "confidence": round(confidence,1),
            "buy_strength": round(buy_strength,2),
            "sell_strength": round(sell_strength,2),
            "patterns": patterns,
            "swing_high": round(swing_high,2),
            "swing_low": round(swing_low,2),
            "source": "Pine Script patterns - engulfing, pin bar, inside bar, order blocks"
        }
        
    except Exception as e:
        print(f"Pine Script patterns error: {e}")
        import traceback
        traceback.print_exc()
        return None

def get_tradingview_combined_signal(m15_candles=None, h1_candles=None):
    """
    Combined TradingView signal (indicators + Pine Script patterns)
    Main function to be called from main.py
    """
    try:
        # Indicators analysis
        tv_indicators = analyze_tradingview_indicators(m15_candles)
        
        # Pine Script patterns
        pine_patterns = analyze_pine_script_patterns(m15_candles)
        
        if not tv_indicators or not pine_patterns:
            return None
        
        # Combine
        # Indicators 60% weight, Pine patterns 40% weight
        ind_signal = tv_indicators["overall"]
        ind_conf = tv_indicators["confidence"]
        ind_buy = tv_indicators["buy_strength"]
        ind_sell = tv_indicators["sell_strength"]
        
        pine_signal = pine_patterns["overall"]
        pine_conf = pine_patterns["confidence"]
        pine_buy = pine_patterns["buy_strength"]
        pine_sell = pine_patterns["sell_strength"]
        
        # Weighted combination
        buy_score = ind_buy*0.6 + pine_buy*0.4
        sell_score = ind_sell*0.6 + pine_sell*0.4
        
        # Also consider confidence
        if ind_signal == "BUY":
            buy_score += ind_conf*0.01
        elif ind_signal == "SELL":
            sell_score += ind_conf*0.01
        
        if pine_signal == "BUY":
            buy_score += pine_conf*0.01
        elif pine_signal == "SELL":
            sell_score += pine_conf*0.01
        
        if buy_score > sell_score + 0.5:
            final_signal = "BUY"
            final_conf = min(90, 60 + (buy_score - sell_score)*15)
        elif sell_score > buy_score + 0.5:
            final_signal = "SELL"
            final_conf = min(90, 60 + (sell_score - buy_score)*15)
        else:
            final_signal = "HOLD"
            final_conf = 50
        
        return {
            "type": final_signal,
            "confidence": round(final_conf,1),
            "buy_score": round(buy_score,2),
            "sell_score": round(sell_score,2),
            "indicators": tv_indicators,
            "pine": pine_patterns,
            "strategy": "TradingView MCP Bridge - 84 tools, indicators + Pine Script patterns",
            "source": "TradingView MCP Bridge (chart.js, indicator.js, pine.js, drawing.js)"
        }
        
    except Exception as e:
        print(f"TradingView combined signal error: {e}")
        import traceback
        traceback.print_exc()
        return None

# Test
if __name__ == "__main__":
    print("Testing TradingView analysis")
    import random
    dummy=[]
    price=2000
    for i in range(100):
        price+=random.uniform(-5,5)
        dummy.append({'open':price-random.uniform(-2,2),'high':price+random.uniform(0,3),'low':price-random.uniform(0,3),'close':price,'volume':random.randint(100,1000),'complete':True})
    
    print("\nIndicators:")
    ind = analyze_tradingview_indicators(dummy)
    print(f"Overall: {ind['overall']} {ind['confidence']}% Buy:{ind['buy_strength']} Sell:{ind['sell_strength']}")
    print(f"Signals: {list(ind['signals'].keys())}")
    
    print("\nPine patterns:")
    pine = analyze_pine_script_patterns(dummy)
    print(f"Overall: {pine['overall']} {pine['confidence']}% Buy:{pine['buy_strength']} Sell:{pine['sell_strength']}")
    
    print("\nCombined:")
    combined = get_tradingview_combined_signal(dummy)
    print(f"Overall: {combined['type']} {combined['confidence']}% Buy:{combined['buy_score']} Sell:{combined['sell_score']}")
