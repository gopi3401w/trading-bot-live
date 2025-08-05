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

const signalStateSchema = new mongoose.Schema({
  mode: String,
  lastSignal: Object,
}, { collection: 'SignalState' });

const SignalState = mongoose.model('SignalState', signalStateSchema);

// Ensure initial SignalState
mongoose.connection.once('open', async () => {
  const existing = await SignalState.findOne();
  if (!existing) {
    await SignalState.create({ mode: 'waiting_3sl', lastSignal: null });
    console.log('🧠 Initialized SignalState to waiting_3sl');
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

function broadcastSignal(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => res.write(payload));
}

// POST webhook handler
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;

    if (!data || Object.keys(data).length === 0) {
      return res.status(400).json({ message: 'Empty payload received' });
    }

    const signalType = data.signal?.toLowerCase();
    const isEntrySignal = signalType === 'buy' || signalType === 'sell';
    const isOutcomeSignal = signalType?.includes('tp') || signalType?.includes('sl');

    let state = await SignalState.findOne();

    const entry = new Trading(data);
    await entry.save();

    const recentSignals = await Trading.find().sort({ _id: -1 }).limit(60).lean();

    const completeSignals = [];
    for (let i = 0; i < recentSignals.length - 1; i++) {
      const current = recentSignals[i];
      const next = recentSignals[i + 1];

      const nextSignal = next.signal?.toLowerCase();
      const currentSignal = current.signal?.toLowerCase();

      const isValidPair =
        (currentSignal === `${nextSignal} tp` || currentSignal === `${nextSignal} sl`) &&
        (nextSignal === 'buy' || nextSignal === 'sell');

      if (isValidPair) {
        completeSignals.push({
          entry: nextSignal,
          outcome: currentSignal.endsWith('sl') ? 'sl' : 'tp',
          entryTime: next.time || null,
        });
        i++;
      }
    }

    const last3 = completeSignals.slice(0, 3);
    const failedCount = last3.filter(sig => sig.outcome === 'sl').length;

    let logThis = false;

    if (state.mode === 'waiting_3sl') {
      if (isEntrySignal) {
        if (failedCount < 3) {
          return res.status(200).json({ message: 'Entry rejected: wait for 3 failed trades' });
        }

        console.log('✅ Entry signal accepted after 3 SLs:', data);
        await appendToJSONLog(data);
        broadcastSignal({ type: 'entry', ...data });

        logThis = true;
        state.mode = 'awaiting_outcome';
        state.lastSignal = data;
        await state.save();
      } else {
        return res.status(200).json({ message: 'Waiting for valid entry signal' });
      }
    } else if (state.mode === 'awaiting_outcome') {
      const expected = state.lastSignal?.signal?.toLowerCase();
      const isThisTheOutcome = isOutcomeSignal && signalType.startsWith(expected);

      if (isThisTheOutcome) {
        const isTP = signalType.endsWith('tp');
        const resultType = isTP ? 'tp' : 'sl';

        console.log(`📈 ${resultType.toUpperCase()} hit:`, data);
        await appendToJSONLog(data);
        broadcastSignal({ type: resultType, ...data });

        logThis = true;
        state.mode = 'waiting_3sl';
        state.lastSignal = null;
        await state.save();
      } else if (isEntrySignal) {
        return res.status(200).json({ message: 'Still awaiting previous trade outcome' });
      } else {
        return res.status(200).json({ message: 'Signal not related to current outcome wait' });
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
      console.log('ℹ Signal processed (not logged):', data.signal);
    }

    return res.status(200).json({ message: 'Webhook processed successfully' });
  } catch (error) {
    console.error('❌ Error in /webhook:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Listening on http://localhost:${PORT}/webhook`);
});
