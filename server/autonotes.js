// Background "live notes" job: watches the transcript and periodically asks
// Ollama for the NEW points to append to the auto-notes summary. The bullets
// are SERVER-OWNED and live in their own file (data/autonotes.md) — never
// inside the user's notes document. The UI renders the two side by side, but
// they cannot contaminate each other, so the accumulated bullets can never
// pick up client-generated headings or manual edits. The section is
// append-only: it grows as the session progresses and is never rewritten.
// All Ollama work is funneled through `enqueue` so on-demand commands and
// this job never run concurrently (the local model is single-tenant anyway).
import { chatStream, autoNotesMessages, rebuildAutoNotesMessages } from './ollama.js';

const TICK_MS = 20000;
const MIN_NEW_CHARS = 250; // new transcript material required between runs
const MAX_NEW_MATERIAL = 6000; // cap on the transcript chunk sent per update
const MAX_REBUILD_MATERIAL = 12000; // cap on the transcript for a full rebuild

export function createAutoNotes({
  getTranscriptText,
  getNotesDoc,
  getConfig,
  getProfileContext,
  enqueue,
  broadcast,
  interactivePending,
  loadAutoNotes,
  saveAutoNotes,
}) {
  let timer = null;
  let running = false;
  let tickQueued = false; // a scheduled tick is already waiting in the chain
  let rebuildQueued = false; // a rebuild request is already queued or running
  const boot = loadAutoNotes();
  let content = boot.content; // the accumulated bullets so far
  let updatedAt = boot.updated; // HH:MM of the last change — the only timestamp shown
  // Boot state: the persisted bullets already reflect the persisted
  // transcript, so mark the transcript as consumed — a restart must never
  // re-derive the previous session's bullets. Only genuinely new speech
  // generates new bullets.
  let lastDigestLen = getTranscriptText().length; // transcript chars already incorporated

  async function tick({ force = false } = {}) {
    const cfg = getConfig();
    if (running || !cfg.autoNotes || !cfg.ollamaModel) return;
    // Scheduled runs get out of the way while toolbar commands (summarize,
    // polish, re-read, …) are waiting in the chain — a background refresh
    // must never starve what the user explicitly asked for. Explicit
    // "Update now" clicks keep their place in line.
    if (!force && interactivePending && interactivePending()) return;
    const transcript = getTranscriptText();
    if (!transcript.trim()) return;
    const newMaterial = transcript.slice(lastDigestLen).trim();
    if (!newMaterial) return;
    if (!force && newMaterial.length < MIN_NEW_CHARS) return;

    running = true;
    console.log(`[autonotes] job started (${newMaterial.length} new transcript chars)`);
    broadcast({ t: 'autonotes-busy', busy: true });
    try {
      let acc = '';
      let lastSent = 0;
      const soFar = () => (content ? content + '\n' : '') + acc;
      await chatStream({
        model: cfg.ollamaModel,
        messages: autoNotesMessages({
          existing: content,
          // the user's manual notes as context — new bullets must not
          // duplicate what is already written there
          manualNotes: getNotesDoc(),
          newMaterial: newMaterial.slice(-MAX_NEW_MATERIAL),
          profileCtx: getProfileContext(),
        }),
        onToken: (tok) => {
          acc += tok;
          updatedAt = new Date().toTimeString().slice(0, 5);
          const now = Date.now();
          if (now - lastSent > 300) {
            lastSent = now;
            broadcast({ t: 'autonotes', content: soFar(), updated: updatedAt });
          }
        },
      });
      const delta = acc.trim();
      // notes only ever grow: append, never rewrite
      if (delta) {
        content = content ? content + '\n' + delta : delta;
        updatedAt = new Date().toTimeString().slice(0, 5);
        saveAutoNotes(content);
        console.log(`[autonotes] +${delta.length} chars -> ${content.length} total`);
      }
      lastDigestLen = transcript.length; // material consumed either way
      broadcast({ t: 'autonotes', content, updated: updatedAt });
    } catch (e) {
      broadcast({ t: 'error', scope: 'autonotes', message: String(e.message || e) });
    } finally {
      running = false;
      broadcast({ t: 'autonotes-busy', busy: false });
    }
  }

  /**
   * Full rebuild: the ENTIRE transcript is re-summarized from scratch and the
   * accumulated bullets are replaced. The old content stays until the new set
   * is ready — a failed rebuild never blanks the panel.
   */
  async function doRebuild() {
    const cfg = getConfig();
    if (running || !cfg.autoNotes || !cfg.ollamaModel) return;
    const transcript = getTranscriptText();
    if (!transcript.trim()) return;
    running = true;
    console.log(`[autonotes] rebuild started (${transcript.length} transcript chars)`);
    broadcast({ t: 'autonotes-busy', busy: true });
    try {
      let acc = '';
      let lastSent = 0;
      const prev = content;
      await chatStream({
        model: cfg.ollamaModel,
        messages: rebuildAutoNotesMessages({
          transcript: transcript.slice(-MAX_REBUILD_MATERIAL),
          manualNotes: getNotesDoc(),
          profileCtx: getProfileContext(),
        }),
        onToken: (tok) => {
          acc += tok;
          updatedAt = new Date().toTimeString().slice(0, 5);
          // stream the candidate replacement into the panel as it builds
          const now = Date.now();
          if (now - lastSent > 300) {
            lastSent = now;
            broadcast({ t: 'autonotes', content: acc, updated: updatedAt });
          }
        },
      });
      const fresh = acc.trim();
      // only replace on success — an empty reply keeps the previous bullets
      if (fresh) {
        content = fresh;
        updatedAt = new Date().toTimeString().slice(0, 5);
        saveAutoNotes(content);
        console.log(`[autonotes] rebuilt: ${content.length} chars (was ${prev.length})`);
      }
      lastDigestLen = transcript.length; // the whole transcript is now incorporated
      broadcast({ t: 'autonotes', content, updated: updatedAt });
    } catch (e) {
      broadcast({ t: 'autonotes', content, updated: updatedAt }); // restore the old view
      broadcast({ t: 'error', scope: 'autonotes', message: `Rebuild failed: ${e.message || e}` });
    } finally {
      running = false;
      broadcast({ t: 'autonotes-busy', busy: false });
    }
  }

  return {
    start() {
      // Never let scheduled ticks pile up behind a slow or hung job — if one
      // is already queued, skip this beat. The next interval fires 20 s later,
      // so nothing is lost; only the backlog spam disappears.
      if (!timer)
        timer = setInterval(() => {
          if (tickQueued) return;
          tickQueued = true;
          enqueue(() => tick()).finally(() => {
            tickQueued = false;
          });
        }, TICK_MS);
    },
    triggerNow() {
      enqueue(() => tick({ force: true }));
    },
    rebuild() {
      // Collapse duplicates: while a rebuild is queued or running, further
      // clicks are no-ops — the in-flight one already covers the latest
      // transcript. The button therefore never needs to disable itself on
      // job activity; it only grays out when there is nothing to rebuild.
      if (rebuildQueued) return;
      rebuildQueued = true;
      enqueue(() => doRebuild()).finally(() => {
        rebuildQueued = false;
      });
    },
    reset() {
      lastDigestLen = 0;
      content = '';
      updatedAt = null;
      saveAutoNotes('');
    },
    /** Current state, sent to new clients in their init message. */
    snapshot() {
      return { content, updated: updatedAt, busy: running };
    },
  };
}