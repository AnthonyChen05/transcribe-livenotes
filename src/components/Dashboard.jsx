import React, { useCallback, useEffect, useState } from 'react';

/** "x minutes ago" style relative stamp — friendlier than raw ISO dates. */
function relTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return d.toLocaleDateString();
}

/**
 * The home page: every note as a card, most recently used first. Creating a
 * note navigates to its live-notes page; cards rename/delete in place.
 */
export default function Dashboard() {
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Live Notes';
  }, []);

  const load = useCallback(() => {
    fetch('/api/sessions')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('server error'))))
      .then((d) => {
        setSessions(d.sessions);
        setError(null);
      })
      .catch(() => setError('Could not reach the server — is it running? (npm run dev)'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async (e) => {
    e.preventDefault();
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t }),
      });
      if (!res.ok) throw new Error('create failed');
      const d = await res.json();
      window.location.assign('/' + encodeURIComponent(d.session.slug));
    } catch {
      setError('Could not create the note.');
      setBusy(false);
    }
  };

  const rename = async (s) => {
    const t = window.prompt('Rename this note:', s.title);
    if (!t || !t.trim() || t.trim() === s.title) return;
    await fetch(`/api/sessions/${encodeURIComponent(s.slug)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: t.trim() }),
    }).catch(() => {});
    load();
  };

  const remove = async (s) => {
    if (!window.confirm(`Delete “${s.title}” and its transcript and notes? This cannot be undone.`)) return;
    await fetch(`/api/sessions/${encodeURIComponent(s.slug)}`, { method: 'DELETE' }).catch(() => {});
    load();
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>🎙 Live Notes</h1>
        <span className="dash-sub">every note gets its own page</span>
      </header>

      {error && (
        <div className="banner error">
          {error}
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      <main className="dashboard">
        <form className="new-note" onSubmit={create}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder='New note name — e.g. "Economics lecture 3"'
            maxLength={120}
            autoFocus
          />
          <button className="btn primary" type="submit" disabled={busy || !title.trim()}>
            + Create note
          </button>
        </form>

        {sessions === null && !error && <p className="dash-hint">loading…</p>}

        {sessions && sessions.length === 0 && (
          <div className="empty-state">
            <p>No notes yet — create one above. Each note has its own live transcription, transcript and AI notes.</p>
          </div>
        )}

        {sessions && sessions.length > 0 && (
          <div className="note-grid">
            {sessions.map((s) => (
              <div
                className="note-card"
                key={s.slug}
                onClick={() => window.location.assign('/' + encodeURIComponent(s.slug))}
                title={`Open “${s.title}”`}
              >
                <h3>{s.title}</h3>
                <span className="note-meta">
                  {relTime(s.updatedAt)}
                  {s.lines ? ` · ${s.lines} lines` : ''}
                </span>
                <p className="note-preview">{s.preview || 'Empty note — nothing recorded yet.'}</p>
                <div className="note-actions">
                  <button
                    className="btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      rename(s);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    className="btn danger-ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(s);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}