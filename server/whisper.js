// Spawns whisper.cpp's built-in HTTP server (whisper-server.exe) and exposes a
// tiny client for it: PCM -> WAV -> POST /inference -> text.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const WHISPER_HOST = process.env.WHISPER_HOST || '127.0.0.1';
export const WHISPER_PORT = Number(process.env.WHISPER_PORT || 1782);
// The actual port is picked dynamically at spawn time to avoid conflicts.
let activePort = WHISPER_PORT;
const baseUrl = () => `http://${WHISPER_HOST}:${activePort}`;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, WHISPER_HOST, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export function findWhisperServerExe(root) {
  const binDir = path.join(root, 'bin');
  if (!existsSync(binDir)) return null;
  const tryPath = (p) => (existsSync(p) ? p : null);
  const direct = tryPath(path.join(binDir, 'whisper-server.exe'));
  if (direct) return direct;
  for (const entry of readdirSync(binDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const nested = tryPath(path.join(binDir, entry.name, 'whisper-server.exe'));
      if (nested) return nested;
    }
  }
  return null;
}

// Quality-ranked ggml models (best first) the server auto-picks from ./models
// when no env override is set — downloading a better model is all an upgrade
// takes; restart the app and the best one present wins.
const PREFERRED_MODELS = [
  'ggml-large-v3-turbo-q8_0.bin',
  'ggml-large-v3-turbo-q5_0.bin',
  'ggml-large-v3-turbo.bin',
  'ggml-medium.en.bin',
  'ggml-small.en.bin',
  'ggml-base.en.bin',
  'ggml-base.en-q5_1.bin',
  'ggml-tiny.en.bin',
];

export function defaultModelPath(root) {
  const modelsDir = path.join(root, 'models');
  if (process.env.WHISPER_MODEL_PATH) return process.env.WHISPER_MODEL_PATH;
  if (process.env.WHISPER_MODEL) return path.join(modelsDir, process.env.WHISPER_MODEL);
  if (existsSync(modelsDir)) {
    for (const name of PREFERRED_MODELS) {
      const candidate = path.join(modelsDir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return path.join(modelsDir, 'ggml-base.en-q5_1.bin'); // the setup default
}

export async function startWhisperServer({ exe, modelPath, onLog }) {
  const threads = Math.max(4, Math.floor(os.cpus().length / 2));
  activePort = await findFreePort();
  const child = spawn(
    exe,
    ['-m', modelPath, '--host', WHISPER_HOST, '--port', String(activePort), '-t', String(threads)],
    { cwd: path.dirname(exe), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  const log = (stream) =>
    stream.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) onLog?.(line.trim());
      }
    });
  log(child.stdout);
  log(child.stderr);
  return child;
}

/** Resolves once the whisper-server HTTP port is accepting connections. */
export function waitWhisperReady({ timeoutMs = 120000 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(activePort, WHISPER_HOST);
      socket.setTimeout(2000);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error('whisper-server did not start in time'));
        else setTimeout(attempt, 750);
      });
      socket.once('timeout', () => {
        socket.destroy();
        setTimeout(attempt, 750);
      });
    };
    attempt();
  });
}

/** Float32 PCM samples at sampleRate -> 16-bit mono WAV buffer. */
export function encodeWav(float32, sampleRate = 16000) {
  const n = float32.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buf;
}

/** Send a WAV buffer to whisper-server, return the transcribed text. */
export async function transcribeWav(wavBuffer, { prompt } = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'utterance.wav');
  fd.append('response_format', 'json');
  fd.append('temperature', '0.0');
  if (prompt) fd.append('prompt', prompt);
  const res = await fetch(`${baseUrl()}/inference`, { method: 'POST', body: fd });
  if (!res.ok) {
    throw new Error(`whisper-server /inference failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();
  return (json.text ?? json.transcription ?? '').toString().trim();
}