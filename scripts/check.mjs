// One-shot setup doctor. Verifies everything the app needs to run and prints
// the exact command that fixes whatever is missing:
//   Node >= 20, whisper.cpp binary, a Whisper model, a reachable Ollama with
//   at least one model, a writable data/ dir, and free ports.
//
// Run standalone with `npm run check`, or automatically before every
// `npm run dev` / `npm start` (predev/prestart hooks) so a fresh install
// stops with instructions instead of a confusing "whisper offline" pill.
//
// Severity: a FAIL (exit 1) means the app cannot do its job — only missing
// Node/whisper/model assets or an occupied app port. Ollama problems are
// warnings: the app still runs for note-taking, and the topbar shows the
// "ollama offline" pill until it is fixed.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Reuse the server's own pickers so this check can never disagree with what
// the app actually launches (model ranking, env overrides, exe lookup).
import { findWhisperServerExe, defaultModelPath } from '../server/whisper.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const APP_PORT = Number(process.env.PORT || 3001);
const DEV_PORT = Number(process.env.DEV_PORT || 5173);

let fails = 0;
let warns = 0;
const SYM = { ok: '✓', warn: '⚠', fail: '✗' };

function row(name, status, detail) {
  console.log(`${name.padEnd(15)}${SYM[status]}  ${detail}`);
  if (status === 'fail') fails++;
  if (status === 'warn') warns++;
}
// indented follow-up line (fix/tip), aligned under the detail column
function note(text) {
  console.log(`${' '.repeat(17)}${text}`);
}

function human(bytes) {
  return bytes > 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(0) + ' MB' : (bytes / 1024).toFixed(0) + ' KB';
}

function portFree(port) {
  // Vite binds ::1 (IPv6) while the app server binds 127.0.0.1 (IPv4) — a
  // port is only free if BOTH stacks accept the bind.
  const bind = (host) =>
    new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, host, () => srv.close(() => resolve(true)));
    });
  return Promise.all([bind('127.0.0.1'), bind('::1')]).then(([v4, v6]) => v4 && v6);
}

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

console.log('\nLive Notes — setup check\n');

// ------------------------------------------------------------------- Node.js
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) row('Node.js', 'ok', `v${process.versions.node}`);
else {
  row('Node.js', 'fail', `v${process.versions.node} — Node 20 or newer is required`);
  note('fix: install Node >= 20 from https://nodejs.org');
}

// ------------------------------------------------------------------ platform
if (process.platform === 'win32' && process.arch === 'x64') {
  row('Platform', 'ok', 'Windows x64 (matches the prebuilt whisper.cpp binaries)');
} else {
  row(
    'Platform',
    'warn',
    `${process.platform}/${process.arch} — npm run setup downloads Windows x64 binaries; on other systems build whisper-server from source into ./bin (see SETUP.md)`
  );
}

// ------------------------------------------------- whisper-server executable
const exe = findWhisperServerExe(ROOT);
if (exe) row('whisper.cpp', 'ok', path.relative(ROOT, exe));
else {
  row('whisper.cpp', 'fail', 'bin/whisper-server.exe not found');
  note('fix: npm run setup');
}

// --------------------------------------------------------------- STT model
// Same pick the server will make (env overrides first, then quality-ranked).
const modelPath = defaultModelPath(ROOT);
const modelName = path.basename(modelPath);
let modelOk = false;
try {
  if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 1024 * 1024) {
    modelOk = true;
    row('Whisper model', 'ok', `${modelName} (${human(fs.statSync(modelPath).size)}) — this is what the server will use`);
    if (/^ggml-(tiny|base)/.test(modelName)) {
      note(`tip: for noticeably better accuracy (especially accents), upgrade:`);
      note('     npm run setup -- ggml-large-v3-turbo-q5_0.bin   (547 MB, still real-time on CPU)');
    }
  }
} catch {
  /* fall through to the failure row */
}
if (!modelOk) {
  row('Whisper model', 'fail', `${modelName} not found in ./models (or download incomplete)`);
  note('fix: npm run setup');
}
try {
  const modelsDir = path.join(ROOT, 'models');
  const extras = fs
    .readdirSync(modelsDir)
    .filter((f) => f.endsWith('.bin') && f !== modelName && fs.statSync(path.join(modelsDir, f)).size > 1024 * 1024);
  if (extras.length) {
    const list = extras.map((f) => `${f} (${human(fs.statSync(path.join(modelsDir, f)).size)})`).join(', ');
    note(`also present: ${list}`);
  }
} catch {
  /* models dir missing — the failure row above already covers it */
}

