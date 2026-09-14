import React, { useCallback, useEffect, useRef, useState } from 'react';
import { connect, onMessage, sendJson, sendPcm } from './lib/socket.js';
import { useRecorder } from './hooks/useRecorder.js';
import TranscriptPane from './components/TranscriptPane.jsx';
import NotesPane from './components/NotesPane.jsx';
import ProfileManager from './components/ProfileManager.jsx';
import Dashboard from './components/Dashboard.jsx';

// Routing is done by full page loads — no client router. "/" is the dashboard
// listing every note; "/<slug>" is that note's live-notes page. Navigating
// between them is always location.assign, so the URL is the single source of
// truth for which note a tab is bound to.
const PATH = window.location.pathname.replace(/\/+$/, '') || '/';
const SLUG = PATH === '/' ? '' : decodeURIComponent(PATH.split('/')[1]);

export default function App() {
  if (!SLUG) return <Dashboard />;
  return <SessionGate slug={SLUG} />;
}

/**
 * Check that the URL's note actually exists before loading the live app.
 * Unknown notes get a "create it?" screen instead of a half-connected page
 * (the server refuses to auto-create on a typed URL).
 */
function SessionGate({ slug }) {
  const [state, setState] = useState('loading'); // loading | found | missing | unreachable
  const [title, setTitle] = useState('');
  useEffect(() => {
    let alive = true;
    fetch(`/api/sessions/${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : r.status === 404 ? null : Promise.reject(new Error('bad status'))))
      .then((d) => {
        if (!alive) return;
        if (d) {
          setTitle(d.session.title);
          setState('found');
        } else {
          setState('missing');
        }
      })
      .catch(() => alive && setState('unreachable'));
    return () => {
      alive = false;
    };
  }, [slug]);
  if (state === 'loading') return <Splash text="loading…" />;
  if (state === 'unreachable') return <Splash text="Could not reach the server — is it running? (npm run dev)" link />;
  if (state === 'missing') return <NotFound slug={slug} />;
  return <SessionApp slug={slug} initialTitle={title} />;
}

function Splash({ text, link }) {
  return (
    <div className="app">
      <header className="topbar">
        <h1>🎙 Live Notes</h1>
      </header>
      <div className="empty-state">
        <p>{text}</p>
        {link && (
          <p>
            <a className="btn" href="/">← All notes</a>
          </p>
        )}
      </div>
    </div>
  );
}

/** The URL names a note that doesn't exist — offer to create it right there. */
function NotFound({ slug }) {
  const pretty = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: pretty }),
      });
      if (!res.ok) throw new Error('create failed');
      const d = await res.json();
      window.location.assign('/' + encodeURIComponent(d.session.slug));
    } catch {
      setBusy(false);
    }
  };
  return (
    <div className="app">
      <header className="topbar">
        <h1>🎙 Live Notes</h1>
      </header>
      <div className="empty-state">
        <p>
          <strong>“{pretty}”</strong> doesn't exist yet.
        </p>
        <p>
          <button className="btn primary" onClick={create} disabled={busy}>
            {busy ? 'creating…' : 'Create this note'}
          </button>
        </p>
        <p>
          <a className="btn" href="/">← All notes</a>
        </p>
      </div>
    </div>
  );
}

function SessionApp({ slug, initialTitle }) {
  const [notes, setNotes] = useState('');
  const [autoNotes, setAutoNotes] = useState({ content: '', updated: null, busy: false });
  const [sessionTitle, setSessionTitle] = useState(initialTitle);
  // Pane layout, remembered across reloads: divider position (left pane %)
  // and whether the notes pane is collapsed.
  const [splitPct, setSplitPct] = useState(() => {
    const v = Number(localStorage.getItem('liveNotes.splitPct'));
    return Number.isFinite(v) && v >= 20 && v <= 80 ? v : 50;
  });
  const [editorHidden, setEditorHidden] = useState(() => localStorage.getItem('liveNotes.notesHidden') === '1');
  const [transcript, setTranscript] = useState([]);
  const [models, setModels] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [profileManagerOpen, setProfileManagerOpen] = useState(false);
  const [config, setConfig] = useState({ ollamaModel: null, autoNotes: true, activeProfileId: null });
  const [whisper, setWhisper] = useState({ state: 'connecting', message: null });
  const [whisperBusy, setWhisperBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [ollamaUp, setOllamaUp] = useState(true);
  const [error, setError] = useState(null);
  const [aiBusy, setAiBusy] = useState(null);
  const [saveState, setSaveState] = useState('saved');

  const notesRef = useRef('');
  const savedRef = useRef(undefined); // last content persisted on disk
  const textareaRef = useRef(null);
  const splitRef = useRef(null);
  const aiInsert = useRef(null); // {id, pre, post, acc, lastApplied, detached}
  const saveTimer = useRef(null);

  // ------------------------------------------------------------------ notes
  const applyNotes = useCallback(
    (next, { immediate = false } = {}) => {
      notesRef.current = next;
      setNotes(next);
      if (next === savedRef.current) {
        setSaveState('saved');
        clearTimeout(saveTimer.current);
        return;
      }
      clearTimeout(saveTimer.current);
      if (!immediate) setSaveState('dirty');
      saveTimer.current = setTimeout(
        () => {
          setSaveState('saving');
          fetch(`/api/notes?session=${encodeURIComponent(slug)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: notesRef.current }),
          })
            .then(() => {
              savedRef.current = notesRef.current;
              setSaveState('saved');
            })
            .catch(() => setSaveState('error'));
        },
        immediate ? 0 : 700
      );
    },
    [slug]
  );

  const onNotesChange = useCallback(
    (text, opts) => {
      // If the user edits the document while an AI stream is inserting text,
      // detach the stream so their keystrokes are never overwritten. The
      // accumulated AI text is appended at the end when the stream finishes.
      const ins = aiInsert.current;
      if (ins && !ins.detached) {
        const isAiWrite = text !== null && text === ins.pre + ins.acc + ins.post;
        if (!isAiWrite) ins.detached = true;
      }
      applyNotes(text, opts);
    },
    [applyNotes]
  );

  // ---------------------------------------------------------------- socket
  useEffect(() => {
    connect(slug);
    const off = onMessage((msg) => {
      switch (msg.t) {
        case 'init':
          savedRef.current = msg.notes;
          notesRef.current = msg.notes;
          setNotes(msg.notes);
          setSessionTitle(msg.title);
          setAutoNotes(msg.autoNotes || { content: '', updated: null });
          setTranscript(msg.transcript);
          setConfig(msg.config);
          setModels(msg.models);
          setProfiles(msg.profiles || []);
          setWhisper(msg.whisper);
          setOllamaUp(msg.ollama !== false);
          break;
        case 'transcript':
          setTranscript((prev) => [...prev, msg.line]);
          break;
        case 'transcript-cleared':
          setTranscript([]);
          setAutoNotes({ content: '', updated: null, busy: false });
          break;
        case 'whisper':
          setWhisper(msg);
          break;
        case 'whisper-busy':
          setWhisperBusy(msg.busy);
          break;
        case 'config':
          setConfig(msg.config);
          break;
        case 'autonotes':
          // The bullets live in their own file server-side — the notes
          // document never changes, so in-flight AI streams are untouched.
          setAutoNotes((prev) => ({ ...prev, content: msg.content, updated: msg.updated }));
          break;
        case 'autonotes-busy':
          // lights the transcript → notes flow arrow while the job runs
          setAutoNotes((prev) => ({ ...prev, busy: msg.busy }));
          break;
        case 'ai-token': {
          const ins = aiInsert.current;
          if (!ins || ins.id !== msg.id) break;
          ins.acc += msg.token;
          if (!ins.detached) {
            const next = ins.pre + ins.acc + ins.post;
            applyNotes(next);
            ins.lastApplied = next;
          }
          break;
        }
        case 'ai-done': {
          const ins = aiInsert.current;
          if (ins && ins.id === msg.id) {
            if (ins.detached && ins.acc.trim()) applyNotes(notesRef.current + '\n\n' + ins.acc + '\n');
            aiInsert.current = null;
          }
          setAiBusy(null);
          break;
        }
        case 'ai-error':
        case 'error':
          if (msg.t === 'ai-error' && aiInsert.current?.id === msg.id) {
            const ins = aiInsert.current;
            // restore the pre-command document so a failed rewrite can't
            // destroy the user's notes
            if (ins && !ins.detached) applyNotes(ins.original);
            aiInsert.current = null;
          }
          setAiBusy(null);
          setError(msg.message);
          break;
        case 'session-renamed':
          // someone renamed this note from another tab
          setSessionTitle(msg.title);
          break;
        case 'session-deleted':
          // the note was deleted elsewhere — back to the dashboard
          window.location.assign('/');
          break;
        case 'connected':
          setConnected(true);
          break;
        case 'disconnected':
          setConnected(false);
          break;
        default:
          break;
      }
    });
    return off;
  }, [applyNotes, slug]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 9000);
    return () => clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    document.title = sessionTitle ? `${sessionTitle} — Live Notes` : 'Live Notes';
  }, [sessionTitle]);

  // -------------------------------------------------------------- recorder
  const { status: recStatus, error: recError, start, stop } = useRecorder({
    onUtterance: (f32, spokenAt) => sendPcm(f32, spokenAt),
  });
  const recording = recStatus === 'recording';

  // ---------------------------------------------------------------- actions
  const runCommand = (cmd) => {
    if (!config.ollamaModel) {
      setError('No Ollama model available — start Ollama and pull a model (e.g. `ollama pull qwen2.5:3b`).');
      return;
    }
    if (aiInsert.current) return;
    const ta = textareaRef.current;
    const v = notesRef.current;
    let pre, post, selection;
    if (cmd === 'polish') {
      const a = ta ? ta.selectionStart : v.length;
      const b = ta ? ta.selectionEnd : a;
      if (a === b) {
        setError('Select some text in the editor first.');
        return;
      }
      pre = v.slice(0, a);
      post = v.slice(b);
      selection = v.slice(a, b);
    } else if (cmd === 'reread') {
      // highlighted text is re-read; otherwise the whole document is
      const a = ta ? ta.selectionStart : v.length;
      const b = ta ? ta.selectionEnd : a;
      if (a !== b && v.slice(a, b).trim()) {
        pre = v.slice(0, a);
        post = v.slice(b);
        selection = v.slice(a, b);
      } else {
        if (!v.trim()) {
          setError('Nothing to re-read — the notes are empty.');
          return;
        }
        pre = '';
        post = '';
        selection = undefined;
      }
    } else {
      const cursor = ta ? ta.selectionStart : v.length;
      pre = v.slice(0, cursor);
      post = v.slice(cursor);
    }
    const id = crypto.randomUUID();
    aiInsert.current = { id, pre, post, acc: '', original: v, lastApplied: v, detached: false };
    setAiBusy(
      cmd === 'polish'
        ? 'polishing…'
        : cmd === 'reread'
          ? 're-reading notes…'
          : cmd === 'actions'
            ? 'extracting action items…'
            : 'summarizing…'
    );
    sendJson({ t: 'ai', id, cmd, selection });
  };

  const insertTranscriptTail = () => {
    const tail = transcript.slice(-20).map((l) => l.text).join(' ').slice(-1500);
    if (!tail) return;
    const ta = textareaRef.current;
    const v = notesRef.current;
    const cursor = ta ? ta.selectionStart : v.length;
    const lead = cursor === 0 || v[cursor - 1] === '\n' ? '' : '\n';
    applyNotes(v.slice(0, cursor) + lead + tail + '\n' + v.slice(cursor));
  };

  const clearTranscript = () => {
    if (!window.confirm('Clear the transcript? Your notes are kept.')) return;
    fetch(`/api/transcript/clear?session=${encodeURIComponent(slug)}`, { method: 'POST' }).catch(() =>
      setError('Could not clear transcript.')
    );
  };

  // ------------------------------------------------------ pane layout
  const changeSplit = (pct) => {
    const clamped = Math.min(80, Math.max(20, pct));
    setSplitPct(clamped);
    localStorage.setItem('liveNotes.splitPct', String(Math.round(clamped)));
  };

  const startSplitDrag = (e) => {
    e.preventDefault();
    const rect = splitRef.current?.getBoundingClientRect();
    if (!rect) return;
    document.body.classList.add('split-dragging');
    const move = (ev) => changeSplit(((ev.clientX - rect.left) / rect.width) * 100);
    const up = () => {
      document.body.classList.remove('split-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // "Hide notes" hides the user's editing surface only — the pane keeps
  // showing the AI's Live notes (transcript + AI notes view).
  const hideNotes = () => {
    setEditorHidden(true);
    localStorage.setItem('liveNotes.notesHidden', '1');
  };
  const showNotes = () => {
    setEditorHidden(false);
    localStorage.setItem('liveNotes.notesHidden', '0');
  };

  const updateConfig = (patch) => {
    setConfig((c) => ({ ...c, ...patch }));
    sendJson({ t: 'config', ...patch });
  };

  const saveProfile = async (profile) => {
    const res = await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    });
    if (!res.ok) throw new Error((await res.json()).message || 'Save failed');
    const { profile: saved } = await res.json();
    setProfiles((prev) => {
      const idx = prev.findIndex((p) => p.id === saved.id);
      return idx === -1 ? [...prev, saved] : prev.map((p) => (p.id === saved.id ? saved : p));
    });
    return saved;
  };

  const deleteProfile = async (id) => {
    await fetch(`/api/profiles/${id}`, { method: 'DELETE' });
    setProfiles((prev) => prev.filter((p) => p.id !== id));
    if (config.activeProfileId === id) updateConfig({ activeProfileId: null });
  };

  // ----------------------------------------------------------------- render
  const whisperPill =
    whisper.state === 'ready'
      ? { cls: 'ok', label: 'whisper ready' }
      : whisper.state === 'connecting' || whisper.state === 'starting'
        ? { cls: 'warn', label: 'whisper loading…' }
        : { cls: 'bad', label: 'whisper offline' };

  return (
    <div className="app">
      <header className="topbar">
        <a className="btn" href="/" title="Back to all notes">
          ← All notes
        </a>
        <h1>🎙 Live Notes</h1>
        {sessionTitle && (
          <span className="session-name" title={sessionTitle}>
            {sessionTitle}
          </span>
        )}
        <button
          className={`btn record ${recording ? 'recording' : recStatus === 'starting' ? 'starting' : ''}`}
          onClick={recording ? stop : start}
          disabled={recStatus === 'starting'}
        >
          {recording ? '■ Stop' : recStatus === 'starting' ? 'starting…' : '● Record'}
        </button>
        {recError && <span className="pill bad" title={recError}>mic error</span>}
        <span className={`pill ${whisperPill.cls}`} title={whisper.message || ''}>
          {whisperPill.label}
        </span>
        {!ollamaUp && (
          <span className="pill bad" title="Ollama is not reachable at http://127.0.0.1:11434 — start it with `ollama serve`.">
            ollama offline
          </span>
        )}
        {!connected && <span className="pill warn">reconnecting…</span>}
        <select
          className="model-select profile-select"
          value={config.activeProfileId || ''}
          onChange={(e) => updateConfig({ activeProfileId: e.target.value || null })}
          title="Active profile — topic, accents and style guide steering all AI features"
        >
          <option value="">no profile</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => setProfileManagerOpen(true)} title="Create and edit profiles">
          Profiles…
        </button>
        <div className="spacer" />
        {aiBusy && <span className="pill busy">{aiBusy}</span>}
      </header>

      {error && (
        <div className="banner error">
          {error}
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      <main
        className="split"
        ref={splitRef}
        style={{ gridTemplateColumns: `${splitPct}fr 6px ${100 - splitPct}fr` }}
      >
        {autoNotes.busy && (
          <div
            className="flow-arrow"
            style={{ left: `${splitPct}%` }}
            aria-hidden="true"
            title="AI is turning the transcript into live notes…"
          >
            {[0, 1, 2].map((i) => (
              <svg key={i} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 5l7 7-7 7" />
              </svg>
            ))}
          </div>
        )}
        <TranscriptPane lines={transcript} live={recording} busy={whisperBusy} onClear={clearTranscript} />
        <div
          className="split-divider"
          onPointerDown={startSplitDrag}
          onDoubleClick={() => changeSplit(50)}
          title="Drag to resize the panes — double-click to reset"
        />
        <NotesPane
          value={notes}
          autoNotes={autoNotes}
          editorHidden={editorHidden}
          onChange={onNotesChange}
          textareaRef={textareaRef}
          onCommand={runCommand}
          onInsertTranscript={insertTranscriptTail}
          canInsertTranscript={transcript.length > 0}
          aiBusy={aiBusy}
          saveState={saveState}
          autoNotesOn={config.autoNotes}
          onToggleAutoNotes={(e) => updateConfig({ autoNotes: e.target.checked })}
          onAutoNotesNow={() => sendJson({ t: 'autonotes-now' })}
          onAutoNotesRebuild={() => sendJson({ t: 'autonotes-rebuild' })}
          models={models}
          ollamaModel={config.ollamaModel}
          onModelChange={(m) => updateConfig({ ollamaModel: m })}
          onHide={hideNotes}
          onShow={showNotes}
        />
      </main>

      {profileManagerOpen && (
        <ProfileManager
          profiles={profiles}
          activeProfileId={config.activeProfileId}
          onClose={() => setProfileManagerOpen(false)}
          onSave={saveProfile}
          onDelete={deleteProfile}
        />
      )}
    </div>
  );
}