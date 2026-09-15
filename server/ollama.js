// Minimal client for the local Ollama HTTP API (default http://127.0.0.1:11434).
import os from 'node:os';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
// Leave CPU headroom for live whisper transcription: by default Ollama grabs
// every core, and a long prompt eval starves the transcription queue for
// a minute+ at a time.
const OLLAMA_THREADS = Number(process.env.OLLAMA_NUM_THREADS) || Math.max(2, Math.floor(os.cpus().length / 2) - 2);

export async function listModels() {
  const res = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!res.ok) throw new Error(`Ollama /api/tags failed: ${res.status}`);
  const json = await res.json();
  return (json.models || []).map((m) => m.name);
}

/**
 * Streams a chat completion. Calls onToken(chunk) for each piece of the
 * assistant message, resolves with the full text.
 *
 * Ollama (Windows) occasionally wedges — the request is accepted but never
 * answered, leaving the caller waiting forever. Every request therefore
 * carries a hard timeout (timeoutMs): on expiry the fetch aborts, the error
 * propagates to the caller, and the feature's busy state clears so the next
 * attempt can run.
 */
export async function chatStream({ model, messages, onToken, signal, timeoutMs = 300_000, numCtx }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Ollama did not answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        options: {
          num_thread: OLLAMA_THREADS,
          // Ollama answers an overflowing prompt by silently truncating its
          // head — no error ever reaches us. Callers that pack large prompts
          // must raise num_ctx above the ~4096-token default themselves.
          ...(numCtx ? { num_ctx: numCtx } : {}),
        },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`Ollama /api/chat failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    let full = '';
    let buffer = '';
    for await (const chunk of res.body) {
      // res.body chunks are Uint8Array; .toString() would yield comma-joined
      // numbers, so decode explicitly.
      buffer += Buffer.from(chunk).toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        const piece = event.message?.content ?? '';
        if (piece) {
          full += piece;
          onToken?.(piece);
        }
        if (event.done || event.error) {
          if (event.error) throw new Error(`Ollama error: ${event.error}`);
          return full;
        }
      }
    }
    return full;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Prompt definitions for the toolbar commands. Each returns Ollama messages.
const TRANSCRIPT_LIMIT = 6000; // chars of transcript tail sent to the model

function transcriptTail(transcript) {
  if (transcript.length <= TRANSCRIPT_LIMIT) return transcript;
  return '…' + transcript.slice(transcript.length - TRANSCRIPT_LIMIT);
}

const SYSTEM = 'You are a note-taking assistant inside a live meeting transcription app. You write clean, concise markdown. Output only the requested content — no preamble, no explanations, no code fences.';

/** system message with the active profile's scenario context folded in */
function systemWith(profileCtx) {
  return profileCtx ? `${SYSTEM}\n\nSession context:\n${profileCtx}` : SYSTEM;
}

export const COMMANDS = {
  summarize: {
    label: 'Summarize transcript',
    requiresTranscript: true,
    build: ({ transcript, profileCtx }) => [
      { role: 'system', content: systemWith(profileCtx) },
      {
        role: 'user',
        content: `Summarize the following live transcript as markdown notes. Use short bullet points grouped under the headings "Key points", "Decisions", and "Open questions" (omit a heading if it has nothing).\n\nTRANSCRIPT:\n${transcriptTail(transcript)}`,
      },
    ],
  },
  actions: {
    label: 'Extract action items',
    requiresTranscript: true,
    build: ({ transcript, profileCtx }) => [
      { role: 'system', content: systemWith(profileCtx) },
      {
        role: 'user',
        content: `Extract action items from the following live transcript as a markdown checklist. Only include concrete tasks someone must do. Output the checklist only.\n\nTRANSCRIPT:\n${transcriptTail(transcript)}`,
      },
    ],
  },
  polish: {
    label: 'Polish selection',
    requiresSelection: true,
    build: ({ selection, profileCtx }) => [
      { role: 'system', content: systemWith(profileCtx) },
      {
        role: 'user',
        content: `Rewrite the text below into clean, well-structured markdown notes. Fix grammar, remove filler words and repetition, keep all meaning. Output only the rewritten markdown.\n\nTEXT:\n${selection}`,
      },
    ],
  },
  reread: {
    // Client sends the highlighted text, or nothing — in which case the
    // server falls back to the whole notes document.
    label: 'Re-read notes',
    requiresSelection: false,
    build: ({ selection, notes, profileCtx }) => [
      { role: 'system', content: systemWith(profileCtx) },
      {
        role: 'user',
        content: `Re-read the following notes. Re-organize and rewrite them into clean, well-structured markdown: group related items under clear headings, remove duplicates and filler, tighten the wording, and use bullet points or checklists where they fit. Preserve ALL information and meaning — do not drop any fact, decision, or task. Output only the rewritten markdown.\n\nNOTES:\n${(selection || '').trim() || notes}`,
      },
    ],
  },
};

/**
 * Prompt for a full rebuild of the auto-notes when the session transcript fits
 * one prompt (see MAP_CHUNK_CHARS in autonotes.js — longer sessions go through
 * mapAutoNotesMessages + mergeAutoNotesMessages instead). The accumulated
 * bullets are replaced by a fresh, complete set.
 */
export function rebuildAutoNotesMessages({ transcript, manualNotes, profileCtx }) {
  const manualForPrompt = manualNotes && manualNotes.length > 6000 ? manualNotes.slice(-6000) : manualNotes;
  const base =
    'You are a note-taking assistant embedded in a live transcription app. The "Live notes" bullet section is being REBUILT from scratch from the full session transcript. Output the complete markdown bullet-point set covering the session\'s key information — facts, decisions, action items, open questions — concise and deduplicated. This output replaces the previous notes entirely, so cover the whole session, not just recent material. Never output headings, preamble, or explanations. Output ONLY the bullet points.';
  return [
    {
      role: 'system',
      content: profileCtx ? `${base}\n\nSession context:\n${profileCtx}` : base,
    },
    {
      role: 'user',
      content: `Rest of the user's notes document (context — never duplicate what is here):\n\n${manualForPrompt?.trim() || '(nothing yet)'}\n\nFULL session transcript:\n\n${transcript}\n\nComplete Live notes bullet set:`,
    },
  ];
}

