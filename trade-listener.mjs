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
const LEVERAGE = 10;
const USD_AMOUNT = 100;
const setLeverageOnce = new Set();

// Sign request
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

// Set leverage
async function setLeverage(symbol) {
  if (setLeverageOnce.has(symbol)) return;
  const timestamp = Date.now();
  const signed = signParams({ symbol, leverage: LEVERAGE, timestamp });

  try {
    const res = await fetch(`${BASE_URL}/fapi/v1/leverage?${signed}`, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': API_KEY },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.msg);
    console.log(`⚙️ Leverage set to ${LEVERAGE}x for ${symbol}`);
    setLeverageOnce.add(symbol);
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
    const pos = data.find(p => p.symbol === symbol);
    const amt = parseFloat(pos?.positionAmt || '0');
    console.log(`📊 Current position for ${symbol}: ${amt}`);
    return amt;
  } catch (err) {
    console.error(`❌ Failed to get position for ${symbol}:`, err.message);
    return 0;
  }
}

// Place market order
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
    if (!res.ok) throw new Error(data.msg);
    console.log(`🚀 ${side.toUpperCase()} MARKET order executed on ${symbol}:`, data);
  } catch (err) {
    console.error(`❌ Order Error (${side}):`, err.message);
  }
}

// Close position
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

// Handle signal
async function handleSignal(symbol, action) {
  const price = await getPrice(symbol);
  if (!price) return;
  const quantity = parseFloat((USD_AMOUNT / price).toFixed(3));
  await setLeverage(symbol);

  if (action === 'buy') {
    await placeOrder(symbol, 'buy', quantity);
  } else if (action === 'sell') {
    await placeOrder(symbol, 'sell', quantity);
  } else if (action === 'buy tp' || action === 'buy sl') {
    await closePosition(symbol, 'long');
  } else if (action === 'sell tp' || action === 'sell sl') {
    await closePosition(symbol, 'short');
  } else {
    console.warn(`⚠️ Unknown action: ${action}`);
  }
}

// Stream
const stream = new EventSource('http://localhost:3000/stream-signals');

stream.onmessage = async (event) => {
  try {
    const signal = JSON.parse(event.data);
    console.log('📡 Signal received:', signal);
    const symbol = signal.pair?.toUpperCase() || 'BTCUSDT';
    const action = signal.signal?.toLowerCase();
    await handleSignal(symbol, action);
  } catch (err) {
    console.error('❌ Failed to process signal:', err.message);
  }
};

stream.onerror = (err) => {
  console.error('❌ SSE connection error:', err.message);
};
