'use strict';

/**
 * Deriv EMA Indicator — Node.js (server-side)
 * Requires: ws  →  npm install ws
 * Usage:    node indicators.js
 */

const WebSocket = require('ws');

// ─── Telegram configuration ───────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = '8809509406:AAEOH2jrzNJNkrDPSh0EvN5pAO9qdMuJpB8';
const TELEGRAM_CHAT_ID   = '6456659526';

// ─── Deriv WebSocket ──────────────────────────────────────────────────────────
// NOTE: This is the public endpoint for Deriv's Options Trading API, not the
// classic API this script's ticks_history/candles/ticks messages target.
// If candles/ticks stop coming through, that's likely why.
const API_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
let ws;

// ─── Indicator Configuration ──────────────────────────────────────────────────
const EMA_PERIODS        = [20];   // Single EMA, used for both the touch alert and the pullback-streak alert
const TOUCH_ALERT_EMA    = 10;      // EMA used to detect a "touch" and fire the touch alert
const COOLDOWN_CANDLES   = 2;        // Closed candles to wait before re-alerting for touches

// Emoji mapping to identify the EMA period
const EMA_EMOJIS = {
  10: '🔟'
};

// ─── EMA-pullback candle-streak configuration ─────────────────────────────────
const PULLBACK_EMA_PERIOD  = 10;  // EMA used to gauge trend side for the pullback alert
const PULLBACK_STREAK_LEN  = 2;    // Consecutive pullback candles required to fire
const PULLBACK_EMOJIS = {
  redPullback:   '🔴',   // uptrend (price above EMA10): red candles that still close at/above it
  greenPullback: '🟢'    // downtrend (price below EMA10): green candles that still close at/below it
};

// ─── Supertrend configuration ─────────────────────────────────────────────────
const SUPERTREND_ATR_PERIOD = 1;   // ATR length (Wilder smoothing)
const SUPERTREND_FACTOR     = 1;    // ATR multiplier for the bands
const SUPERTREND_EMOJIS = {
  bullish: '📈',   // flipped from bearish to bullish
  bearish: '📉'    // flipped from bullish to bearish
};

// ─── Symbols & timeframes ─────────────────────────────────────────────────────
const SYMBOLS    = [ 'R_10', /*'R_25'*/];
const TIMEFRAMES = ['30min'];

const timeframeMap = { '15min': 900 }; // 15 mins = 900 seconds

const displayNames = {
  'R_10':    'Volatility 10 Index',
  'R_25':    'Volatility 25 Index',
  '15min':   '15 minutes'
};

const MAX_HISTORICAL_CANDLES = 5000;

// ─── State ───────────────────────────────────────────────────────────────────
const historicalData        = {};
const currentCandles        = {};
const emaNotificationState  = {};
const emaState               = {};
const streakState           = {};
const supertrendState       = {};  // per symbol/timeframe: { atr, prevClose, upper, lower, trend }

function initState() {
  SYMBOLS.forEach(sym => {
    historicalData[sym]        = {};
    currentCandles[sym]        = {};
    emaNotificationState[sym]  = {};
    emaState[sym]               = {};
    streakState[sym]           = {};
    supertrendState[sym]       = {};

    TIMEFRAMES.forEach(tf => {
      historicalData[sym][tf]        = [];
      currentCandles[sym][tf]        = null;
      emaNotificationState[sym][tf]  = {};
      streakState[sym][tf]           = { type: null, count: 0, alertSent: false };
      supertrendState[sym][tf]       = null;

      EMA_PERIODS.forEach(period => {
        emaNotificationState[sym][tf][period] = { 
          lastAlertTimestamp: null, 
          notifSent: false
        };
      });
    });

    EMA_PERIODS.forEach(period => {
      emaState[sym][period] = null;
    });
  });
}

initState();

// ─── Telegram ────────────────────────────────────────────────────────────────
async function sendTelegramNotification(message, dedupKey) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const url  = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown' });

  try {
    const res  = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const data = await res.json();
    if (!data.ok) console.error('[Telegram] API error:', data);
    else          console.log(`[Telegram] Sent ✓ (${dedupKey})`);
  } catch (err) {
    console.error('[Telegram] Send failed:', err.message);
  }
}

// ─── EMA helpers ───────────────────────────────────────────────────────────────
// Exponential Moving Average: multiplier k = 2 / (period + 1), seeded with the
// simple average of the first `period` closes, then EMA = EMA + k × (close - EMA).
function initEMA(symbol, closedCandles, period) {
  const data = closedCandles
    .filter(c => isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  const closes = data.map(c => c.close);

  if (closes.length < period) {
    emaState[symbol][period] = null;
    return;
  }

  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < closes.length; i++) ema = ema + k * (closes[i] - ema);

  emaState[symbol][period] = ema;
}

