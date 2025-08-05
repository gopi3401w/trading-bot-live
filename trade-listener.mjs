import fetch from 'node-fetch';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

const TRADE_SYMBOL = 'BTCUSDT';
const TRADE_QUANTITY = '0.001'; // Change this to match your capital
const BINANCE_API_BASE = 'https://api.binance.com';

// Sign request
function signParams(params) {
  const query = new URLSearchParams(params).toString();
  const signature = crypto
    .createHmac('sha256', BINANCE_API_SECRET)
    .update(query)
    .digest('hex');
  return `${query}&signature=${signature}`;
}

// Send market order
async function placeMarketOrder(side) {
  const timestamp = Date.now();
  const params = {
    symbol: TRADE_SYMBOL,
    side: side.toUpperCase(),
    type: 'MARKET',
    quantity: TRADE_QUANTITY,
    timestamp,
  };

  const signedQuery = signParams(params);

  try {
    const response = await fetch(`${BINANCE_API_BASE}/api/v3/order`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': BINANCE_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: signedQuery,
    });

    const result = await response.json();

    if (response.ok) {
      console.log(`🚀 ${side.toUpperCase()} order executed:`, result);
    } else {
      console.error('❌ Binance error:', result);
    }
  } catch (err) {
    console.error('❌ Request failed:', err.message);
  }
}

// Connect to streaming server
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const EventSource = require('eventsource');
const stream = new EventSource('http://localhost:3000/stream-signals');

stream.onmessage = (event) => {
  try {
    const signal = JSON.parse(event.data);
    console.log('📡 Signal received:', signal);

    const type = signal.type;
    const action = signal.signal?.toLowerCase();

    if (type === 'entry' && (action === 'buy' || action === 'sell')) {
      placeMarketOrder(action);
    }
  } catch (err) {
    console.error('❌ Failed to parse signal:', err);
  }
};

stream.onerror = (err) => {
  console.error('❌ SSE error:', err);
};
