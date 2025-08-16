import express from 'express';
import mongoose from 'mongoose';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

const mongoURI = 'mongodb+srv://dgames7620:Gopalmirge%40777@cluster0.atfoccf.mongodb.net/gopal?retryWrites=true&w=majority&appName=Cluster0';

const app = express();
const PORT = 3000;

// 🔴 Change this to your real forward endpoint

app.use(bodyParser.json());

// Connect MongoDB
mongoose.connect(mongoURI)
  .then(() => console.log('✅ Connected to MongoDB Atlas'))
  .catch((err) => console.error('❌ MongoDB connection error:', err));

// Collections
const tradingSchema = new mongoose.Schema({}, { strict: false });
const Trading = mongoose.model('Trading', tradingSchema, 'Trading');

// Modes
const VALID_MODES = new Set([
  'aside_wait_loss',
  'wait_profit_after_loss',
  'armed_wait_entry',
  'in_trade_wait_outcome',
  'halt_until_two_profits',
]);

const signalStateSchema = new mongoose.Schema({
  mode: { type: String, default: 'aside_wait_loss' },
  lastSignal: Object,
  consecLosses: { type: Number, default: 0 },
  sizeMultiplier: { type: Number, default: 1 },
  ppCount: { type: Number, default: 0 },
}, { collection: 'SignalState' });

const SignalState = mongoose.model('SignalState', signalStateSchema);

// Ensure initial SignalState
mongoose.connection.once('open', async () => {
  let state = await SignalState.findOne();
  if (!state) {
    await SignalState.create({
      mode: 'aside_wait_loss',
      lastSignal: null,
      consecLosses: 0,
      sizeMultiplier: 1,
      ppCount: 0,
    });
    console.log('🧠 Initialized SignalState to aside_wait_loss');
  } else {
    if (!VALID_MODES.has(state.mode)) state.mode = 'aside_wait_loss';
    if (state.consecLosses == null) state.consecLosses = 0;
    if (state.sizeMultiplier == null) state.sizeMultiplier = 1;
    if (state.ppCount == null) state.ppCount = 0;
    await state.save();
    console.log('🧠 Migrated/validated SignalState:', state.mode);
  }
});

const logFilePath = path.join(process.cwd(), 'signal-log.json');

// Safe JSON log writer
const appendToJSONLog = async (data) => {
  try {
    if (!fs.existsSync(logFilePath)) fs.writeFileSync(logFilePath, '[]');

    let log = [];
    try {
      const raw = fs.readFileSync(logFilePath, 'utf-8');
      log = raw ? JSON.parse(raw) : [];
    } catch (err) {
      console.warn('⚠ Malformed signal-log.json — resetting.');
      log = [];
    }

    log.unshift({ ...data, loggedAt: new Date().toISOString() });
    if (log.length > 1000) log = log.slice(0, 1000);

    fs.writeFileSync(logFilePath, JSON.stringify(log, null, 2));
  } catch (err) {
    console.error('⚠ Failed to write signal-log.json:', err);
  }
};



// 🔴 SSE client store
const clients = [];
app.get('/stream-signals', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.write('\n');
  clients.push(res);
  console.log(`📡 New client connected. Total: ${clients.length}`);

  req.on('close', () => {
    const index = clients.indexOf(res);
    if (index !== -1) clients.splice(index, 1);
    console.log(`🔌 Client disconnected. Total: ${clients.length}`);
  });
});

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => res.write(payload));
}
function broadcastState(mode) {
  broadcast({ type: 'state', mode, at: new Date().toISOString() });
}

