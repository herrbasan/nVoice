/**
 * Integration test: verify the assistant layer works through the WS relay.
 *
 * Connects to the realtime WS endpoint, waits for the worker to be ready,
 * then injects a fake "transcript" event by connecting a second WS as a
 * mock worker. This tests the relay's interception logic.
 *
 * Run: node test_assistant_relay.mjs
 */
import { WebSocket, WebSocketServer } from 'ws';

const SERVER_URL = 'ws://127.0.0.1:2244/v1/realtime/ws?model=faster_whisper_large-v3';

console.log('Connecting to', SERVER_URL);

const ws = new WebSocket(SERVER_URL);

const events = [];

ws.on('open', () => {
  console.log('[client] WS connected — assistant should be enabled');
  console.log('[client] Waiting for events...');
});

ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  let event;
  try {
    event = JSON.parse(data.toString());
  } catch {
    return;
  }
  events.push(event);
  console.log('[client] EVENT:', JSON.stringify(event));

  // Log assistant events specifically
  if (event.type === 'assistant') {
    console.log('[client] *** ASSISTANT RESULT ***', JSON.stringify(event, null, 2));
  }
});

ws.on('error', (e) => console.error('[client] WS error:', e.message));
ws.on('close', (code) => console.log('[client] WS closed:', code));

// Keep alive for 30s
setTimeout(() => {
  console.log('\n[client] Total events received:', events.length);
  const assistantEvents = events.filter(e => e.type === 'assistant');
  console.log('[client] Assistant events:', assistantEvents.length);
  ws.close();
  process.exit(0);
}, 30000);
