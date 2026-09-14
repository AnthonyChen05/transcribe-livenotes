// Multi-session persistence. Every "note" is its own recording session with
// its own transcript, notes document and AI bullets:
//
//   data/sessions.json     index: [{slug, title, createdAt, updatedAt,
//                                   autoNotes, activeProfileId}]
//   data/sessions/<slug>/  one directory per note:
//     notes.md             the user's manual notes (browser-authoritative)
//     autonotes.md         the server-owned AI bullets
//     transcript.md        history, one "- [HH:MM] text" line per utterance
//     latest.txt           plain-text transcript mirror for other tools
//   data/config.json       global config — just the Ollama model choice
//   data/profiles.json     profiles (global, shared across notes)
//
// The auto-notes toggle and the active profile are PER NOTE (each note is a
// different event). The v1.0.0 flat layout (those four files directly in
// data/) migrates itself into a note named "default" on first boot —
// idempotent per file, so an interrupted move resumes cleanly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const AUTO_NOTES_START = '<!-- live-notes:start -->';
export const AUTO_NOTES_END = '<!-- live-notes:end -->';

const DEFAULT_NOTES = `# Live notes

## My notes

`;

// URL paths the catch-all never reaches — a note may not take these slugs.
const RESERVED_SLUGS = new Set(['api', 'ws']);

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ------------------------------------------------------------------ helpers

const sessionDir = (slug) => path.join(SESSIONS_DIR, slug);
const sessionFile = (slug, name) => path.join(sessionDir(slug), name);

function slugify(title) {
  const s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'note';
}

/** Read a transcript.md into [{t: 'HH:MM', text}] lines. */
function parseTranscript(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^- \[(\d{2}:\d{2})\] (.*)$/);
    if (m) out.push({ t: m[1], text: m[2] });
  }
  return out;
}

// ------------------------------------------------------------------- index

let index = []; // session metas; runtime objects hold references to these

function saveIndex() {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(index, null, 2));
}

function loadIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    index = Array.isArray(parsed) ? parsed.filter((s) => s && typeof s.slug === 'string') : [];
  } catch {
    index = [];
  }
}

export const listSessions = () => index;
export const getSessionMeta = (slug) => index.find((s) => s.slug === slug) || null;

export function createSession(title) {
  const t = String(title || '').trim().slice(0, 120) || 'Untitled note';
  const base = slugify(t);
  const taken = new Set(index.map((s) => s.slug));
  let slug = base;
  let n = 2;
  while (taken.has(slug) || RESERVED_SLUGS.has(slug)) slug = `${base}-${n++}`;
  const now = new Date().toISOString();
  const meta = { slug, title: t, createdAt: now, updatedAt: now, autoNotes: true, activeProfileId: null };
  index.push(meta);
  saveIndex();
  fs.mkdirSync(sessionDir(slug), { recursive: true });
  fs.writeFileSync(sessionFile(slug, 'notes.md'), DEFAULT_NOTES);
  fs.writeFileSync(sessionFile(slug, 'transcript.md'), '');
  fs.writeFileSync(sessionFile(slug, 'latest.txt'), '');
  return meta;
}

export function renameSession(slug, title) {
  const meta = getSessionMeta(slug);
  if (!meta) return null;
  const t = String(title || '').trim().slice(0, 120);
  if (!t || t === meta.title) return meta;
  meta.title = t;
  meta.updatedAt = new Date().toISOString(); // a rename shows in "updated"
  saveIndex();
  return meta;
}

/** Stamp a note as changed (called by every content write). */
export function touchSession(slug) {
  const meta = getSessionMeta(slug);
  if (meta) {
    meta.updatedAt = new Date().toISOString();
    saveIndex();
  }
}

export function deleteSession(slug) {
  const meta = getSessionMeta(slug);
  if (!meta) return false;
  fs.rmSync(sessionDir(slug), { recursive: true, force: true });
  index = index.filter((s) => s.slug !== slug);
  saveIndex();
  return true;
}

export function saveSessionMeta() {
  saveIndex();
}

// -------------------------------------------------------- per-note content

export function loadSessionContent(slug) {
  const notesFile = sessionFile(slug, 'notes.md');
  const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : DEFAULT_NOTES;
  return { notes, transcript: parseTranscript(sessionFile(slug, 'transcript.md')) };
}

/** Sanitize (strip any legacy embedded region) and persist the manual notes. */
export function saveSessionNotes(slug, text) {
  const { manual } = splitNotesDoc(text);
  fs.mkdirSync(sessionDir(slug), { recursive: true });
  fs.writeFileSync(sessionFile(slug, 'notes.md'), manual);
  touchSession(slug);
  return manual;
}