/**
 * Map step of a long-transcript rebuild: extract bullets from ONE chunk of the
 * session. The transcript is split into chunks that each fit the context
 * window, so this prompt stays small no matter how long the session ran.
 * Dedup across chunks happens later, in mergeAutoNotesMessages.
 */
export function mapAutoNotesMessages({ chunk, index, total, profileCtx }) {
  const base =
    'You are a note-taking assistant embedded in a live transcription app. You are given one part of a longer session transcript, split to fit the model context. Extract the key information from THIS part only as markdown bullet points — facts, decisions, action items, open questions. One bullet per point, no headings, no preamble. A later merge step deduplicates across parts, so do not summarize details away — keep every distinct fact, decision, task, and open question you find. If this part adds nothing of value, output nothing at all.';
  return [
    {
      role: 'system',
      content: profileCtx ? `${base}\n\nSession context:\n${profileCtx}` : base,
    },
    {
      role: 'user',
      content: `Part ${index} of ${total} of the session transcript:\n\n${chunk}\n\nBullet points for this part (or nothing):`,
    },
  ];
}

/**
 * Reduce step: merge the per-part bullet lists into one deduplicated set
 * covering the whole session. It runs in rounds over batches of lists, so the
 * merge prompt itself never overflows the context window, whatever the model
 * produces.
 */
export function mergeAutoNotesMessages({ partials, manualNotes, profileCtx }) {
  const manualForPrompt = manualNotes && manualNotes.length > 6000 ? manualNotes.slice(-6000) : manualNotes;
  const base =
    'You are a note-taking assistant embedded in a live transcription app. You are given bullet lists extracted from consecutive parts of ONE session transcript, in order. Merge them into a single markdown bullet-point set covering the whole session: keep every distinct fact, decision, action item, and open question; drop duplicates, reworded repeats, and filler; keep related bullets in a sensible order. Never drop information that appears in only one list. Never output headings, preamble, or explanations. Output ONLY the merged bullet points.';
  return [
    {
      role: 'system',
      content: profileCtx ? `${base}\n\nSession context:\n${profileCtx}` : base,
    },
    {
      role: 'user',
      content: `Rest of the user's notes document (context — never duplicate what is here):\n\n${manualForPrompt?.trim() || '(nothing yet)'}\n\nIntermediate bullet lists, in transcript order:\n\n${partials.join('\n\n')}\n\nMerged Live notes bullet set:`,
    },
  ];
}

/**
 * Prompt for the background auto-notes job. The notes section is append-only:
 * each update receives the existing notes plus the transcript material that is
 * new since the last update, and must output ONLY the additional bullet points.
 * The notes therefore keep growing as the session progresses — they are never
 * rewritten from scratch.
 */
export function autoNotesMessages({ existing, manualNotes, newMaterial, profileCtx }) {
  // Previous portions of the notes, so new bullets build on what exists
  // instead of duplicating it: the live-notes bullets accumulated so far,
  // plus whatever the user has written manually.
  const existingForPrompt = existing && existing.length > 8000 ? existing.slice(-8000) : existing;
  const manualForPrompt = manualNotes && manualNotes.length > 6000 ? manualNotes.slice(-6000) : manualNotes;
  const base =
    'You are a note-taking assistant embedded in a live transcription app. You maintain a "Live notes" section that grows incrementally as a session progresses. You receive the current notes document (your previous bullets plus anything the user wrote manually) and a chunk of NEW transcript material. Output ONLY markdown bullet points covering genuinely NEW information (facts, decisions, action items, open questions) that is not already captured anywhere in the notes. Never repeat, reword, or reorganize existing notes. Never output headings, preamble, or explanations. If the new material adds nothing of value, output nothing at all.';
  return [
    {
      role: 'system',
      content: profileCtx ? `${base}\n\nSession context:\n${profileCtx}` : base,
    },
    {
      role: 'user',
      content: `Live notes so far (your new bullets get appended to these):\n\n${existingForPrompt?.trim() || '(empty — this is the first update)'}\n\nRest of the user's notes document (context — never duplicate what is here):\n\n${manualForPrompt?.trim() || '(nothing yet)'}\n\nNew transcript material:\n\n${newMaterial}\n\nNew bullet points only (or nothing):`,
    },
  ];
}