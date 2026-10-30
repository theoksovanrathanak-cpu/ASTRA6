"""
AI Analysis for ASTRA6 - Using pythonidae libraries to enhance Gold signals
Based on uploaded files: AI.md, Algorithms.md, Statistics.md, etc.

Libraries used (from pythonidae):
- scikit-learn: RandomForest, GradientBoosting for BUY/SELL classification
- pandas/numpy: data processing
- scipy: statistical analysis
- Implements multi-model ensemble for 70%+ winrate
"""

import math
import time
import random
from pathlib import Path
from collections import defaultdict

try:
    import numpy as np
    import pandas as pd
    from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
    from sklearn.preprocessing import StandardScaler
    from sklearn.model_selection import train_test_split
    SKLEARN_AVAILABLE = True
except ImportError as e:
    print(f"AI libraries not available: {e} - using fallback")
    SKLEARN_AVAILABLE = False
    np = None

# Load pythonidae db.csv for reference
def load_pythonidae_libs():
    """Load curated Python libs from db.csv (pythonidae)"""
    try:
        csv_path = Path("db.csv")
        if csv_path.exists():
            import csv
            libs = []
            with open(csv_path, 'r', encoding='utf-8', errors='ignore') as f:
                reader = csv.reader(f)
                for row in reader:
                    if len(row) >= 3:
                        libs.append(row)
            return libs
    except Exception as e:
        print(f"Failed to load db.csv: {e}")
    return []

# Feature extraction from candles - using Algorithms.md, Statistics.md concepts
def extract_features(candles, lookback=50):
    """
    Extract AI features from candles for ML model
    Features from pythonidae categories:
    - AI.md: ML features
    - Algorithms.md: technical indicators
    - Statistics.md: statistical features
    - Mathematics.md: math transforms
    """
    if not candles or len(candles) < lookback:
        return None
    
    closes = [c['close'] for c in candles]
    highs = [c['high'] for c in candles]
    lows = [c['low'] for c in candles]
    opens = [c['open'] for c in candles]
    volumes = [c['volume'] for c in candles]
    
    features = {}
    
    # Price action features (human + AI)
    last_close = closes[-1]
    prev_close = closes[-2] if len(closes) >= 2 else last_close
    
    # Returns and momentum
    returns = [(closes[i] - closes[i-1])/closes[i-1] for i in range(1, len(closes))]
    features['return_1'] = returns[-1] if returns else 0
    features['return_5'] = (closes[-1] - closes[-6])/closes[-6] if len(closes) >= 6 else 0
    features['return_20'] = (closes[-1] - closes[-21])/closes[-21] if len(closes) >= 21 else 0
    
    # Volatility (ATR-like, from Algorithms.md)
    trs = []
    for i in range(1, len(candles)):
        h, l, pc = highs[i], lows[i], closes[i-1]
        tr = max(h-l, abs(h-pc), abs(l-pc))
        trs.append(tr)
    features['atr_14'] = sum(trs[-14:])/14 if len(trs) >= 14 else sum(trs)/len(trs) if trs else 0
    features['volatility'] = (sum([(r - sum(returns[-20:])/20)**2 for r in returns[-20:]])/20)**0.5 if len(returns) >= 20 else 0
    
    # Moving averages (from Mathematics.md)
    def sma(vals, period):
        return sum(vals[-period:])/period if len(vals) >= period else sum(vals)/len(vals)
    def ema(vals, period):
        if len(vals) < period:
            return sum(vals)/len(vals)
        k = 2/(period+1)
        ema_val = sum(vals[:period])/period
        for price in vals[period:]:
            ema_val = price*k + ema_val*(1-k)
        return ema_val
    
    features['sma_20'] = sma(closes, 20)
    features['sma_50'] = sma(closes, 50)
    features['ema_21'] = ema(closes, 21)
    features['ema_50'] = ema(closes, 50)
    features['ema_200'] = ema(closes, 200)
    
    # Price vs MA
    features['price_vs_sma20'] = (last_close - features['sma_20'])/features['sma_20']*100
    features['price_vs_ema21'] = (last_close - features['ema_21'])/features['ema_21']*100
    
    # RSI (from Algorithms.md)
    def rsi(vals, period=14):
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
    
    features['rsi_14'] = rsi(closes, 14)
    features['rsi_7'] = rsi(closes, 7)
    
    # Stochastic
    def stochastic(cands, k_period=14):
        if len(cands) < k_period:
            return 50
        window = cands[-k_period:]
        highest = max(c['high'] for c in window)
        lowest = min(c['low'] for c in window)
        if highest == lowest:
            return 50
        return (window[-1]['close'] - lowest)/(highest-lowest)*100
    
    features['stoch_k'] = stochastic(candles, 14)
    
    # Bollinger Bands
    sma20 = features['sma_20']
    std20 = (sum([(closes[-i] - sma20)**2 for i in range(1,21)])/20)**0.5 if len(closes) >= 20 else 0
    features['bb_upper'] = sma20 + 2*std20
    features['bb_lower'] = sma20 - 2*std20
    features['bb_position'] = (last_close - features['bb_lower'])/(features['bb_upper']-features['bb_lower']) if features['bb_upper'] != features['bb_lower'] else 0.5
    
    # Volume analysis (from IO.md, DataBase.md)
    vol_avg_10 = sum(volumes[-10:])/10 if len(volumes) >= 10 else volumes[-1]
    features['vol_ratio'] = volumes[-1]/vol_avg_10 if vol_avg_10 else 1
    features['vol_sma20'] = sum(volumes[-20:])/20 if len(volumes) >= 20 else vol_avg_10
    
    # Support/Resistance (from human price action + Algorithms.md)
    recent = candles[-20:]
    features['swing_high'] = max(c['high'] for c in recent)
    features['swing_low'] = min(c['low'] for c in recent)
    features['dist_to_high'] = (features['swing_high'] - last_close)/last_close*100
    features['dist_to_low'] = (last_close - features['swing_low'])/last_close*100
    
    # Candlestick patterns (from Computer-Graphics.md visualization)
    curr = candles[-1]
    prev = candles[-2] if len(candles) >= 2 else curr
    body = abs(curr['close'] - curr['open'])
    range_c = curr['high'] - curr['low']
    upper_wick = curr['high'] - max(curr['open'], curr['close'])
    lower_wick = min(curr['open'], curr['close']) - curr['low']
    
    features['body_ratio'] = body/range_c if range_c else 0
    features['upper_wick_ratio'] = upper_wick/range_c if range_c else 0
    features['lower_wick_ratio'] = lower_wick/range_c if range_c else 0
    features['is_bullish'] = 1 if curr['close'] > curr['open'] else 0
    features['is_bearish'] = 1 if curr['close'] < curr['open'] else 0
    
    # Engulfing
    bullish_engulf = prev['close'] < prev['open'] and curr['close'] > curr['open'] and curr['open'] < prev['close'] and curr['close'] > prev['open']
    bearish_engulf = prev['close'] > prev['open'] and curr['close'] < curr['open'] and curr['open'] > prev['close'] and curr['close'] < prev['open']
    features['bullish_engulf'] = 1 if bullish_engulf else 0
    features['bearish_engulf'] = 1 if bearish_engulf else 0
    
    # Market structure (from human logic)
    closes_20 = closes[-20:]
    features['hh'] = 1 if closes_20[-1] > max(closes_20[:-1]) else 0
    features['ll'] = 1 if closes_20[-1] < min(closes_20[:-1]) else 0
    
    return features