function advanceEMA(symbol, period, closedClose) {
  if (emaState[symbol][period] === null) return;

  const k = 2 / (period + 1);
  emaState[symbol][period] = emaState[symbol][period] + k * (closedClose - emaState[symbol][period]);
}

function getEMA(symbol, period) {
  return emaState[symbol][period];
}

// ─── EMA touch and timeout detection ─────────────────────────────────────────
function checkEMATouches(symbol, timeframe, closedCandle) {
  const symbolName  = displayNames[symbol] || symbol;
  const granularity = timeframeMap[timeframe];
  const currentTimestamp = closedCandle.timestamp;

  EMA_PERIODS.forEach(period => {
    const ema = getEMA(symbol, period); 
    if (ema === null) return;

    // Touch condition: The EMA value lies anywhere between or exactly on the Candle's High and Low
    const touched = closedCandle.low <= ema && closedCandle.high >= ema;

    const dedupKey  = `${symbol}:${timeframe}:${period}`;
    const state     = emaNotificationState[symbol][timeframe][period];
    const emaEmoji  = EMA_EMOJIS[period] || period;

    // Process EMA Touch — only for the designated touch-alert EMA
    if (period === TOUCH_ALERT_EMA && touched) {
      // Evaluate Cooldown for Touch Alert
      const candlesPassed = state.lastAlertTimestamp === null 
        ? Infinity 
        : (currentTimestamp - state.lastAlertTimestamp) / granularity;

      const candlesClear = candlesPassed >= COOLDOWN_CANDLES;

      if (state.notifSent && candlesClear) {
        state.notifSent = false;
        console.log(`[Lock] Released ${dedupKey}`);
      }

      if (!state.notifSent) {
        state.lastAlertTimestamp = currentTimestamp;
        state.notifSent          = true;

        const message = `${emaEmoji} ${symbolName}`;
        console.log(`\n${message}`);
        sendTelegramNotification(message, dedupKey);
      }
    }
  });
}

// ─── Candle color + EMA(10) pullback streak detection ─────────────────────────
function classifyCandleColor(symbol, timeframe, closedCandle) {
  if (closedCandle.close > closedCandle.open) return 'bullish';
  if (closedCandle.close < closedCandle.open) return 'bearish';

  // Doji (close === open): borrow a color by comparing to the previous candle's close
  const hist = historicalData[symbol][timeframe];
  const prevCandle = hist.length >= 2 ? hist[hist.length - 2] : null;
  if (!prevCandle) return null;

  if (closedCandle.close > prevCandle.close) return 'bullish';
  if (closedCandle.close < prevCandle.close) return 'bearish';
  return null; // tied with the previous close too — no color
}

function classifyPullbackType(symbol, timeframe, closedCandle) {
  const color = classifyCandleColor(symbol, timeframe, closedCandle);
  const ema   = getEMA(symbol, PULLBACK_EMA_PERIOD);
  if (color === null || ema === null) return null;

  // Uptrend pullback: a red candle that still closes at/above the EMA(10)
  if (color === 'bearish' && closedCandle.close >= ema) return 'redPullback';

  // Downtrend pullback (vice versa): a green candle that still closes at/below the EMA(10)
  if (color === 'bullish' && closedCandle.close <= ema) return 'greenPullback';

  return null;
}

function checkEmaPullbackStreak(symbol, timeframe, closedCandle) {
  const symbolName = displayNames[symbol] || symbol;
  const type        = classifyPullbackType(symbol, timeframe, closedCandle);
  const state        = streakState[symbol][timeframe];

  if (type && type === state.type) {
    state.count += 1;
  } else {
    // Streak broke (pattern changed, or candle doesn't qualify) — start over and
    // unlock the alert so a fresh streak of PULLBACK_STREAK_LEN can fire again.
    state.type       = type;
    state.count      = type ? 1 : 0;
    state.alertSent  = false;
  }

  if (state.count === PULLBACK_STREAK_LEN && !state.alertSent) {
    state.alertSent = true;

    const dedupKey = `${symbol}:${timeframe}:pullback`;
    const emoji    = PULLBACK_EMOJIS[type].repeat(PULLBACK_STREAK_LEN);
    const message  = `${emoji} ${symbolName}`;
    console.log(`\n${message}`);
    sendTelegramNotification(message, dedupKey);
  }
}

