import express from 'express';
import mongoose from 'mongoose';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';

const mongoURI = 'mongodb+srv://dgames7620:Gopalmirge%40777@cluster0.atfoccf.mongodb.net/gopal?retryWrites=true&w=majority&appName=Cluster0';

const app = express();
const PORT = 3000;

app.use(bodyParser.json());

// Connect MongoDB
mongoose.connect(mongoURI)
  .then(() => console.log('✅ Connected to MongoDB Atlas'))
  .catch((err) => console.error('❌ MongoDB connection error:', err));

// Collections
const tradingSchema = new mongoose.Schema({}, { strict: false });
const Trading = mongoose.model('Trading', tradingSchema, 'Trading');

// New state machine modes
// - aside_wait_loss:         idle; ignore entries until any SL occurs
// - wait_profit_after_loss:  saw a loss; wait for any TP
// - armed_wait_entry:        saw Loss -> Profit; take the very next entry (buy/sell)
// - in_trade_wait_outcome:   we are in a trade; wait for matching TP/SL
const VALID_MODES = new Set([
  'aside_wait_loss',
  'wait_profit_after_loss',
  'armed_wait_entry',
  'in_trade_wait_outcome',
]);

const signalStateSchema = new mongoose.Schema({
  mode: String,       // one of VALID_MODES
  lastSignal: Object, // the entry we accepted when in_trade_wait_outcome
}, { collection: 'SignalState' });

const SignalState = mongoose.model('SignalState', signalStateSchema);

// Ensure initial SignalState
mongoose.connection.once('open', async () => {
  let state = await SignalState.findOne();
  if (!state) {
    await SignalState.create({ mode: 'aside_wait_loss', lastSignal: null });
    console.log('🧠 Initialized SignalState to aside_wait_loss');
  } else if (!VALID_MODES.has(state.mode)) {
    state.mode = 'aside_wait_loss';
    state.lastSignal = null;
    await state.save();
    console.log('🧠 Migrated SignalState to aside_wait_loss');
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
  // entrySignal: 'buy' | 'sell'; outcomes begin with same prefix e.g. 'buy tp'
  return normSignal(outcomeSignal).startsWith(normSignal(entrySignal));
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
      await state.save();
    }

    // State machine
    let logThis = false;
    let info = 'Processed';

    if (state.mode === 'aside_wait_loss') {
      if (isOutcome(signalType) && outcomeKind(signalType) === 'sl') {
        // Saw a loss in the stream → now wait for a profit close
        state.mode = 'wait_profit_after_loss';
        await state.save();
        broadcastState(state.mode);
        info = 'Loss observed; waiting for profit close to arm.';
      } else {
        info = 'Aside: waiting for a loss (SL) before arming.';
      }
    }

    else if (state.mode === 'wait_profit_after_loss') {
      if (isOutcome(signalType) && outcomeKind(signalType) === 'tp') {
        // Loss → Profit sequence completed → arm for next entry
        state.mode = 'armed_wait_entry';
        await state.save();
        broadcastState(state.mode);
        info = 'Armed: waiting for the very next entry (buy/sell).';
      } else {
        info = 'Waiting for profit close (TP) to arm.';
      }
    }

    else if (state.mode === 'armed_wait_entry') {
      if (isEntry(signalType)) {
        // Take the very next entry
        console.log('✅ Entry signal accepted:', raw);
        await appendToJSONLog({ phase: 'entry', ...raw });
        broadcast({ type: 'entry', ...raw });

        logThis = true;
        state.mode = 'in_trade_wait_outcome';
        state.lastSignal = raw; // remember our entry to match its outcome
        await state.save();
        broadcastState(state.mode);
        info = 'Entry accepted; waiting for this trade outcome.';
      } else {
        info = 'Armed: waiting for next entry.';
      }
    }

    else if (state.mode === 'in_trade_wait_outcome') {
      const expected = normSignal(state.lastSignal?.signal); // 'buy' or 'sell'
      if (isOutcome(signalType) && matchesOutcomeForEntry(expected, signalType)) {
        const kind = outcomeKind(signalType); // 'tp' or 'sl'
        const resultType = kind === 'tp' ? 'tp' : 'sl';

        console.log(`📈 Trade closed (${resultType.toUpperCase()}):`, raw);
        await appendToJSONLog({ phase: 'outcome', outcome: resultType, ...raw });
        broadcast({ type: resultType, ...raw });

        if (resultType === 'tp') {
          // Our trade profited → reset completely; wait for next Loss to start a new cycle
          state.mode = 'aside_wait_loss';
          state.lastSignal = null;
          await state.save();
          broadcastState(state.mode);
          info = 'Trade closed in profit → reset; waiting for next loss (SL).';
        } else {
          // Our trade lost → wait for next Profit close, then we’ll take the next entry
          state.mode = 'wait_profit_after_loss';
          state.lastSignal = null;
          await state.save();
          broadcastState(state.mode);
          info = 'Trade closed in loss → waiting for next profit close (TP) to arm.';
        }
        logThis = true;
      } else if (isEntry(signalType)) {
        info = 'Still in a trade; ignoring new entry until the current trade closes.';
      } else {
        info = 'In-trade: signal not related to current trade outcome.';
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
