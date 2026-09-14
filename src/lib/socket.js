// Singleton WebSocket to the Node server with auto-reconnect. The connection
// is bound to one note via ?session=<slug> — the server rejects unknown
// notes, so a typo'd URL simply never connects (the page shows "not found").
let ws = null;
let reconnectTimer = null;
let currentSession = null; // remembered so reconnects re-bind the same note
const handlers = new Set();

export function onMessage(fn) {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

function dispatch(msg) {
  for (const fn of handlers) fn(msg);
}

export function connect(session) {
  if (session !== undefined) currentSession = session;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?session=${encodeURIComponent(currentSession || '')}`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => dispatch({ t: 'connected' });
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') dispatch(JSON.parse(e.data));
  };
  ws.onclose = () => {
    dispatch({ t: 'disconnected' });
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connect(), 1000);
  };
}

export function sendJson(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

/**
 * Send one complete utterance of 16 kHz Float32 PCM samples. The frame starts
 * with a float64 epoch timestamp marking when the speech began, so transcript
 * lines show speaking time even if transcription lags behind.
 */
export function sendPcm(float32, spokenAt = Date.now()) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const buf = new ArrayBuffer(8 + float32.byteLength);
  new DataView(buf).setFloat64(0, spokenAt);
  new Float32Array(buf, 8).set(float32);
  ws.send(buf);
}