// ─── Supertrend helpers ───────────────────────────────────────────────────────
// Raw bands are centred on the open/close midpoint:
//   upperBand = (open + close) / 2 + factor × ATR
//   lowerBand = (open + close) / 2 - factor × ATR
// The final bands ratchet with the trend, and the trend flips when the close
// breaks through the active band. trend: 1 = bullish (line = lower band),
// -1 = bearish (line = upper band).
function trueRange(candle, prevClose) {
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - prevClose),
    Math.abs(candle.low  - prevClose)
  );
}

function stepSupertrend(st, candle) {
  const tr  = trueRange(candle, st.prevClose);
  const atr = (st.atr * (SUPERTREND_ATR_PERIOD - 1) + tr) / SUPERTREND_ATR_PERIOD;

  const mid      = (candle.open + candle.close) / 2;
  const rawUpper = mid + SUPERTREND_FACTOR * atr;
  const rawLower = mid - SUPERTREND_FACTOR * atr;

  // Ratchet: upper band only falls (unless price broke above it), lower band only rises
  const upper = (rawUpper < st.upper || st.prevClose > st.upper) ? rawUpper : st.upper;
  const lower = (rawLower > st.lower || st.prevClose < st.lower) ? rawLower : st.lower;

  let trend = st.trend;
  if (trend === -1 && candle.close > upper) trend = 1;
  else if (trend === 1 && candle.close < lower) trend = -1;

  st.atr       = atr;
  st.prevClose = candle.close;
  st.upper     = upper;
  st.lower     = lower;
  st.trend     = trend;
}