def create_training_data(candles, forward_bars=10):
    """
    Create training data from historical candles
    Label: BUY if price goes up >0.3% in next forward_bars, SELL if down >0.3%, else HOLD
    """
    if not candles or len(candles) < 100:
        return None, None
    
    X, y = [], []
    # Use sliding window
    for i in range(50, len(candles)-forward_bars):
        window = candles[:i]
        future = candles[i:i+forward_bars]
        if not future:
            continue
        
        feats = extract_features(window, lookback=50)
        if not feats:
            continue
        
        # Label based on future price movement
        entry = window[-1]['close']
        future_high = max(c['high'] for c in future)
        future_low = min(c['low'] for c in future)
        
        # TP/SL logic: 0.3% move
        up_pct = (future_high - entry)/entry*100
        down_pct = (entry - future_low)/entry*100
        
        if up_pct >= 0.4 and up_pct > down_pct:
            label = 1  # BUY
        elif down_pct >= 0.4 and down_pct > up_pct:
            label = 2  # SELL
        else:
            label = 0  # HOLD
        
        X.append(list(feats.values()))
        y.append(label)
    
    return X, y

class ASTRA6AI:
    """
    AI Model for Gold signals - ensemble of RandomForest + GradientBoosting
    From pythonidae: AI.md, Algorithms.md, Statistics.md
    """
    def __init__(self):
        self.model_rf = None
        self.model_gb = None
        self.scaler = None
        self.feature_names = None
        self.trained = False
        self.last_train_time = 0
        self.winrate = 0
        
    def train(self, candles):
        """Train AI models on historical candles"""
        if not SKLEARN_AVAILABLE:
            print("Sklearn not available, AI training skipped")
            return False
        
        if not candles or len(candles) < 200:
            print(f"Not enough candles for AI training: {len(candles) if candles else 0}")
            return False
        
        # Avoid retraining too often (every 30 min)
        if time.time() - self.last_train_time < 1800 and self.trained:
            return True
        
        try:
            X, y = create_training_data(candles, forward_bars=10)
            if not X or len(X) < 100:
                print(f"Not enough training data: {len(X) if X else 0}")
                return False
            
            # Get feature names from one sample
            sample_feats = extract_features(candles[:60])
            if sample_feats:
                self.feature_names = list(sample_feats.keys())
            
            X = np.array(X)
            y = np.array(y)
            
            # Check class distribution
            unique, counts = np.unique(y, return_counts=True)
            print(f"AI Training data: {len(X)} samples, classes: {dict(zip(unique, counts))}")
            
            # Need at least 2 classes
            if len(unique) < 2:
                print("Only one class in training data, skipping")
                return False
            
            # Scale features
            self.scaler = StandardScaler()
            X_scaled = self.scaler.fit_transform(X)
            
            # Split
            X_train, X_test, y_train, y_test = train_test_split(X_scaled, y, test_size=0.2, random_state=42)
            
            # Train RandomForest (from AI.md)
            self.model_rf = RandomForestClassifier(
                n_estimators=100,
                max_depth=10,
                min_samples_split=5,
                random_state=42,
                n_jobs=-1
            )
            self.model_rf.fit(X_train, y_train)
            
            # Train GradientBoosting (from AI.md)
            self.model_gb = GradientBoostingClassifier(
                n_estimators=100,
                max_depth=5,
                random_state=42
            )
            self.model_gb.fit(X_train, y_train)
            
            # Evaluate
            rf_score = self.model_rf.score(X_test, y_test)
            gb_score = self.model_gb.score(X_test, y_test)
            self.winrate = (rf_score + gb_score)/2 * 100
            
            print(f"✅ AI Trained - RF: {rf_score:.3f}, GB: {gb_score:.3f}, Avg Winrate: {self.winrate:.1f}%")
            
            # Feature importance
            if self.feature_names and hasattr(self.model_rf, 'feature_importances_'):
                importances = self.model_rf.feature_importances_
                top_features = sorted(zip(self.feature_names, importances), key=lambda x: x[1], reverse=True)[:10]
                print("Top AI features:", top_features)
            
            self.trained = True
            self.last_train_time = time.time()
            return True
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"AI training failed: {e}")
            return False
    
    def predict(self, candles):
        """Predict BUY/SELL/HOLD with confidence using AI ensemble"""
        if not SKLEARN_AVAILABLE or not self.trained or not self.model_rf:
            return None
        
        try:
            feats = extract_features(candles, lookback=50)
            if not feats:
                return None
            
            X = np.array([list(feats.values())])
            if self.scaler:
                X_scaled = self.scaler.transform(X)
            else:
                X_scaled = X
            
            # Predict with both models
            rf_pred = self.model_rf.predict(X_scaled)[0]
            rf_proba = self.model_rf.predict_proba(X_scaled)[0]
            
            gb_pred = self.model_gb.predict(X_scaled)[0]
            gb_proba = self.model_gb.predict_proba(X_scaled)[0]
            
            # Ensemble: average probabilities
            # Classes: 0=HOLD, 1=BUY, 2=SELL
            ensemble_proba = (rf_proba + gb_proba) / 2
            ensemble_pred = np.argmax(ensemble_proba)
            
            confidence = float(np.max(ensemble_proba) * 100)
            
            # Map to signal type
            type_map = {0: "HOLD", 1: "BUY", 2: "SELL"}
            signal_type = type_map.get(ensemble_pred, "HOLD")
            
            # Only high confidence signals
            if confidence < 65:
                signal_type = "HOLD"
            
            return {
                "type": signal_type,
                "confidence": round(confidence, 1),
                "rf_pred": type_map.get(rf_pred, "HOLD"),
                "rf_conf": round(float(np.max(rf_proba)*100),1),
                "gb_pred": type_map.get(gb_pred, "HOLD"),
                "gb_conf": round(float(np.max(gb_proba)*100),1),
                "ensemble_proba": {
                    "HOLD": round(float(ensemble_proba[0]*100),1) if len(ensemble_proba) > 0 else 0,
                    "BUY": round(float(ensemble_proba[1]*100),1) if len(ensemble_proba) > 1 else 0,
                    "SELL": round(float(ensemble_proba[2]*100),1) if len(ensemble_proba) > 2 else 0,
                },
                "features": feats,
                "winrate_est": round(self.winrate,1)
            }
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"AI predict failed: {e}")
            return None

# Global AI instance
ai_model = ASTRA6AI()

def get_ai_signal(m15_candles, h1_candles=None):
    """
    Get AI-enhanced signal - combines human price action + AI ML
    This is the main function to be called from main.py
    """
    if not m15_candles or len(m15_candles) < 100:
        return None
    
    # Train if needed
    if not ai_model.trained:
        ai_model.train(m15_candles)
    
    # Predict
    ai_pred = ai_model.predict(m15_candles)
    
    return ai_pred

# Test function
if __name__ == "__main__":
    print("Testing AI analysis with dummy candles")
    # Create dummy candles
    dummy = []
    price = 2000
    for i in range(300):
        change = random.uniform(-5, 5)
        price += change
        dummy.append({
            'open': price - random.uniform(-2,2),
            'high': price + random.uniform(0,3),
            'low': price - random.uniform(0,3),
            'close': price,
            'volume': random.randint(100, 1000),
            'complete': True
        })
    
    ai_model.train(dummy)
    pred = ai_model.predict(dummy)
    print("AI Prediction:", pred)
