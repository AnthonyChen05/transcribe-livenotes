import React, { useEffect, useState } from 'react';

// Modal for creating / editing / deleting profiles: named scenario presets
// (topic, speaker accents, style guide) that steer all AI features while
// recording — summaries, action items, polish and the auto-notes job.
export default function ProfileManager({ profiles, activeProfileId, onClose, onSave, onDelete }) {
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState({ name: '', topic: '', accent: '', style: '' });
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);

  const startNew = () => {
    setSelectedId(null);
    setDraft({ name: '', topic: '', accent: '', style: '' });
    setDirty(false);
  };

  const loadProfile = (id) => {
    setSelectedId(id);
    setDirty(false);
    setError(null);
    const p = profiles.find((x) => x.id === id);
    if (p) setDraft({ name: p.name, topic: p.topic || '', accent: p.accent || '', style: p.style || '' });
  };

  useEffect(() => {
    // open with the active profile (or a blank draft) for a quick start
    if (activeProfileId) loadProfile(activeProfileId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (key) => (e) => {
    setDraft((d) => ({ ...d, [key]: e.target.value }));
    setDirty(true);
  };

  const save = async () => {
    if (!draft.name.trim()) {
      setError('Give the profile a name.');
      return;
    }
    try {
      await onSave({ id: selectedId || undefined, ...draft });
      startNew();
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  };

  const remove = async () => {
    if (!selectedId) return;
    if (!window.confirm(`Delete profile "${draft.name}"?`)) return;
    await onDelete(selectedId);
    startNew();
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <header>
          <h3>Profiles</h3>
          <button className="btn" onClick={onClose} title="Close">✕</button>
        </header>
        <p className="modal-hint">
          A profile describes the current recorded event — topic, speakers' accents, and how you want the notes
          written. The active profile steers every AI feature: summaries, action items, polish, and the auto-notes
          section.
        </p>

        <div className="modal-columns">
          <div className="profile-list">
            <button className={`btn list-item ${selectedId === null ? 'active' : ''}`} onClick={startNew}>
              + New profile
            </button>
            {profiles.map((p) => (
              <button
                key={p.id}
                className={`btn list-item ${selectedId === p.id ? 'active' : ''}`}
                onClick={() => loadProfile(p.id)}
              >
                {p.name}
                {p.id === activeProfileId && <span className="active-tag">active</span>}
              </button>
            ))}
          </div>

          <div className="profile-form">
            <label>
              Name
              <input value={draft.name} onChange={set('name')} placeholder="e.g. Design standup" />
            </label>
            <label>
              Topic / scenario
              <textarea
                value={draft.topic}
                onChange={set('topic')}
                rows={2}
                placeholder="What is this event about? e.g. Weekly sync for the mobile app launch, attendees: Maya (PM), Tom (design)"
              />
            </label>
            <label>
              Speaker accents
              <textarea
                value={draft.accent}
                onChange={set('accent')}
                rows={2}
                placeholder="e.g. Strong Spanish and French accents — transcripts may mishear names"
              />
            </label>
            <label>
              Style guide
              <textarea
                value={draft.style}
                onChange={set('style')}
                rows={3}
                placeholder="How should the notes read? e.g. Terse bullets, keep ticket IDs like APP-123, use British spelling"
              />
            </label>
            {error && <p className="form-error">{error}</p>}
            <div className="form-actions">
              <button className="btn danger-ghost" onClick={remove} disabled={!selectedId}>
                Delete
              </button>
              <span className="spacer" />
              <button className="btn" onClick={startNew} disabled={!dirty}>
                Discard changes
              </button>
              <button className="btn primary" onClick={save}>
                {selectedId ? 'Save profile' : 'Create profile'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}