// Live Notes server:
//   - spawns whisper.cpp's HTTP server (whisper-server.exe) as a subprocess
//   - hosts any number of "notes" (recording sessions), each with its own
//     transcript, notes document, AI bullets and settings
//   - accepts utterance PCM over WebSocket (bound to a note via ?session=),
//     transcribes, broadcasts to that note's viewers
//   - proxies Ollama for on-demand commands and the background auto-notes job
//   - persists everything under ./data (see store.js for the layout)
//
// Shared machinery — the whisper child, the Ollama queue, profiles and the
// global model choice — stays single-instance (the CPU is single-tenant);
// everything content-related is per note.
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
import {
  initStore,
  listSessions,
  getSessionMeta,
  createSession,
  renameSession,
  deleteSession,
  saveSessionMeta,
  loadSessionContent,
  saveSessionNotes,
  loadAutoNotes,
  saveAutoNotes,
  appendSessionTranscriptLine,
  clearSessionTranscript,
  sessionPreview,
  sessionTranscriptLines,
  getGlobalConfig,
  saveGlobalConfig,
  ROOT_DIR,
} from './store.js';
import { createAutoNotes } from './autonotes.js';
import { listProfiles, upsertProfile, deleteProfile, getProfile, buildProfileContext } from './profiles.js';

const APP_PORT = Number(process.env.PORT || 3001);
const DIST_DIR = path.join(ROOT_DIR, 'dist');

initStore(); // idempotent v1.0.0 migration + note index + global config
const globalConfig = getGlobalConfig(); // { ollamaModel } — model choice is app-wide

// ---------------------------------------------------------------------------
// Shared state + broadcast
const runtimes = new Map(); // slug -> runtime (below)
let whisperState = { state: 'starting', message: null };
let ollamaOk = true;

