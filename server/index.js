// Live Notes server:
//   - spawns whisper.cpp's HTTP server (whisper-server.exe) as a subprocess
//   - accepts utterance PCM over WebSocket, transcribes, broadcasts transcript
//   - proxies Ollama for on-demand commands and the background auto-notes job
//   - persists notes + transcript + config under ./data
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import {
  findWhisperServerExe,
  defaultModelPath,
  startWhisperServer,
  waitWhisperReady,
  encodeWav,
  transcribeWav,
} from './whisper.js';
import { listModels, chatStream, COMMANDS } from './ollama.js';
import { store, ROOT_DIR, loadAutoNotes, saveAutoNotes } from './store.js';
import { createAutoNotes } from './autonotes.js';
import { listProfiles, upsertProfile, deleteProfile, getProfile, buildProfileContext } from './profiles.js';

const APP_PORT = Number(process.env.PORT || 3001);
const DIST_DIR = path.join(ROOT_DIR, 'dist');

// ---------------------------------------------------------------------------
// Shared state + broadcast
const clients = new Set();
let whisperState = { state: 'starting', message: null };
let ollamaOk = true;

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

const transcriptText = () => store.transcript.map((l) => l.text).join('\n');

// Serialize every Ollama call so commands and auto-notes never overlap.
// `pendingInteractive` counts user-triggered commands waiting in the chain so
// the background auto-notes job can yield to them (see createAutoNotes).
let aiChain = Promise.resolve();
let pendingInteractive = 0;
function enqueue(fn) {
  const next = aiChain.then(fn, fn);
  aiChain = next.catch(() => {});
  return next;
}

const autoNotes = createAutoNotes({
  getTranscriptText: transcriptText,
  getNotesDoc: () => store.notes, // manual notes only — the bullets live in their own file
  getConfig: () => store.config,
  getProfileContext: () => buildProfileContext(getProfile(store.config.activeProfileId)),
  enqueue,
  broadcast,
  interactivePending: () => pendingInteractive > 0,
  loadAutoNotes,
  saveAutoNotes,
});

