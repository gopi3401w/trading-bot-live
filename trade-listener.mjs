// futures-trade-listener.mjs
import fetch from 'node-fetch';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const EventSource = require('eventsource');

dotenv.config();

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const BASE_URL = 'https://fapi.binance.com';

// Amount in USD margin per trade (before leverage)
const USD_AMOUNT = 20;   // Binance min notional = 20 USDT

// Track leverage to avoid resetting multiple times
const setLeverageOnce = new Map();

// --------------------- Helpers ---------------------

// Sign request params
function signParams(params) {
  const query = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

// Get price
async function getPrice(symbol) {
  try {
    const res = await fetch(`${BASE_URL}/fapi/v1/ticker/price?symbol=${symbol}`);
    const data = await res.json();
    return parseFloat(data.price);
  } catch (err) {
    console.error(`❌ Price error for ${symbol}:`, err.message);
    return null;
  }
}

// Set leverage once per symbol
async function setLeverage(symbol, leverage) {
  if (setLeverageOnce.get(symbol) === leverage) return;

  const timestamp = Date.now();
  const signed = signParams({ symbol, leverage, timestamp });

  try {
    const res = await fetch(`${BASE_URL}/fapi/v1/leverage?${signed}`, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': API_KEY },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.msg || JSON.stringify(data));

    console.log(`⚙️ Leverage set to ${leverage}x for ${symbol}`);
    setLeverageOnce.set(symbol, leverage);
  } catch (err) {
    console.warn(`⚠️ Failed to set leverage for ${symbol}:`, err.message);
  }
}

// Get position
async function getPositionQty(symbol) {
  const timestamp = Date.now();
  const signed = signParams({ timestamp });

  try {
    const res = await fetch(`${BASE_URL}/fapi/v2/positionRisk?${signed}`, {
      headers: { 'X-MBX-APIKEY': API_KEY },
    });
    const data = await res.json();

    if (!Array.isArray(data)) {
      console.error("❌ Unexpected positionRisk response:", data);
      return 0;
    }

    const pos = data.find(p => p.symbol === symbol);
    const amt = parseFloat(pos?.positionAmt || '0');
    console.log(`📊 Current position for ${symbol}: ${amt}`);
    return amt;
  } catch (err) {
    console.error(`❌ Failed to get position for ${symbol}:`, err.message);
    return 0;
  }
}

// Place MARKET order
async function placeOrder(symbol, side, quantity) {
  if (quantity <= 0) {
    console.warn(`⚠️ Skipping ${side} order — invalid quantity: ${quantity}`);
    return;
  }

  const timestamp = Date.now();
  const signed = signParams({
    symbol,
    side: side.toUpperCase(),
    type: 'MARKET',
    quantity,
    timestamp,
    reduceOnly: false
  });

  try {
    const res = await fetch(`${BASE_URL}/fapi/v1/order?${signed}`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.msg || JSON.stringify(data));

    console.log(`🚀 ${side.toUpperCase()} MARKET order executed on ${symbol}`, {
      qty: quantity,
      price: data.avgFillPrice || 'MKT',
    });
  } catch (err) {
    console.error(`❌ Order Error (${side}):`, err.message);
  }
}

// Close open position
async function closePosition(symbol, direction) {
  const pos = await getPositionQty(symbol);
  const quantity = Math.abs(pos).toFixed(3);

  if ((direction === 'long' && pos > 0.0001) || (direction === 'short' && pos < -0.0001)) {
    const side = direction === 'long' ? 'sell' : 'buy';
    await placeOrder(symbol, side, quantity);
  } else {
    console.warn(`⚠️ No ${direction.toUpperCase()} position to close for ${symbol}`);
  }
}

// --------------------- Signal Handler ---------------------

async function handleSignal(symbol, action, multiplier = 1) {
  const price = await getPrice(symbol);
  if (!price) return;

  // Calculate notional (margin * multiplier)
  const notional = USD_AMOUNT * multiplier;
  if (notional < 20) {
    console.warn(`⚠️ Skipping ${action} — notional ${notional} < 20`);
    return;
  }

  const quantity = parseFloat((notional / price).toFixed(3));
  const leverage = (multiplier === 2) ? 20 : 10;
  await setLeverage(symbol, leverage);

  if (action === 'buy') {
    await placeOrder(symbol, 'buy', quantity);
  } else if (action === 'sell') {
    await placeOrder(symbol, 'sell', quantity);
  } else if (action === 'buy tp' || action === 'buy sl') {
    await closePosition(symbol, 'long');
  } else if (action === 'sell tp' || action === 'sell sl') {
    await closePosition(symbol, 'short');
  } else {
    console.log(`ℹ️ Ignored unknown trade action: ${action}`);
  }
}

// --------------------- SSE Listener ---------------------

const stream = new EventSource('http://localhost:4015/stream-signals');

stream.onmessage = async (event) => {
  try {
    const signal = JSON.parse(event.data);
    console.log('✅ Real-time signal:', signal);

    // Skip state-only events
    if (signal.type === 'state') {
      console.log(`ℹ️ Ignored state update: ${signal.mode}`);
      return;
    }

    // Handle only trade actions
    if (signal.type === 'entry' || signal.type === 'tp' || signal.type === 'sl') {
      const symbol = (signal.pair || 'ETHUSDT').toUpperCase().trim();
      const action = signal.signal?.toLowerCase();
      const multiplier = signal.sizeMultiplier || 1;

      if (action) {
        await handleSignal(symbol, action, multiplier);
      } else {
        console.warn("⚠️ Skipping signal — missing 'signal' field:", signal);
      }
    } else {
      console.log(`⚠️ Ignored unsupported event type: ${signal.type}`);
    }
  } catch (err) {
    console.error('❌ Failed to process signal:', err.message);
  }
};

stream.onerror = (err) => {
  console.error('❌ SSE connection error:', err.message);
};