function broadcastTo(rt, obj) {
  const data = JSON.stringify(obj);
  for (const ws of rt.clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function broadcastAll(obj) {
  for (const rt of runtimes.values()) broadcastTo(rt, obj);
}

/** The config view one note's client sees: global model + note-scoped bits. */
const cfgView = (rt) => ({
  ollamaModel: globalConfig.ollamaModel,
  autoNotes: rt.meta.autoNotes,
  activeProfileId: rt.meta.activeProfileId,
});

// Serialize every Ollama call (across all notes) so commands and auto-notes
// jobs never overlap on the single-tenant model. `pendingInteractive` counts
// user-triggered commands waiting in the chain so background auto-notes can
// yield to them (see createAutoNotes).
let aiChain = Promise.resolve();
let pendingInteractive = 0;
function enqueue(fn) {
  const next = aiChain.then(fn, fn);
  aiChain = next.catch(() => {});
  return next;
}

// ---------------------------------------------------------------------------
// Per-note runtimes
// A runtime exists while anything references the note — an open tab (WS), an
// in-flight save, a transcription. It owns the in-memory {notes, transcript},
// the per-note PCM queue and the auto-notes job instance. The meta object is
// the live entry inside the store's index (mutations persist via saveSessionMeta).
function ensureRuntime(slug) {
  let rt = runtimes.get(slug);
  if (rt) return rt;
  const meta = getSessionMeta(slug);
  if (!meta) return null;
  const state = loadSessionContent(slug);
  rt = { slug, meta, clients: new Set(), state, pcmQueue: [], transcribing: false, autoNotes: null };
  rt.autoNotes = createAutoNotes({
    getTranscriptText: () => rt.state.transcript.map((l) => l.text).join('\n'),
    // manual notes only — the bullets live in their own file
    getNotesDoc: () => rt.state.notes,
    getConfig: () => cfgView(rt),
    getProfileContext: () => buildProfileContext(getProfile(rt.meta.activeProfileId)),
    enqueue,
    broadcast: (obj) => broadcastTo(rt, obj),
    interactivePending: () => pendingInteractive > 0,
    loadAutoNotes: () => loadAutoNotes(slug),
    saveAutoNotes: (content) => saveAutoNotes(slug, content),
  });
  runtimes.set(slug, rt);
  return rt;
}

/** Tear down a note's runtime: stop its auto-notes timer, evict viewers. */
function dropRuntime(slug) {
  const rt = runtimes.get(slug);
  if (!rt) return;
  rt.autoNotes.stop();
  broadcastTo(rt, { t: 'session-deleted', slug });
  for (const ws of rt.clients) ws.close();
  runtimes.delete(slug);
}

// ---------------------------------------------------------------------------
// whisper.cpp lifecycle (one child process, shared by all notes)
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
    broadcastAll({ t: 'whisper', ...whisperState });
    return;
  }
  const child = await startWhisperServer({ exe, modelPath, onLog: (line) => console.log(`[whisper] ${line}`) });
  child.on('exit', (code) => {
    whisperState = { state: 'exited', message: `whisper-server exited with code ${code}` };
    broadcastAll({ t: 'whisper', ...whisperState });
  });
  try {
    await waitWhisperReady();
    whisperState = { state: 'ready', message: null };
    broadcastAll({ t: 'whisper', ...whisperState });
    console.log(`whisper-server ready (${path.basename(modelPath)})`);
  } catch {
    whisperState = { state: 'error', message: 'whisper-server did not become ready in time' };
    broadcastAll({ t: 'whisper', ...whisperState });
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
// Transcription queue (whisper-server handles one request at a time; each
// note keeps its own queue + busy flag so utterances never interleave)
function enqueueUtterance(rt, samples, spokenAt) {
  rt.pcmQueue.push({ samples, spokenAt });
  processPcmQueue(rt);
}

// Take the queue head and merge in everything else that fits in one ~28 s
// whisper window (with short silence gaps). Each request pays the encoder's
// fixed 30 s-window cost once, so a backlogged queue catches up several times
// faster than real time instead of drifting further behind.
function mergeQueueHead(rt, maxSeconds = 28) {
  const first = rt.pcmQueue.shift();
  const spokenAt = first.spokenAt;
  let samples = first.samples;
  let seconds = samples.length / 16000;
  const parts = [samples];
  while (rt.pcmQueue.length && seconds + 0.25 + rt.pcmQueue[0].samples.length / 16000 <= maxSeconds) {
    const next = rt.pcmQueue.shift();
    parts.push(new Float32Array(4000)); // 0.25 s silence gap
    parts.push(next.samples);
    seconds += 0.25 + next.samples.length / 16000;
  }
  if (parts.length === 1) return { samples, spokenAt };
  console.log(`[transcribe:${rt.slug}] merged ${(parts.length + 1) / 2} utterances into ${seconds.toFixed(1)}s`);
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

async function processPcmQueue(rt) {
  if (rt.transcribing) return;
  rt.transcribing = true;
  if (rt.pcmQueue.length) broadcastTo(rt, { t: 'whisper-busy', busy: true });
  while (rt.pcmQueue.length) {
    const { samples, spokenAt } = mergeQueueHead(rt);
    try {
      // Feed whisper the tail of this note's previous utterance as a prompt so
      // words like names or topics carry over between segments.
      const recent = rt.state.transcript.map((l) => l.text).join('\n').slice(-200);
      const raw = await transcribeWav(encodeWav(samples), { prompt: recent || undefined });
      // whisper sometimes emits stray newlines; transcript lines must be single-line
      const text = raw.replace(/\s+/g, ' ').trim();
      console.log(`[transcribe:${rt.slug}] ${(samples.length / 16000).toFixed(1)}s -> ${text ? JSON.stringify(text) : '(empty)'}`);
      if (text) {
        // timestamp when the words were SPOKEN, not when whisper got to them
        const line = { t: new Date(spokenAt).toTimeString().slice(0, 5), text };
        appendSessionTranscriptLine(rt.slug, line);
        rt.state.transcript.push(line);
        broadcastTo(rt, { t: 'transcript', line });
      }
    } catch (e) {
      console.error(`[transcribe:${rt.slug}] failed:`, e.message);
      broadcastTo(rt, { t: 'error', scope: 'transcribe', message: `Transcription failed: ${e.message}` });
    }
  }
  rt.transcribing = false;
  broadcastTo(rt, { t: 'whisper-busy', busy: false });
}

// ---------------------------------------------------------------------------
// Ollama commands (stream tokens to the requesting client, scoped to their note)
async function runAiCommand({ id, cmd, selection }, ws, rt) {
  const transcript = rt.state.transcript.map((l) => l.text).join('\n');
  const def = COMMANDS[cmd];
  if (!def) {
    ws.send(JSON.stringify({ t: 'ai-error', id, message: `Unknown command: ${cmd}` }));
    return;
  }
  if (def.requiresSelection && !selection?.trim()) {
    ws.send(JSON.stringify({ t: 'ai-error', id, message: 'Select some text first.' }));
    return;
  }
  if (def.requiresTranscript && !transcript.trim()) {
    ws.send(JSON.stringify({ t: 'ai-error', id, message: 'The transcript is empty.' }));
    return;
  }
  if (cmd === 'reread' && !selection?.trim() && !rt.state.notes.trim()) {
    ws.send(JSON.stringify({ t: 'ai-error', id, message: 'Nothing to re-read — the notes are empty.' }));
    return;
  }
  const messages = def.build({
    transcript,
    selection,
    notes: rt.state.notes,
    profileCtx: buildProfileContext(getProfile(rt.meta.activeProfileId)),
  });
  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
  try {
    await chatStream({
      model: globalConfig.ollamaModel,
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

// -- notes (recording sessions) index + CRUD -------------------------------
app.get('/api/sessions', (_req, res) => {
  const sessions = listSessions().map((meta) => ({
    ...meta,
    preview: sessionPreview(meta.slug),
    lines: sessionTranscriptLines(meta.slug),
  }));
  sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)); // recently used first
  res.json({ sessions });
});

app.post('/api/sessions', (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ message: 'title required' });
  const session = createSession(title.slice(0, 120));
  res.status(201).json({ session });
});

app.get('/api/sessions/:slug', (req, res) => {
  const meta = getSessionMeta(req.params.slug);
  if (!meta) return res.status(404).json({ message: 'unknown session' });
  res.json({ session: { ...meta } });
});

app.patch('/api/sessions/:slug', (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ message: 'title required' });
  const meta = renameSession(req.params.slug, title.slice(0, 120));
  if (!meta) return res.status(404).json({ message: 'unknown session' });
  const rt = runtimes.get(meta.slug);
  if (rt) broadcastTo(rt, { t: 'session-renamed', title: meta.title }); // update the open tab
  res.json({ session: { ...meta } });
});

app.delete('/api/sessions/:slug', (req, res) => {
  if (!getSessionMeta(req.params.slug)) return res.status(404).json({ message: 'unknown session' });
  dropRuntime(req.params.slug); // stop the auto-notes timer, tell + evict viewers
  deleteSession(req.params.slug);
  res.json({ ok: true });
});

// -- models / config / profiles ---------------------------------------------
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

app.get('/api/config', (_req, res) => {
  res.json({ config: globalConfig, whisper: whisperState, ollama: ollamaOk });
});

app.post('/api/config', (req, res) => {
  const { ollamaModel, autoNotes: enabled, activeProfileId } = req.body || {};
  // the model is app-wide; the toggle + active profile belong to one note,
  // selected with ?session=<slug> from that note's page
  if (typeof ollamaModel === 'string') {
    globalConfig.ollamaModel = ollamaModel;
    saveGlobalConfig();
    for (const rt of runtimes.values()) broadcastTo(rt, { t: 'config', config: cfgView(rt) });
  }
  const slug = req.query.session;
  if (slug) {
    const rt = ensureRuntime(slug);
    if (rt) {
      if (typeof enabled === 'boolean') rt.meta.autoNotes = enabled;
      if (typeof activeProfileId === 'string' || activeProfileId === null) rt.meta.activeProfileId = activeProfileId;
      saveSessionMeta();
      broadcastTo(rt, { t: 'config', config: cfgView(rt) });
    }
  }
  res.json({ config: globalConfig });
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
  // a deleted profile must not stay referenced by any note
  for (const meta of listSessions()) {
    if (meta.activeProfileId === req.params.id) meta.activeProfileId = null;
  }
  saveSessionMeta();
  for (const rt of runtimes.values()) broadcastTo(rt, { t: 'config', config: cfgView(rt) });
  res.json({ ok: true });
});

// -- per-note content (scoped with ?session=<slug>) -------------------------
app.post('/api/notes', (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ message: 'text required' });
  const rt = ensureRuntime(req.query.session);
  if (!rt) return res.status(404).json({ message: 'unknown session' });
  // sanitizes any embedded region — notes.md is manual-only; memory matches file
  rt.state.notes = saveSessionNotes(rt.slug, text);
  res.json({ ok: true });
});

