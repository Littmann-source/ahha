'use strict';

/**
 * Deriv KAMA Indicator — Node.js (server-side)
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
const KAMA_PERIODS       = [8];    // Single KAMA now, used for both the touch alert and the pullback-streak alert
const TOUCH_ALERT_KAMA   = 8;       // KAMA used to detect a "touch" and fire the touch alert
const COOLDOWN_CANDLES   = 2;        // Closed candles to wait before re-alerting for touches

// Kaufman's Adaptive Moving Average smoothing constants (standard defaults)
const KAMA_FAST_PERIOD   = 2;        // Fastest EMA constant used inside KAMA's smoothing
const KAMA_SLOW_PERIOD   = 30;       // Slowest EMA constant used inside KAMA's smoothing

// Emoji mapping to identify the KAMA period
const KAMA_EMOJIS = {
  8: '8️⃣'
};

// ─── KAMA-pullback candle-streak configuration ─────────────────────────────────
const PULLBACK_KAMA_PERIOD = 8;   // KAMA used to gauge trend side for the pullback alert
const PULLBACK_STREAK_LEN  = 2;    // Consecutive pullback candles required to fire
const PULLBACK_EMOJIS = {
  redPullback:   '🔴',   // uptrend (price above KAMA8): red candles that still close at/above it
  greenPullback: '🟢'    // downtrend (price below KAMA8): green candles that still close at/below it
};

// ─── Symbols & timeframes ─────────────────────────────────────────────────────
const SYMBOLS    = ['R_10', /*'R_25'*/];
const TIMEFRAMES = ['15min'];

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
const kamaNotificationState = {};
const kamaState              = {};
const kamaCloseWindow        = {};  // rolling window of last (period+1) closes, per symbol/period
const streakState           = {};