// ------------------------------------------------------------ Ollama + models
let tags = null;
try {
  const json = await fetchJson(`${OLLAMA_URL}/api/tags`, 4000);
  tags = (json.models || []).map((m) => m.name);
  row('Ollama', 'ok', `reachable at ${OLLAMA_URL}`);
} catch {
  row('Ollama', 'warn', `not reachable at ${OLLAMA_URL} — AI features will be disabled until it runs`);
  note('fix: install from https://ollama.com/download, then start it with:  ollama serve');
}
if (tags) {
  if (tags.length) {
    row('Ollama models', 'ok', `${tags.length} installed (${tags.join(', ')})`);
  } else {
    row('Ollama models', 'warn', 'none installed — every AI feature needs at least one');
    note('fix: ollama pull qwen2.5:3b   (see SETUP.md for model advice)');
  }
  // The app persists the user's model choice in data/config.json; if that
  // model has since been removed, the app auto-falls back — say so here.
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
    if (cfg.ollamaModel && !tags.includes(cfg.ollamaModel)) {
      row('Config', 'warn', `configured model "${cfg.ollamaModel}" is not installed`);
      note(`fix: ollama pull ${cfg.ollamaModel} — or the app will switch to "${tags[0]}" automatically`);
    }
  } catch {
    /* no config yet (fresh install) — nothing to check */
  }
}

// ------------------------------------------------------------ data directory
const dataDir = path.join(ROOT, 'data');
try {
  fs.mkdirSync(dataDir, { recursive: true });
  const probe = path.join(dataDir, '.check-probe');
  fs.writeFileSync(probe, 'ok');
  fs.rmSync(probe);
  row('Data directory', 'ok', 'data/ is writable');
} catch (e) {
  row('Data directory', 'fail', `data/ is not writable (${e.message})`);
  note('fix: check folder permissions for the project directory');
}

// -------------------------------------------------------------------- ports
if (await portFree(APP_PORT)) {
  row('App port', 'ok', `${APP_PORT} free`);
} else {
  let health = null;
  try {
    health = await fetchJson(`http://127.0.0.1:${APP_PORT}/api/health`, 1500);
  } catch {
    /* something else is squatting on the port */
  }
  if (health?.ok) {
    row('App port', 'fail', `${APP_PORT} — Live Notes is already running (whisper: ${health.whisper?.state || '?'})`);
    note(`fix: open http://127.0.0.1:${APP_PORT} instead, or stop the other instance first`);
  } else {
    row('App port', 'fail', `${APP_PORT} is used by another process`);
    note(`fix: stop it, or run on another port — see "Port busy" in SETUP.md`);
  }
}
if (await portFree(DEV_PORT)) {
  row('Dev port', 'ok', `${DEV_PORT} free`);
} else {
  row('Dev port', 'warn', `${DEV_PORT} is in use — Vite will fall back to the next free port`);
}

// ------------------------------------------------------------------ verdict
console.log('');
if (fails) {
  console.log(`✗ ${fails} problem${fails === 1 ? '' : 's'} found — each ✗ row above has a fix: line. Re-run after fixing:  npm run check`);
  process.exit(1);
}
if (warns) console.log(`⚠ ${warns} warning${warns === 1 ? '' : 's'} — the app will run anyway; see above.`);
console.log('✓ Everything is in place — start the app with:  npm run dev');