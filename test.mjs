import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const EventSource = require('eventsource');

const evtSource = new EventSource('http://localhost:3000/stream-signals');

evtSource.onmessage = (e) => {
  const signal = JSON.parse(e.data);
  console.log('✅ Real-time signal:', signal);
};

evtSource.onerror = (err) => {
  console.error('❌ EventSource error:', err);
};
// thanks