app.post('/api/transcript/clear', (req, res) => {
  const rt = ensureRuntime(req.query.session);
  if (!rt) return res.status(404).json({ message: 'unknown session' });
  clearSessionTranscript(rt.slug);
  rt.state.transcript = [];
  rt.autoNotes.reset();
  broadcastTo(rt, { t: 'transcript-cleared' });
  res.json({ ok: true });
});

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  // SPA: / serves the dashboard, /<slug> serves the same app (routed client-side)
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')));
}

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// WebSocket endpoint: /ws?session=<slug> — bound to one note at upgrade time
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const { pathname, searchParams } = new URL(req.url, 'http://x');
  if (pathname !== '/ws') return socket.destroy();
  const rt = ensureRuntime(String(searchParams.get('session') || ''));
  if (!rt) return socket.destroy(); // unknown note — never auto-create on a typo
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, rt));
});

wss.on('connection', (ws, _req, rt) => {
  rt.clients.add(ws);
  rt.autoNotes.start(); // idempotent — ticks while at least one viewer is open

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
      if (samples.length >= 8000) enqueueUtterance(rt, samples, spokenAt); // >=0.5s of 16kHz audio
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
        if (typeof msg.ollamaModel === 'string') {
          globalConfig.ollamaModel = msg.ollamaModel;
          saveGlobalConfig();
          for (const r of runtimes.values()) broadcastTo(r, { t: 'config', config: cfgView(r) });
        }
        if (typeof msg.autoNotes === 'boolean') rt.meta.autoNotes = msg.autoNotes;
        if (typeof msg.activeProfileId === 'string' || msg.activeProfileId === null) {
          rt.meta.activeProfileId = msg.activeProfileId;
        }
        saveSessionMeta();
        broadcastTo(rt, { t: 'config', config: cfgView(rt) });
        break;
      }
      case 'ai': {
        pendingInteractive++;
        enqueue(() => runAiCommand(msg, ws, rt)).then(
          () => pendingInteractive--,
          () => pendingInteractive--
        );
        break;
      }
      case 'autonotes-now': {
        rt.autoNotes.triggerNow();
        break;
      }
      case 'autonotes-rebuild': {
        rt.autoNotes.rebuild();
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    rt.clients.delete(ws);
    if (!rt.clients.size) rt.autoNotes.stop(); // nobody watching — no ticking needed
  });

  // Sync models + config, then send this note's current state.
  (async () => {
    let models = [];
    try {
      models = await listModels();
      ollamaOk = true;
      if (!globalConfig.ollamaModel || !models.includes(globalConfig.ollamaModel)) {
        globalConfig.ollamaModel = models[0] || null;
        saveGlobalConfig();
      }
    } catch {
      ollamaOk = false;
    }
    ws.send(
      JSON.stringify({
        t: 'init',
        title: rt.meta.title,
        notes: rt.state.notes,
        autoNotes: rt.autoNotes.snapshot(),
        transcript: rt.state.transcript,
        config: cfgView(rt),
        profiles: listProfiles(),
        models,
        whisper: whisperState,
        ollama: ollamaOk,
      })
    );
  })();
});

// ---------------------------------------------------------------------------
server.listen(APP_PORT, '127.0.0.1', () => {
  console.log(`Live Notes server → http://127.0.0.1:${APP_PORT}`);
  console.log(`${listSessions().length} note(s) in data/sessions.json`);
});
initWhisper();