// Helpers
function normSignal(s) {
  return (s ?? '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
}
function isEntry(signalType) {
  return signalType === 'buy' || signalType === 'sell';
}
function isOutcome(signalType) {
  return signalType.endsWith(' tp') || signalType.endsWith(' sl');
}
function outcomeKind(signalType) {
  return signalType.endsWith(' tp') ? 'tp' : (signalType.endsWith(' sl') ? 'sl' : null);
}
function matchesOutcomeForEntry(entrySignal, outcomeSignal) {
  return normSignal(outcomeSignal).startsWith(normSignal(entrySignal));
}
const isProfit = (sig) => isOutcome(sig) && outcomeKind(sig) === 'tp';
const isLoss   = (sig) => isOutcome(sig) && outcomeKind(sig) === 'sl';

// Disabled forwarder (no-op)
async function forwardSignal(data) {
  // intentionally do nothing
  console.log("⏩ forwardSignal ignored:", data.signal || data);
}

// POST webhook handler
app.post('/webhook', async (req, res) => {
  try {
    const raw = req.body;
    if (!raw || Object.keys(raw).length === 0) {
      return res.status(400).json({ message: 'Empty payload received' });
    }

    // Normalize signal
    const signalType = normSignal(raw.signal);
    if (!signalType) {
      return res.status(400).json({ message: 'Missing signal type' });
    }

    // Persist the raw event
    const entry = new Trading(raw);
    await entry.save();

    // Load/validate state
    let state = await SignalState.findOne();
    if (!state || !VALID_MODES.has(state.mode)) {
      state = state || new SignalState();
      state.mode = 'aside_wait_loss';
      state.lastSignal = null;
      state.consecLosses = state.consecLosses ?? 0;
      state.sizeMultiplier = state.sizeMultiplier ?? 1;
      state.ppCount = state.ppCount ?? 0;
      await state.save();
    }

    // State machine
    let logThis = false;
    let info = 'Processed';

    if (state.mode === 'aside_wait_loss') {
      if (isLoss(signalType)) {
        state.mode = 'wait_profit_after_loss';
        await state.save();
        broadcastState(state.mode);
        info = 'Loss observed; waiting for ONE profit close to arm.';
      } else {
        info = 'Aside: waiting for a loss (SL) before arming.';
      }
    }

    else if (state.mode === 'wait_profit_after_loss') {
      if (isProfit(signalType)) {
        state.sizeMultiplier = (state.consecLosses >= 2) ? 2 : 1;
        state.mode = 'armed_wait_entry';
        await state.save();
        broadcastState(state.mode);
        info = `Armed on first Profit; next entry will be taken (x${state.sizeMultiplier}).`;
      } else {
        info = 'Waiting for ONE profit close (TP) to arm.';
      }
    }

    else if (state.mode === 'armed_wait_entry') {
      if (isEntry(signalType)) {
        const entryTaken = { ...raw, sizeMultiplier: state.sizeMultiplier };
        console.log('✅ Entry signal accepted:', entryTaken);
        await appendToJSONLog({ phase: 'entry', ...entryTaken });
        broadcast({ type: 'entry', ...entryTaken });

        // 🔴 Forward entry
        await forwardSignal(entryTaken);

        logThis = true;
        state.mode = 'in_trade_wait_outcome';
        state.lastSignal = entryTaken;
        await state.save();
        broadcastState(state.mode);
        info = `Entry accepted; waiting for this trade outcome (x${state.sizeMultiplier}).`;
      } else {
        info = `Armed: waiting for next entry (buy/sell). Next size x${state.sizeMultiplier}.`;
      }
    }

    else if (state.mode === 'in_trade_wait_outcome') {
      const expected = normSignal(state.lastSignal?.signal);
      if (isOutcome(signalType) && matchesOutcomeForEntry(expected, signalType)) {
        const kind = outcomeKind(signalType);
        const resultType = kind === 'tp' ? 'tp' : 'sl';

        console.log(`📈 Trade closed (${resultType.toUpperCase()}):`, raw);
        await appendToJSONLog({ phase: 'outcome', outcome: resultType, sizeMultiplier: state.sizeMultiplier, ...raw });
        broadcast({ type: resultType, sizeMultiplier: state.sizeMultiplier, ...raw });

        // 🔴 Forward outcome
        await forwardSignal({ ...raw, outcome: resultType, sizeMultiplier: state.sizeMultiplier });

        if (resultType === 'tp') {
          state.mode = 'aside_wait_loss';
          state.lastSignal = null;
          state.consecLosses = 0;
          state.sizeMultiplier = 1;
          state.ppCount = 0;
          await state.save();
          broadcastState(state.mode);
          info = 'Trade closed in profit → reset to basic; waiting for next loss (SL).';
        } else {
          state.consecLosses = (state.consecLosses || 0) + 1;
          state.lastSignal = null;

          if (state.consecLosses >= 3) {
            state.mode = 'halt_until_two_profits';
            state.sizeMultiplier = 1;
            state.ppCount = 0;
            await state.save();
            broadcastState(state.mode);
            info = '3rd consecutive loss → HALT. Wait for two Profits (P P) before resuming.';
          } else {
            state.sizeMultiplier = (state.consecLosses >= 2) ? 2 : 1;
            state.mode = 'wait_profit_after_loss';
            await state.save();
            broadcastState(state.mode);
            const note = (state.sizeMultiplier === 2)
              ? 'Next entry will be x2 (after two losses).'
              : 'Next entry will be normal size.';
            info = `Lost trade → waiting for ONE Profit to arm again. ${note}`;
          }
        }
        logThis = true;
      } else if (isEntry(signalType)) {
        info = 'Still in a trade; ignoring new entry until the current trade closes.';
      } else {
        info = 'In-trade: signal not related to current trade outcome.';
      }
    }

    else if (state.mode === 'halt_until_two_profits') {
      if (isProfit(signalType)) {
        state.ppCount = (state.ppCount || 0) + 1;
        if (state.ppCount >= 2) {
          state.mode = 'aside_wait_loss';
          state.consecLosses = 0;
          state.sizeMultiplier = 1;
          state.ppCount = 0;
          await state.save();
          broadcastState(state.mode);
          info = 'HALT cleared by two Profits. Reset to basic; waiting for next Loss.';
        } else {
          await state.save();
          info = `HALT: observed ${state.ppCount} Profit(s); need ${2 - state.ppCount} more.`;
        }
      } else if (isLoss(signalType)) {
        info = 'HALT: Loss observed; still waiting for two Profits.';
      } else {
        info = 'HALT: waiting for two Profits (P P).';
      }
    }

    // Trim old signals
    const total = await Trading.countDocuments();
    if (total > 300) {
      const oldRecords = await Trading.find().sort({ _id: 1 }).limit(total - 300).select('_id');
      const oldIds = oldRecords.map(doc => doc._id);
      await Trading.deleteMany({ _id: { $in: oldIds } });
      console.log(`🧹 Deleted ${oldIds.length} old records`);
    }

    if (!logThis) {
      console.log('ℹ Signal processed (not logged):', signalType);
    }

    return res.status(200).json({ message: 'Webhook processed', info, mode: state.mode });
  } catch (error) {
    console.error('❌ Error in /webhook:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Listening on http://localhost:${PORT}/webhook`);
});