/** Load the server-owned auto-notes bullets and when they were last written. */
export function loadAutoNotes(slug) {
  const file = sessionFile(slug, 'autonotes.md');
  if (!fs.existsSync(file)) return { content: '', updated: null };
  return {
    content: fs.readFileSync(file, 'utf8').trim(),
    updated: new Date(fs.statSync(file).mtime).toTimeString().slice(0, 5),
  };
}

export function saveAutoNotes(slug, content) {
  fs.mkdirSync(sessionDir(slug), { recursive: true });
  fs.writeFileSync(sessionFile(slug, 'autonotes.md'), content ? content.trim() + '\n' : '');
  touchSession(slug);
}

export function appendSessionTranscriptLine(slug, line) {
  fs.mkdirSync(sessionDir(slug), { recursive: true });
  fs.appendFileSync(sessionFile(slug, 'transcript.md'), `- [${line.t}] ${line.text}\n`);
  fs.appendFileSync(sessionFile(slug, 'latest.txt'), line.text + '\n');
  touchSession(slug);
}

export function clearSessionTranscript(slug) {
  fs.mkdirSync(sessionDir(slug), { recursive: true });
  fs.writeFileSync(sessionFile(slug, 'transcript.md'), '');
  fs.writeFileSync(sessionFile(slug, 'latest.txt'), '');
  touchSession(slug);
}

/** First ~140 chars of a note for the dashboard card. */
export function sessionPreview(slug) {
  const read = (name) => {
    try {
      return fs.readFileSync(sessionFile(slug, name), 'utf8');
    } catch {
      return '';
    }
  };
  let text = read('notes.md');
  if (!text.trim()) text = read('autonotes.md');
  return text.replace(/[#*_`>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
}

export function sessionTranscriptLines(slug) {
  try {
    return fs
      .readFileSync(sessionFile(slug, 'transcript.md'), 'utf8')
      .split('\n')
      .filter((l) => /^- \[/.test(l)).length;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------ global config

let globalConfig = { ollamaModel: null };

export const getGlobalConfig = () => globalConfig;

export function saveGlobalConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ollamaModel: globalConfig.ollamaModel ?? null }, null, 2));
}

// --------------------------------------------------------------- migration

/**
 * Split a legacy notes document into its auto-notes region content (between
 * the markers) and the manual portion. The markers no longer occur in
 * notes.md — this sanitizes saves from out-of-date clients that still embed
 * a region.
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
    .replaceAll(AUTO_NOTES_START, '')
    .replaceAll(AUTO_NOTES_END, '')
    .trim();
  return { region, manual };
}

/**
 * Boot: migrate any v1.0.0 flat files into the "default" note, seed the index
 * for it, and load the global config. Idempotent — moves only files that are
 * still at the old location and whose destination is free.
 */
export function initStore() {
  // 1. move flat files into sessions/default (per-file idempotent)
  const LEGACY = ['notes.md', 'autonotes.md', 'transcript.md', 'latest.txt'];
  for (const name of LEGACY) {
    const src = path.join(DATA_DIR, name);
    if (fs.existsSync(src) && !fs.existsSync(sessionFile('default', name))) {
      fs.mkdirSync(sessionDir('default'), { recursive: true });
      fs.renameSync(src, sessionFile('default', name));
      console.log(`[store] migrated ${name} -> sessions/default/`);
    }
  }
  // 2. load (or create) the note index
  loadIndex();
  if (!fs.existsSync(SESSIONS_FILE)) saveIndex();
  // an upgraded v1.0.0 install has the default directory but no index entry
  if (!index.some((s) => s.slug === 'default') && fs.existsSync(sessionDir('default'))) {
    let legacy = {};
    try {
      legacy = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
      /* fresh install or unreadable config — defaults apply */
    }
    let oldest = null;
    let newest = null;
    for (const name of LEGACY) {
      try {
        const m = fs.statSync(sessionFile('default', name)).mtimeMs;
        if (!oldest || m < oldest) oldest = m;
        if (!newest || m > newest) newest = m;
      } catch {
        /* file absent */
      }
    }
    index.push({
      slug: 'default',
      title: 'Default',
      createdAt: new Date(oldest || Date.now()).toISOString(),
      updatedAt: new Date(newest || Date.now()).toISOString(),
      autoNotes: typeof legacy.autoNotes === 'boolean' ? legacy.autoNotes : true,
      activeProfileId: typeof legacy.activeProfileId === 'string' ? legacy.activeProfileId : null,
    });
    saveIndex();
    console.log('[store] created index entry for migrated note "default"');
  }
  // 3. global config — model choice only; the toggle/profile moved onto notes
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (typeof parsed.ollamaModel === 'string') globalConfig.ollamaModel = parsed.ollamaModel;
  } catch {
    /* defaults */
  }
}

export const ROOT_DIR = ROOT;