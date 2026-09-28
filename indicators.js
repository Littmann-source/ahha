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
const COOLDOWN_CANDLES   = 8;        // Closed candles to wait before re-alerting for touches

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

// ─── Channel (bands) configuration — ported from "Channel Sun Signals" (MQ5) ───
const CHANNEL_HALF_LENGTH   = 30;          // H: mid line = triangular WMA over 2H+1 bars; deviation averaging length = 2H+1
const CHANNEL_APPLIED_PRICE = 'weighted';  // 'open' | 'high' | 'low' | 'close' | 'median' | 'typical' | 'weighted'
const CHANNEL_DEVIATION     = 2.0;         // multiplier applied to the deviation (band distance)
const CHANNEL_TOUCH_ALERT   = true;        // Telegram alert when a candle CLOSES having touched the upper/lower band
const CHANNEL_EMOJIS = {
  upper: '🔺',   // candle high reached the upper band
  lower: '🔻'    // candle low reached the lower band
};

// Same input sanitizing as the MQ5 OnInit(): H clamped to 1..2000, deviation <=0 -> 2.0, max 20
const channelHalf = Math.min(Math.max(Math.trunc(CHANNEL_HALF_LENGTH) || 1, 1), 2000);
const channelDev  = !(CHANNEL_DEVIATION > 0) ? 2.0 : Math.min(CHANNEL_DEVIATION, 20);

// ─── Symbols & timeframes ─────────────────────────────────────────────────────
const SYMBOLS    = [/* 'R_10', */ 'R_25'];
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

// ─── Channel (bands) calculation ───────────────────────────────────────────────
// Port of CalculateChannelGeneric() from Channel Sun Signals.mq5.
//  1) mid   = centered triangular WMA of the applied price (weights H+1 at the
//             centre, falling by 1 per bar to 1 at the edges; missing neighbours
//             at the ends are simply left out and the sum is renormalised)
//  2) diff  = price - mid
//  3) wu/wd = EMA (length 2H+1) of diff^2, split by side: wu learns only from bars
//             above the mid, wd only from bars below (the other side just decays)
//  4) upper = mid + dev*sqrt(wu),  lower = mid - dev*sqrt(wd)   (asymmetric bands)
// Arrays here are chronological (index 0 = oldest, n-1 = newest/forming candle),
// the MQ5 code uses series order, so its seedIndex (total-H-1) becomes index H.
// NOTE: like the MQ5 original, the mid line is centered, so the values of the
// last H candles are provisional and shift as new candles arrive (repainting).
function channelAppliedPrice(c) {
  switch (CHANNEL_APPLIED_PRICE) {
    case 'open':     return c.open;
    case 'high':     return c.high;
    case 'low':      return c.low;
    case 'median':   return (c.high + c.low) / 2;
    case 'typical':  return (c.high + c.low + c.close) / 3;
    case 'weighted': return (c.high + c.low + 2 * c.close) / 4;
    default:         return c.close;
  }
}

function calculateChannel(candles) {
  const n = candles.length;
  const H = channelHalf;
  if (n <= H) return null;

  const fullLength = 2 * H + 1;
  const P     = new Array(n);
  const mid   = new Array(n).fill(NaN);
  const upper = new Array(n).fill(NaN);
  const lower = new Array(n).fill(NaN);
  const wu    = new Array(n).fill(0);
  const wd    = new Array(n).fill(0);

  for (let t = 0; t < n; t++) P[t] = channelAppliedPrice(candles[t]);

  for (let t = H; t < n; t++) {           // bars older than the seed (t < H) get no bands
    let sum = (H + 1) * P[t];
    let sumw = H + 1;
    for (let j = 1, k = H; j <= H; j++, k--) {
      if (t + j < n)  { sum += k * P[t + j]; sumw += k; }   // newer neighbour
      if (t - j >= 0) { sum += k * P[t - j]; sumw += k; }   // older neighbour
    }
    mid[t] = sum / sumw;

    const diff = P[t] - mid[t];

    if (t === H) {                        // seed bar
      upper[t] = mid[t];
      lower[t] = mid[t];
      if (diff >= 0) { wu[t] = diff * diff; wd[t] = 0; }
      else           { wd[t] = diff * diff; wu[t] = 0; }
      continue;
    }

    if (diff >= 0) {
      wu[t] = (wu[t - 1] * (fullLength - 1) + diff * diff) / fullLength;
      wd[t] =  wd[t - 1] * (fullLength - 1) / fullLength;
    } else {
      wd[t] = (wd[t - 1] * (fullLength - 1) + diff * diff) / fullLength;
      wu[t] =  wu[t - 1] * (fullLength - 1) / fullLength;
    }

    upper[t] = mid[t] + channelDev * Math.sqrt(Math.max(wu[t], 0));
    lower[t] = mid[t] - channelDev * Math.sqrt(Math.max(wd[t], 0));

    // Guard against corrupt data: fall back to the plain price and reset the recursion
    if (!Number.isFinite(mid[t]) || !Number.isFinite(upper[t]) || !Number.isFinite(lower[t])) {
      mid[t] = upper[t] = lower[t] = P[t];
      wu[t] = 0; wd[t] = 0;
    }
  }

  return { mid, upper, lower };
}