// ---------------------------------------------------------------------------
// whisper.cpp lifecycle
async function initWhisper() {
  const exe = findWhisperServerExe(ROOT_DIR);
  const modelPath = defaultModelPath(ROOT_DIR);
  if (!exe || !fs.existsSync(modelPath)) {
    whisperState = {
      state: 'missing',
      message: !exe
        ? 'whisper-server.exe not found in ./bin — run: npm run setup'
        : 'Whisper model not found in ./models — run: npm run setup',
    };
    broadcast({ t: 'whisper', ...whisperState });
    return;
  }
  const child = await startWhisperServer({ exe, modelPath, onLog: (line) => console.log(`[whisper] ${line}`) });
  child.on('exit', (code) => {
    whisperState = { state: 'exited', message: `whisper-server exited with code ${code}` };
    broadcast({ t: 'whisper', ...whisperState });
  });
  try {
    await waitWhisperReady();
    whisperState = { state: 'ready', message: null };
    broadcast({ t: 'whisper', ...whisperState });
    console.log(`whisper-server ready (${path.basename(modelPath)})`);
  } catch (e) {
    whisperState = { state: 'error', message: 'whisper-server did not become ready in time' };
    broadcast({ t: 'whisper', ...whisperState });
  }
  const shutdown = () => {
    try {
      child.kill();
    } catch {}
  };
  process.on('exit', shutdown);
  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Transcription queue (whisper-server handles one request at a time)
const pcmQueue = []; // {samples, spokenAt} utterances awaiting transcription
let transcribing = false;

function enqueueUtterance(samples, spokenAt) {
  pcmQueue.push({ samples, spokenAt });
  processPcmQueue();
}

// Take the queue head and merge in everything else that fits in one ~28 s
// whisper window (with short silence gaps). Each request pays the encoder's
// fixed 30 s-window cost once, so a backlogged queue catches up several times
// faster than real time instead of drifting further behind.
function mergeQueueHead(maxSeconds = 28) {
  const first = pcmQueue.shift();
  const spokenAt = first.spokenAt;
  let samples = first.samples;
  let seconds = samples.length / 16000;
  const parts = [samples];
  while (pcmQueue.length && seconds + 0.25 + pcmQueue[0].samples.length / 16000 <= maxSeconds) {
    const next = pcmQueue.shift();
    parts.push(new Float32Array(4000)); // 0.25 s silence gap
    parts.push(next.samples);
    seconds += 0.25 + next.samples.length / 16000;
  }
  if (parts.length === 1) return { samples, spokenAt };
  console.log(`[transcribe] merged ${(parts.length + 1) / 2} utterances into ${seconds.toFixed(1)}s`);
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return { samples: out, spokenAt };
}

async function processPcmQueue() {
  if (transcribing) return;
  transcribing = true;
  if (pcmQueue.length) broadcast({ t: 'whisper-busy', busy: true });
  while (pcmQueue.length) {
    const { samples, spokenAt } = mergeQueueHead();
    try {
      // Feed whisper the tail of the previous utterance as a prompt so words
      // like names or topics carry over between segments.
      const recent = transcriptText().slice(-200);
      const raw = await transcribeWav(encodeWav(samples), { prompt: recent || undefined });
      // whisper sometimes emits stray newlines; transcript lines must be single-line
      const text = raw.replace(/\s+/g, ' ').trim();
      console.log(`[transcribe] ${(samples.length / 16000).toFixed(1)}s -> ${text ? JSON.stringify(text) : '(empty)'}`);
      if (text) {
        // timestamp when the words were SPOKEN, not when whisper got to them
        const line = { t: new Date(spokenAt).toTimeString().slice(0, 5), text };
        store.appendTranscriptLine(line);
        broadcast({ t: 'transcript', line });
      }
    } catch (e) {
      console.error('[transcribe] failed:', e.message);
      broadcast({ t: 'error', scope: 'transcribe', message: `Transcription failed: ${e.message}` });
    }
  }
  transcribing = false;
  broadcast({ t: 'whisper-busy', busy: false });
}

// ---------------------------------------------------------------------------
// Ollama commands (stream tokens to the requesting client)
async function runAiCommand({ id, cmd, selection }, ws) {
  const def = COMMANDS[cmd];
  if (!def) {
    ws.send(JSON.stringify({ t: 'ai-error', id, message: `Unknown command: ${cmd}` }));
    return;
  }
  if (def.requiresSelection && !selection?.trim()) {
    ws.send(JSON.stringify({ t: 'ai-error', id, message: 'Select some text first.' }));
    return;
  }
  if (def.requiresTranscript && !transcriptText().trim()) {
    ws.send(JSON.stringify({ t: 'ai-error', id, message: 'The transcript is empty.' }));
    return;
  }
  if (cmd === 'reread' && !selection?.trim() && !store.notes.trim()) {
    ws.send(JSON.stringify({ t: 'ai-error', id, message: 'Nothing to re-read — the notes are empty.' }));
    return;
  }
  const messages = def.build({
    transcript: transcriptText(),
    selection,
    notes: store.notes,
    profileCtx: buildProfileContext(getProfile(store.config.activeProfileId)),
  });
  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
  try {
    await chatStream({
      model: store.config.ollamaModel,
      messages,
      onToken: (token) => send({ t: 'ai-token', id, token }),
    });
    send({ t: 'ai-done', id });
  } catch (e) {
    send({ t: 'ai-error', id, message: `Ollama failed: ${e.message}` });
  }
}

// ---------------------------------------------------------------------------
// HTTP API
const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, whisper: whisperState, ollama: ollamaOk });
});

app.get('/api/tags', async (_req, res) => {
  try {
    const models = await listModels();
    ollamaOk = true;
    res.json({ models });
  } catch {
    ollamaOk = false;
    res.status(502).json({ models: [], message: 'Ollama not reachable at http://127.0.0.1:11434 — is it running?' });
  }
});

app.get('/api/config', async (_req, res) => {
  res.json({ config: store.config, whisper: whisperState, ollama: ollamaOk });
});

