// Background "live notes" job: watches the transcript and periodically asks
// Ollama for the NEW points to append to the auto-notes summary. Each note
// (recording session) owns one instance; its bullets are SERVER-OWNED and
// live in their own file (data/sessions/<slug>/autonotes.md) — never
// inside the user's notes document. The UI renders the two side by side, but
// they cannot contaminate each other, so the accumulated bullets can never
// pick up client-generated headings or manual edits. The section is
// append-only: it grows as the session progresses and is never rewritten.
// All Ollama work is funneled through `enqueue` so on-demand commands and
// this job never run concurrently (the local model is single-tenant anyway).
import {
  chatStream,
  autoNotesMessages,
  rebuildAutoNotesMessages,
  mapAutoNotesMessages,
  mergeAutoNotesMessages,
} from './ollama.js';

const TICK_MS = 20000;
const MIN_NEW_CHARS = 250; // new transcript material required between runs
const MAX_NEW_MATERIAL = 6000; // cap on the transcript chunk sent per update
const MAP_CHUNK_CHARS = 12000; // transcript per prompt in a rebuild; longer sessions are rebuilt map-reduce
const MERGE_INPUT_CHARS = 12000; // max chars of partial bullet lists per merge prompt
// Ollama silently truncates the head of any prompt that exceeds the model's
// context window. The largest auto-notes prompt (~20k chars ≈ 5–6k tokens)
// overflows the ~4096 default, so raise the window; 8192 leaves room for the
// reply too. Override with OLLAMA_NUM_CTX if a model can't hold it.
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 8192;

/** Split the transcript into map-sized chunks, breaking between utterances. */
function chunkTranscript(text, cap = MAP_CHUNK_CHARS) {
  if (text.length <= cap) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + cap, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > start) end = nl + 1; // break between utterances, not mid-line
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/** Group items into batches whose total size stays under cap (merge rounds). */
function batchByChars(items, cap) {
  const batches = [];
  let cur = [];
  let size = 0;
  for (const item of items) {
    if (cur.length && size + item.length > cap) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(item);
    size += item.length + 2; // the blank line joined between lists
  }
  if (cur.length) batches.push(cur);
  return batches;
}

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
        numCtx: NUM_CTX,
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
   * accumulated bullets are replaced. A transcript longer than one map chunk
   * goes through map-reduce: each chunk is distilled to bullets ("map"), then
   * the per-part lists are merged in rounds until one set remains ("reduce").
   * The old content stays until the new set is ready — a failed rebuild never
   * blanks the panel.
   */
  async function doRebuild() {
    const cfg = getConfig();
    if (running || !cfg.autoNotes || !cfg.ollamaModel) return;
    const transcript = getTranscriptText();
    if (!transcript.trim()) return;
    running = true;
    const chunks = chunkTranscript(transcript);
    console.log(
      `[autonotes] rebuild started (${transcript.length} transcript chars, ${chunks.length} part${chunks.length === 1 ? '' : 's'})`
    );
    broadcast({ t: 'autonotes-busy', busy: true });
    try {
      const prev = content;
      let lastSent = 0;
      // Streams the candidate replacement into the panel as it builds. The
      // prefix carries what earlier stages already produced, so a long
      // map-reduce rebuild shows accumulated progress instead of every stage
      // starting from a blank panel.
      const onToken = (prefix) => {
        let local = prefix;
        let last = 0;
        return (tok) => {
          local += tok;
          updatedAt = new Date().toTimeString().slice(0, 5);
          const now = Date.now();
          if (now - lastSent > 300) {
            lastSent = now;
            last = now;
            broadcast({ t: 'autonotes', content: local, updated: updatedAt });
          }
        };
      };
      let parts = [];
      if (chunks.length === 1) {
        // Short session: one prompt, as before — the single-shot prompt
        // produces a better-shaped set than extract-then-merge.
        parts = [
          await chatStream({
            model: cfg.ollamaModel,
            numCtx: NUM_CTX,
            messages: rebuildAutoNotesMessages({
              transcript: chunks[0],
              manualNotes: getNotesDoc(),
              profileCtx: getProfileContext(),
            }),
            onToken: onToken(''),
          }),
        ];
      } else {
        // Map: distill each chunk to bullets. Chunk-scoped prompts keep the
        // model's effective context small regardless of session length.
        for (let i = 0; i < chunks.length; i++) {
          const part = (
            await chatStream({
              model: cfg.ollamaModel,
              numCtx: NUM_CTX,
              messages: mapAutoNotesMessages({
                chunk: chunks[i],
                index: i + 1,
                total: chunks.length,
                profileCtx: getProfileContext(),
              }),
              onToken: onToken(parts.join('\n')),
            })
          ).trim();
          if (part) parts.push(part);
          console.log(`[autonotes] rebuild: part ${i + 1}/${chunks.length} -> ${part.length} chars of bullets`);
          broadcast({ t: 'autonotes', content: parts.join('\n'), updated: updatedAt });
        }
        // Reduce: merge rounds over batches, each batch bounded by chars so
        // the merge prompt itself can never overflow. A merge that comes back
        // empty keeps its inputs rather than losing them.
        while (parts.length > 1) {
          const before = parts.length;
          const next = [];
          for (const batch of batchByChars(parts, MERGE_INPUT_CHARS)) {
            if (batch.length === 1) {
              next.push(batch[0]);
              continue;
            }
            const merged = (
              await chatStream({
                model: cfg.ollamaModel,
                numCtx: NUM_CTX,
                messages: mergeAutoNotesMessages({
                  partials: batch,
                  manualNotes: getNotesDoc(),
                  profileCtx: getProfileContext(),
                }),
                onToken: onToken(next.join('\n')),
              })
            ).trim();
            next.push(merged || batch.join('\n'));
          }
          // every batch was a singleton (or every merge came back empty) —
          // nothing more to merge, so don't spin forever
          if (next.length === before) break;
          parts = next;
          broadcast({ t: 'autonotes', content: parts.join('\n'), updated: updatedAt });
          console.log(`[autonotes] rebuild: merged down to ${parts.length} set(s)`);
        }
      }
      const fresh = parts.join('\n').trim();
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
      // so nothing is lost; only the backlog spam disappears. Also idempotent:
      // every client join calls this, only the first sets the timer.
      if (!timer)
        timer = setInterval(() => {
          if (tickQueued) return;
          tickQueued = true;
          enqueue(() => tick()).finally(() => {
            tickQueued = false;
          });
        }, TICK_MS);
    },
    /**
     * Stop the ticking interval — called when a note's last viewer leaves.
     * In-flight jobs finish and persist; the instance keeps its consumption
     * state so the next viewer's start() resumes without re-deriving bullets.
     */
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
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