function initSupertrend(symbol, timeframe, closedCandles) {
  const data = closedCandles
    .filter(c => isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (data.length <= SUPERTREND_ATR_PERIOD) {
    supertrendState[symbol][timeframe] = null;
    return;
  }

  // Seed ATR with the simple average of the first N true ranges, then walk
  // forward silently (no alerts) so the state matches the live candles.
  let trSum = 0;
  for (let i = 1; i <= SUPERTREND_ATR_PERIOD; i++) trSum += trueRange(data[i], data[i - 1].close);

  const seed = data[SUPERTREND_ATR_PERIOD];
  const atr  = trSum / SUPERTREND_ATR_PERIOD;
  const st   = {
    atr,
    prevClose: seed.close,
    upper:     (seed.open + seed.close) / 2 + SUPERTREND_FACTOR * atr,
    lower:     (seed.open + seed.close) / 2 - SUPERTREND_FACTOR * atr,
    trend:     1
  };

  for (let i = SUPERTREND_ATR_PERIOD + 1; i < data.length; i++) stepSupertrend(st, data[i]);

  supertrendState[symbol][timeframe] = st;
}

function checkSupertrendFlip(symbol, timeframe, closedCandle) {
  const st = supertrendState[symbol][timeframe];
  if (st === null) return;

  const prevTrend = st.trend;
  stepSupertrend(st, closedCandle);
  if (st.trend === prevTrend) return;

  const symbolName = displayNames[symbol] || symbol;
  const direction  = st.trend === 1 ? 'bullish' : 'bearish';
  const dedupKey   = `${symbol}:${timeframe}:supertrend`;
  const message    = `${SUPERTREND_EMOJIS[direction]} ${symbolName} Supertrend flipped ${direction.toUpperCase()} @ ${closedCandle.close.toFixed(4)}`;
  console.log(`\n${message}`);
  sendTelegramNotification(message, dedupKey);
}

// ─── Candle management ───────────────────────────────────────────────────────
function getCandleTimeframe(timestamp, granularity) {
  return Math.floor(timestamp / granularity) * granularity;
}

function updateCurrentCandle(symbol, price, timestamp) {
  Object.keys(timeframeMap).forEach(timeframe => {
    const granularity = timeframeMap[timeframe];
    const candleTime  = getCandleTimeframe(timestamp, granularity);

    if (!currentCandles[symbol][timeframe] ||
        currentCandles[symbol][timeframe].timestamp !== candleTime) {

      if (currentCandles[symbol][timeframe]) {
        const closedCandle = currentCandles[symbol][timeframe];
        historicalData[symbol][timeframe].push(closedCandle);
        if (historicalData[symbol][timeframe].length > MAX_HISTORICAL_CANDLES)
          historicalData[symbol][timeframe].shift();

        const closedClose = closedCandle.close;

        // Check for EMA touches using the fully formed closed candle
        checkEMATouches(symbol, timeframe, closedCandle);

        // Check for EMA(10) pullback candle streaks using the fully formed closed candle
        checkEmaPullbackStreak(symbol, timeframe, closedCandle);

        // Check for a Supertrend flip using the fully formed closed candle
        checkSupertrendFlip(symbol, timeframe, closedCandle);

        EMA_PERIODS.forEach(period => {
          advanceEMA(symbol, period, closedClose);
        });
        console.log(`\n[${symbol}/${timeframe}] Candle closed @ ${closedClose}`);
      }

      currentCandles[symbol][timeframe] = {
        timestamp: candleTime, open: price, high: price, low: price, close: price
      };
    } else {
      const c = currentCandles[symbol][timeframe];
      c.high  = Math.max(c.high, price);
      c.low   = Math.min(c.low,  price);
      c.close = price;
    }
  });
}

// ─── Indicator recalculation ─────────────────────────────────────────────────
function recalculateIndicators(symbol, timeframe, livePrice) {
  if (!historicalData[symbol][timeframe].length || !currentCandles[symbol][timeframe]) return;

  let emaString = '';
  EMA_PERIODS.forEach(period => {
    const emaVal = getEMA(symbol, period);
    emaString += `EMA${period}:${emaVal !== null ? emaVal.toFixed(4) : 'N/A'} `;
  });

  process.stdout.write(
    `\r[${symbol}] Price:${livePrice.toFixed(4)} ${emaString}  `
  );
}

// ─── Historical candle processing ────────────────────────────────────────────
function processCandles(symbol, timeframe, candles) {
  const data = candles
    .map(c => ({ open: parseFloat(c.open), high: parseFloat(c.high),
                 low: parseFloat(c.low), close: parseFloat(c.close), timestamp: c.epoch }))
    .filter(c => isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (!data.length) return;

  historicalData[symbol][timeframe] = data.slice(0, -1);

  const lastCandle = data[data.length - 1];
  currentCandles[symbol][timeframe] = {
    timestamp: lastCandle.timestamp,
    open: lastCandle.open, high: lastCandle.high,
    low: lastCandle.low,   close: lastCandle.close
  };

  EMA_PERIODS.forEach(period => {
    initEMA(symbol, historicalData[symbol][timeframe], period);
  });

  initSupertrend(symbol, timeframe, historicalData[symbol][timeframe]);

  const emaLogDetails = EMA_PERIODS.map(p => `EMA${p}:${emaState[symbol][p]?.toFixed(4) ?? 'N/A'}`).join(' | ');
  console.log(
    `[${symbol}/${timeframe}] Loaded ${data.length} candles | ${emaLogDetails}`
  );

  const st = supertrendState[symbol][timeframe];
  if (st) {
    console.log(
      `[${symbol}/${timeframe}] Supertrend: ${st.trend === 1 ? 'BULLISH' : 'BEARISH'} | line:${(st.trend === 1 ? st.lower : st.upper).toFixed(4)}`
    );
  }
}

// ─── WebSocket ───────────────────────────────────────────────────────────────
function sendMessage(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function requestCandles(symbol, timeframe) {
  sendMessage({
    ticks_history: symbol, adjust_start_time: 1,
    count: MAX_HISTORICAL_CANDLES, end: 'latest',
    style: 'candles', granularity: timeframeMap[timeframe]
  });
}

// ─── WebSocket initialization & event handling ───────────────────────────────
function subscribeToTicks(symbol) {
  sendMessage({ ticks: symbol, subscribe: 1 });
}

const lastTickEpoch = {};

function handleMessage(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return; }

  if (data.error) { console.error('[WS] Error:', data.error.message); return; }

  if (data.candles) {
    const symbol    = data.echo_req.ticks_history;
    const tf        = Object.keys(timeframeMap).find(k => timeframeMap[k] === data.echo_req.granularity);
    if (tf) processCandles(symbol, tf, data.candles);
  }

  if (data.tick) {
    const { symbol, quote, epoch } = data.tick;
    const price = parseFloat(quote);

    if (lastTickEpoch[symbol] === epoch) return;
    lastTickEpoch[symbol] = epoch;

    updateCurrentCandle(symbol, price, epoch);
    Object.keys(timeframeMap).forEach(tf => recalculateIndicators(symbol, tf, price));
  }
}

function initializeWebSocket() {
  console.log('[WS] Connecting…');
  ws = new WebSocket(API_URL);

  ws.on('open', () => {
    console.log('[WS] Connected');
    SYMBOLS.forEach(sym => {
      TIMEFRAMES.forEach(tf => requestCandles(sym, tf));
      subscribeToTicks(sym);
    });
  });

  ws.on('message', handleMessage);

  ws.on('close', () => {
    console.log('\n[WS] Disconnected — reconnecting in 5s…');
    setTimeout(initializeWebSocket, 5_000);
  });

  ws.on('error', err => console.error('[WS] Error:', err.message));
}

process.on('SIGINT',  () => { ws?.close(); process.exit(0); });
process.on('SIGTERM', () => { ws?.close(); process.exit(0); });

initializeWebSocket();
