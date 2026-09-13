// Downloads the two local assets this app needs:
//   1. whisper.cpp prebuilt Windows x64 binaries (whisper-server.exe + DLLs) -> ./bin
//   2. a Whisper ggml model                                                -> ./models
//
// Re-run any time; existing files are skipped. Download a different/better
// model with either form:
//   npm run setup -- ggml-large-v3-turbo-q5_0.bin
//   WHISPER_MODEL=ggml-small.en.bin npm run setup
// (any file from https://huggingface.co/ggerganov/whisper.cpp/tree/main)
import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN_DIR = path.join(ROOT, 'bin');
const MODELS_DIR = path.join(ROOT, 'models');

const WHISPER_RELEASE = process.env.WHISPER_RELEASE || 'b4938';
const WHISPER_ZIP_URL =
  process.env.WHISPER_ZIP_URL ||
  `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}/whisper-bin-x64.zip`;
const MODEL_NAME = process.argv[2] || process.env.WHISPER_MODEL || 'ggml-base.en-q5_1.bin';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`;

function human(bytes) {
  return bytes > 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : (bytes / 1024).toFixed(0) + ' KB';
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  let lastLog = 0;
  const out = openSync(dest, 'w');
  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      writeFileSync(out, chunk);
      done += chunk.length;
      const now = Date.now();
      if (total && now - lastLog > 1000) {
        lastLog = now;
        process.stdout.write(`  ${human(done)} / ${human(total)}\r`);
      }
    }
  } finally {
    closeSync(out);
  }
  console.log(`  downloaded ${human(done)}`);
}

function extractZipWindows(zipPath, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', 'Expand-Archive', '-LiteralPath', JSON.stringify(zipPath), '-DestinationPath', JSON.stringify(outDir), '-Force'],
    { stdio: 'ignore' }
  );
  if (result.status !== 0) throw new Error('Expand-Archive failed (powershell) — extract the zip manually into ./bin');
}

function findRecursively(dir, name, depth = 3) {
  if (depth < 0 || !existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name) return full;
    if (entry.isDirectory()) {
      const found = findRecursively(full, name, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

async function setupBinaries() {
  const exePath = findRecursively(BIN_DIR, 'whisper-server.exe', 2);
  if (exePath) {
    console.log(`[1/2] whisper-server.exe already present (${exePath}) — skipping download.`);
    return;
  }
  console.log(`[1/2] Downloading whisper.cpp Windows x64 binaries (${WHISPER_RELEASE})...`);
  const tmp = path.join(os.tmpdir(), `whisper-cpp-${WHISPER_RELEASE}`);
  const zipPath = `${tmp}.zip`;
  await download(WHISPER_ZIP_URL, zipPath);

  console.log('  extracting...');
  const extractDir = path.join(tmp, 'extracted');
  if (process.platform !== 'win32') {
    throw new Error('This app expects the whisper.cpp Windows x64 build. On Linux/macOS, build whisper-server from source and place it in ./bin.');
  }
  extractZipWindows(zipPath, extractDir);

  const serverExe = findRecursively(extractDir, 'whisper-server.exe', 4);
  if (!serverExe) {
    throw new Error('whisper-server.exe not found in the downloaded archive — the release layout may have changed.');
  }
  // Copy the whole folder containing the exe so its DLLs come along.
  const srcDir = path.dirname(serverExe);
  rmSync(BIN_DIR, { recursive: true, force: true });
  mkdirSync(BIN_DIR, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const from = path.join(srcDir, entry);
    const st = statSync(from);
    if (st.isFile()) copyFileSync(from, path.join(BIN_DIR, entry));
  }
  writeFileSync(
    path.join(BIN_DIR, 'SOURCE.txt'),
    `Downloaded from ${WHISPER_ZIP_URL} on ${new Date().toISOString()}\n`
  );
  rmSync(tmp, { recursive: true, force: true });
  console.log(`  whisper-server.exe ready at ${path.join(BIN_DIR, 'whisper-server.exe')}`);
}

async function setupModel() {
  const modelPath = path.join(MODELS_DIR, MODEL_NAME);
  if (existsSync(modelPath) && statSync(modelPath).size > 1024 * 1024) {
    console.log(`[2/2] model ${MODEL_NAME} already present — skipping download.`);
    return modelPath;
  }
  console.log(`[2/2] Downloading Whisper model ${MODEL_NAME} from HuggingFace...`);
  mkdirSync(MODELS_DIR, { recursive: true });
  const part = modelPath + '.part';
  await download(MODEL_URL, part);
  // ggml models start with magic "ggml" (old format) or "lmgg" (new format).
  const fd = openSync(part, 'r');
  const head = Buffer.alloc(4);
  readSync(fd, head, 0, 4, 0);
  closeSync(fd);
  if (head.toString() !== 'ggml' && head.toString() !== 'lmgg') {
    rmSync(part, { force: true });
    throw new Error('Downloaded file is not a valid ggml model — try a different WHISPER_MODEL.');
  }
  renameSync(part, modelPath);
  console.log(`  model ready at ${modelPath}`);
  return modelPath;
}

console.log('Live Notes — local asset setup');
await setupBinaries();
await setupModel();
// Finish by verifying the whole environment (Ollama, models, ports, …) so a
// successful setup ends with a green check, not just a download.
const check = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check.mjs')], { stdio: 'inherit' });
if (check.status !== 0) process.exit(check.status ?? 1);