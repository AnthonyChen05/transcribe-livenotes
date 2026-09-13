// Simple on-disk persistence for the session: notes.md, autonotes.md,
// transcript.md and config.json all live in ./data (gitignored).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const NOTES_FILE = path.join(DATA_DIR, 'notes.md');
const AUTONOTES_FILE = path.join(DATA_DIR, 'autonotes.md');
const TRANSCRIPT_FILE = path.join(DATA_DIR, 'transcript.md');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LATEST_FILE = path.join(DATA_DIR, 'latest.txt');

export const AUTO_NOTES_START = '<!-- live-notes:start -->';
export const AUTO_NOTES_END = '<!-- live-notes:end -->';

const DEFAULT_NOTES = `# Live notes

## My notes

`;

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadNotes() {
  if (!fs.existsSync(NOTES_FILE)) {
    fs.writeFileSync(NOTES_FILE, DEFAULT_NOTES);
    return DEFAULT_NOTES;
  }
  const notes = fs.readFileSync(NOTES_FILE, 'utf8');
  // One-time migration: the auto-notes summary used to live inside notes.md
  // between two comment markers. It now has its own file — move any existing
  // region out and leave notes.md holding the user's manual notes only.
  if (notes.includes(AUTO_NOTES_START) && !fs.existsSync(AUTONOTES_FILE)) {
    const { region, manual } = splitNotesDoc(notes);
    fs.writeFileSync(AUTONOTES_FILE, cleanAutoNotesRegion(region));
    fs.writeFileSync(NOTES_FILE, manual);
    return manual;
  }
  return notes;
}

/**
 * The old in-document region accumulated a "## Live notes / _updated HH:MM_"
 * heading on every refresh (a client/server feedback loop). The file keeps the
 * bullets only — the UI shows the single latest update time.
 */
function cleanAutoNotesRegion(region) {
  const cleaned = region
    .split('\n')
    .filter((l) => !/^## Live notes\s*$/.test(l) && !/^_updated [\d:]+_$/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned ? cleaned + '\n' : '';
}

/** Load the server-owned auto-notes bullets and when they were last written. */
export function loadAutoNotes() {
  if (!fs.existsSync(AUTONOTES_FILE)) return { content: '', updated: null };
  return {
    content: fs.readFileSync(AUTONOTES_FILE, 'utf8').trim(),
    updated: new Date(fs.statSync(AUTONOTES_FILE).mtime).toTimeString().slice(0, 5),
  };
}

export function saveAutoNotes(content) {
  fs.writeFileSync(AUTONOTES_FILE, content ? content.trim() + '\n' : '');
}

function loadTranscript() {
  // transcript.md lines look like: "- [14:03] some words"
  if (!fs.existsSync(TRANSCRIPT_FILE)) return [];
  const lines = fs.readFileSync(TRANSCRIPT_FILE, 'utf8').split('\n');
  const out = [];
  for (const line of lines) {
    const m = line.match(/^- \[(\d{2}:\d{2})\] (.*)$/);
    if (m) out.push({ t: m[1], text: m[2] });
  }
  return out;
}

function loadConfig() {
  let config = { ollamaModel: null, autoNotes: true, activeProfileId: null };
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    } catch {
      // corrupted config — fall back to defaults
    }
  }
  return config;
}

/**
 * Split a legacy notes document into its auto-notes region content (between
 * the markers) and the manual portion (everything outside the markers). The
 * markers no longer occur in notes.md — this now serves the boot migration
 * and sanitizes saves from out-of-date clients that still embed a region.
 */
export function splitNotesDoc(notes) {
  const i = notes.indexOf(AUTO_NOTES_START);
  if (i === -1) return { region: '', manual: notes };
  const afterStart = i + AUTO_NOTES_START.length;
  const j = notes.indexOf(AUTO_NOTES_END, afterStart);
  const regionRaw = notes.slice(afterStart, j === -1 ? notes.length : j);
  const regionEnd = j === -1 ? notes.length : j + AUTO_NOTES_END.length;
  const manual = (notes.slice(0, i) + '\n' + notes.slice(regionEnd)).replace(/\n{3,}/g, '\n\n').trim();
  const region = regionRaw
    .replace(/^## Live notes\s*\n/, '')
    .replace(/^_updated [\d:]+_\s*\n/, '')
    // models rewriting the document sometimes echo a stray marker inside the
    // region — markers never legitimately occur there, so strip them
    .replaceAll(AUTO_NOTES_START, '')
    .replaceAll(AUTO_NOTES_END, '')
    .trim();
  return { region, manual };
}

class Store {
  constructor() {
    this.notes = loadNotes();
    this.transcript = loadTranscript();
    this.config = loadConfig();
    this.writeLatest();
  }

  saveNotes(text) {
    // notes.md holds the user's manual notes only — if an out-of-date client
    // still embeds an auto-notes region in the document, strip it before
    // persisting (the bullets live in their own file, server-managed).
    const { manual } = splitNotesDoc(text);
    this.notes = manual;
    fs.writeFileSync(NOTES_FILE, manual);
  }

  // Plain-text mirror of the transcript (no timestamps) at data/latest.txt,
  // rewritten on every change so other tools can read it mid-session.
  writeLatest() {
    const text = this.transcript.map((l) => l.text).join('\n');
    fs.writeFileSync(LATEST_FILE, text ? text + '\n' : '');
  }

  appendTranscriptLine(line) {
    this.transcript.push(line);
    fs.appendFileSync(TRANSCRIPT_FILE, `- [${line.t}] ${line.text}\n`);
    this.writeLatest();
  }

  clearTranscript() {
    this.transcript = [];
    fs.writeFileSync(TRANSCRIPT_FILE, '');
    this.writeLatest();
  }

  saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
  }
}

export const store = new Store();
export const ROOT_DIR = ROOT;