app.post('/api/config', (req, res) => {
  const { ollamaModel, autoNotes: enabled, activeProfileId } = req.body || {};
  if (typeof ollamaModel === 'string') store.config.ollamaModel = ollamaModel;
  if (typeof enabled === 'boolean') store.config.autoNotes = enabled;
  if (typeof activeProfileId === 'string' || activeProfileId === null) store.config.activeProfileId = activeProfileId;
  store.saveConfig();
  broadcast({ t: 'config', config: store.config });
  res.json({ config: store.config });
});

app.get('/api/profiles', (_req, res) => {
  res.json({ profiles: listProfiles() });
});

app.post('/api/profiles', (req, res) => {
  try {
    const profile = upsertProfile(req.body || {});
    res.json({ profile });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

app.delete('/api/profiles/:id', (req, res) => {
  deleteProfile(req.params.id);
  if (store.config.activeProfileId === req.params.id) {
    store.config.activeProfileId = null;
    store.saveConfig();
    broadcast({ t: 'config', config: store.config });
  }
  res.json({ ok: true });
});

app.post('/api/notes', (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ message: 'text required' });
  store.saveNotes(text); // sanitizes any embedded region — notes.md is manual-only
  res.json({ ok: true });
});

app.post('/api/transcript/clear', (_req, res) => {
  store.clearTranscript();
  autoNotes.reset();
  broadcast({ t: 'transcript-cleared' });
  res.json({ ok: true });
});

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')));
}

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// WebSocket endpoint: /ws
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  clients.add(ws);

  // Attach message handlers BEFORE any async work, so messages sent
  // immediately after connect are never dropped.
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      // Newer clients prefix the frame with a float64 epoch marking when the
      // speech began; older frames are raw samples. A float64 epoch is always
      // in the 1e12..4e12 range, which no pair of small float32 audio samples
      // can produce, so detection is unambiguous.
      let spokenAt = Date.now();
      let sampleBuf = buf;
      if (buf.byteLength >= 8) {
        const when = new DataView(buf).getFloat64(0);
        if (when > 1e12 && when < 4e12) {
          spokenAt = when;
          sampleBuf = buf.slice(8);
        }
      }
      const samples = new Float32Array(sampleBuf, 0, Math.floor(sampleBuf.byteLength / 4));
      if (samples.length >= 8000) enqueueUtterance(samples, spokenAt); // >=0.5s of 16kHz audio
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (msg.t) {
      case 'config': {
        if (typeof msg.ollamaModel === 'string') store.config.ollamaModel = msg.ollamaModel;
        if (typeof msg.autoNotes === 'boolean') store.config.autoNotes = msg.autoNotes;
        if (typeof msg.activeProfileId === 'string' || msg.activeProfileId === null) {
          store.config.activeProfileId = msg.activeProfileId;
        }
        store.saveConfig();
        broadcast({ t: 'config', config: store.config });
        break;
      }
      case 'ai': {
        pendingInteractive++;
        enqueue(() => runAiCommand(msg, ws)).then(
          () => pendingInteractive--,
          () => pendingInteractive--
        );
        break;
      }
      case 'autonotes-now': {
        autoNotes.triggerNow();
        break;
      }
      case 'autonotes-rebuild': {
        autoNotes.rebuild();
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => clients.delete(ws));

  // Sync models + config, then send the current session state.
  (async () => {
    let models = [];
    try {
      models = await listModels();
      ollamaOk = true;
      if (!store.config.ollamaModel || !models.includes(store.config.ollamaModel)) {
        store.config.ollamaModel = models[0] || null;
        store.saveConfig();
      }
    } catch {
      ollamaOk = false;
    }
    ws.send(
      JSON.stringify({
        t: 'init',
        notes: store.notes,
        autoNotes: autoNotes.snapshot(),
        transcript: store.transcript,
        config: store.config,
        profiles: listProfiles(),
        models,
        whisper: whisperState,
        ollama: ollamaOk,
      })
    );
  })();
});

// ---------------------------------------------------------------------------
autoNotes.start();
server.listen(APP_PORT, '127.0.0.1', () => {
  console.log(`Live Notes server → http://127.0.0.1:${APP_PORT}`);
});
initWhisper();