function initState() {
  SYMBOLS.forEach(sym => {
    historicalData[sym]        = {};
    currentCandles[sym]        = {};
    kamaNotificationState[sym] = {};
    kamaState[sym]              = {};
    kamaCloseWindow[sym]        = {};
    streakState[sym]           = {};

    TIMEFRAMES.forEach(tf => {
      historicalData[sym][tf]        = [];
      currentCandles[sym][tf]        = null;
      kamaNotificationState[sym][tf] = {};
      streakState[sym][tf]           = { type: null, count: 0, alertSent: false };

      KAMA_PERIODS.forEach(period => {
        kamaNotificationState[sym][tf][period] = { 
          lastAlertTimestamp: null, 
          notifSent: false
        };
      });
    });

    KAMA_PERIODS.forEach(period => {
      kamaState[sym][period]       = null;
      kamaCloseWindow[sym][period] = [];
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

// ─── KAMA helpers ──────────────────────────────────────────────────────────────
// Kaufman's Adaptive Moving Average: adapts its smoothing speed to market
// efficiency. ER (efficiency ratio) = net change / sum of absolute changes
// over `period` bars. SC (smoothing constant) = [ER*(fastSC-slowSC)+slowSC]^2.
function kamaSmoothingConstant(er) {
  const fastSC = 2 / (KAMA_FAST_PERIOD + 1);
  const slowSC = 2 / (KAMA_SLOW_PERIOD + 1);
  const sc     = er * (fastSC - slowSC) + slowSC;
  return sc * sc;
}

function initKAMA(symbol, closedCandles, period) {
  const data = closedCandles
    .filter(c => isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  const closes = data.map(c => c.close);

  if (closes.length <= period) {
    kamaState[symbol][period]       = null;
    kamaCloseWindow[symbol][period] = [];
    return;
  }

  // Seed KAMA with the price at index `period`, then walk forward applying
  // the adaptive smoothing constant at each step.
  let kama = closes[period];
  for (let i = period + 1; i < closes.length; i++) {
    const change = Math.abs(closes[i] - closes[i - period]);
    let volatility = 0;
    for (let j = i - period + 1; j <= i; j++) volatility += Math.abs(closes[j] - closes[j - 1]);

    const er = volatility === 0 ? 0 : change / volatility;
    const sc = kamaSmoothingConstant(er);
    kama = kama + sc * (closes[i] - kama);
  }

  kamaState[symbol][period]       = kama;
  // Keep the last (period+1) closes so advanceKAMA can compute ER incrementally
  kamaCloseWindow[symbol][period] = closes.slice(-(period + 1));
}

function advanceKAMA(symbol, period, closedClose) {
  if (kamaState[symbol][period] === null) return;

  const window = kamaCloseWindow[symbol][period];
  window.push(closedClose);
  if (window.length > period + 1) window.shift();
  if (window.length < period + 1) return; // not enough data yet to compute ER

  const change = Math.abs(window[window.length - 1] - window[0]);
  let volatility = 0;
  for (let j = 1; j < window.length; j++) volatility += Math.abs(window[j] - window[j - 1]);

  const er = volatility === 0 ? 0 : change / volatility;
  const sc = kamaSmoothingConstant(er);

  kamaState[symbol][period] = kamaState[symbol][period] + sc * (closedClose - kamaState[symbol][period]);
}

function getKAMA(symbol, period) {
  return kamaState[symbol][period];
}

// ─── KAMA touch and timeout detection ─────────────────────────────────────────
function checkKAMATouches(symbol, timeframe, closedCandle) {
  const symbolName  = displayNames[symbol] || symbol;
  const granularity = timeframeMap[timeframe];
  const currentTimestamp = closedCandle.timestamp;

  KAMA_PERIODS.forEach(period => {
    const kama = getKAMA(symbol, period); 
    if (kama === null) return;

    // Touch condition: The KAMA value lies anywhere between or exactly on the Candle's High and Low
    const touched = closedCandle.low <= kama && closedCandle.high >= kama;

    const dedupKey  = `${symbol}:${timeframe}:${period}`;
    const state     = kamaNotificationState[symbol][timeframe][period];
    const kamaEmoji = KAMA_EMOJIS[period] || period;

    // Process KAMA Touch — only for the designated touch-alert KAMA
    if (period === TOUCH_ALERT_KAMA && touched) {
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

        const message = `${kamaEmoji} ${symbolName}`;
        console.log(`\n${message}`);
        sendTelegramNotification(message, dedupKey);
      }
    }
  });
}

// ─── Candle color + KAMA(8) pullback streak detection ─────────────────────────
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
  const kama  = getKAMA(symbol, PULLBACK_KAMA_PERIOD);
  if (color === null || kama === null) return null;

  // Uptrend pullback: a red candle that still closes at/above the KAMA(8)
  if (color === 'bearish' && closedCandle.close >= kama) return 'redPullback';

  // Downtrend pullback (vice versa): a green candle that still closes at/below the KAMA(8)
  if (color === 'bullish' && closedCandle.close <= kama) return 'greenPullback';

  return null;
}

function checkKamaPullbackStreak(symbol, timeframe, closedCandle) {
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

        // Check for KAMA touches using the fully formed closed candle
        checkKAMATouches(symbol, timeframe, closedCandle);

        // Check for KAMA(8) pullback candle streaks using the fully formed closed candle
        checkKamaPullbackStreak(symbol, timeframe, closedCandle);

        KAMA_PERIODS.forEach(period => {
          advanceKAMA(symbol, period, closedClose);
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

  let kamaString = '';
  KAMA_PERIODS.forEach(period => {
    const kamaVal = getKAMA(symbol, period);
    kamaString += `KAMA${period}:${kamaVal !== null ? kamaVal.toFixed(4) : 'N/A'} `;
  });

  process.stdout.write(
    `\r[${symbol}] Price:${livePrice.toFixed(4)} ${kamaString}  `
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

  KAMA_PERIODS.forEach(period => {
    initKAMA(symbol, historicalData[symbol][timeframe], period);
  });

  const kamaLogDetails = KAMA_PERIODS.map(p => `KAMA${p}:${kamaState[symbol][p]?.toFixed(4) ?? 'N/A'}`).join(' | ');
  console.log(
    `[${symbol}/${timeframe}] Loaded ${data.length} candles | ${kamaLogDetails}`
  );
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