// Latest channel values for a symbol/timeframe.
//   live       -> values on the currently forming candle
//   lastClosed -> values on the most recent closed candle
// Returns null until there is enough history.
function getChannel(symbol, timeframe) {
  const closed = historicalData[symbol][timeframe];
  const cur    = currentCandles[symbol][timeframe];
  const candles = cur ? closed.concat(cur) : closed;

  const ch = calculateChannel(candles);
  if (!ch) return null;

  const pick = t => (t >= 0 && Number.isFinite(ch.upper[t]))
    ? { mid: ch.mid[t], upper: ch.upper[t], lower: ch.lower[t] }
    : null;

  return { live: pick(candles.length - 1), lastClosed: pick(candles.length - 2) };
}

// ─── Channel band touch detection (evaluated once, at candle close) ───────────
// A "touch" = the closed candle's range reached the band: high >= upper, or low <= lower.
// Called right after the candle was pushed to historicalData, so the closed candle is the
// newest bar (last index) of the array the channel is calculated on. Its band values use
// only the data available at close, so they can still shift slightly on later candles.
function checkChannelTouches(symbol, timeframe, closedCandle) {
  if (!CHANNEL_TOUCH_ALERT) return;

  const hist = historicalData[symbol][timeframe];
  const ch   = calculateChannel(hist);
  if (!ch) return;

  const t = hist.length - 1;
  if (t <= channelHalf) return;              // seed bar: bands haven't opened up yet

  const upper = ch.upper[t];
  const lower = ch.lower[t];
  if (!Number.isFinite(upper) || !Number.isFinite(lower)) return;

  const symbolName = displayNames[symbol]    || symbol;
  const tfName     = displayNames[timeframe] || timeframe;

  const touches = [];
  if (closedCandle.high >= upper) touches.push({ side: 'upper', label: 'Upper', level: upper, extreme: closedCandle.high, word: 'High'  });
  if (closedCandle.low  <= lower) touches.push({ side: 'lower', label: 'Lower', level: lower, extreme: closedCandle.low,  word: 'Low'   });

  touches.forEach(({ side, label, level, extreme, word }) => {
    const message = `${CHANNEL_EMOJIS[side]} ${symbolName} ${tfName}\n` +
                    `${label} band touched (${word} ${extreme.toFixed(4)} | Band ${level.toFixed(4)})`;
    console.log(`\n${message}`);
    sendTelegramNotification(message, `${symbol}:${timeframe}:channel-${side}`);
  });
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

        // Check whether the closed candle touched the channel bands
        checkChannelTouches(symbol, timeframe, closedCandle);

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

  const ch = getChannel(symbol, timeframe);
  const channelString = ch && ch.live
    ? `Dn:${ch.live.lower.toFixed(4)} Mid:${ch.live.mid.toFixed(4)} Up:${ch.live.upper.toFixed(4)}`
    : 'Channel:N/A';

  process.stdout.write(
    `\r[${symbol}] Price:${livePrice.toFixed(4)} ${kamaString}${channelString}  `
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
  const chLoaded = getChannel(symbol, timeframe);
  const chLogDetails = chLoaded && chLoaded.live
    ? `Channel Dn:${chLoaded.live.lower.toFixed(4)} Mid:${chLoaded.live.mid.toFixed(4)} Up:${chLoaded.live.upper.toFixed(4)}`
    : 'Channel:N/A';
  console.log(
    `[${symbol}/${timeframe}] Loaded ${data.length} candles | ${kamaLogDetails} | ${chLogDetails}`
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
