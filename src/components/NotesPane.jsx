import React, { useMemo, useState } from 'react';
import { marked } from 'marked';

// Right pane: the server-owned "Live notes" panel (rendered read-only, the
// AI's accumulated bullets) joined visually with the markdown notes editor
// (textarea) and a rendered preview mode plus a toolbar of Ollama commands.
export default function NotesPane({
  value,
  autoNotes,
  editorHidden,
  onChange,
  textareaRef,
  onCommand,
  onInsertTranscript,
  canInsertTranscript,
  aiBusy,
  saveState,
  autoNotesOn,
  onToggleAutoNotes,
  onAutoNotesNow,
  onAutoNotesRebuild,
  onHide,
  onShow,
  models,
  ollamaModel,
  onModelChange,
}) {
  const [preview, setPreview] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);

  const html = useMemo(() => (preview ? (marked.parse(value || '') || '') : ''), [preview, value]);
  const autoHtml = useMemo(() => marked.parse(autoNotes.content || '') || '', [autoNotes.content]);

  const trackSelection = (e) => setHasSelection(e.target.selectionStart !== e.target.selectionEnd);

  const polishedDisabled = !hasSelection || !!aiBusy;

  return (
    <section className="pane">
      <header className="pane-header">
        <h2>Notes</h2>
        <div className="pane-actions">
          {!editorHidden && (
            <>
              <button
                className="btn"
                onClick={() => onCommand('summarize')}
                disabled={!canInsertTranscript || !!aiBusy}
                title="Ollama summarizes the transcript into notes, streamed at the cursor"
              >
                ✨ Summarize
              </button>
              <button
                className="btn"
                onClick={() => onCommand('actions')}
                disabled={!canInsertTranscript || !!aiBusy}
                title="Ollama extracts action items as a checklist"
              >
                ✓ Action items
              </button>
              <button
                className="btn"
                onClick={() => onCommand('polish')}
                disabled={polishedDisabled}
                title="Ollama rewrites the selected text (replaces the selection)"
              >
                ✎ Polish selection
              </button>
              <button
                className="btn"
                onClick={() => onCommand('reread')}
                disabled={!value.trim() || !!aiBusy}
                title="Ollama re-reads the highlighted text — or the whole document if nothing is highlighted — then re-organizes and rewrites it"
              >
                ⟳ Re-read
              </button>
              <button
                className="btn"
                onClick={onInsertTranscript}
                disabled={!canInsertTranscript}
                title="Insert the recent transcript at the cursor (no AI)"
              >
                ⤓ Insert transcript
              </button>
            </>
          )}
          <button
            className="btn"
            onClick={editorHidden ? onShow : onHide}
            title={
              editorHidden
                ? 'Bring back your notes editor'
                : 'Hide your notes editor — the pane keeps showing the AI Live notes'
            }
          >
            {editorHidden ? '◱ Show' : '◱ Hide'}
          </button>
          {!editorHidden && (
            <>
              <div className="spacer" />
              <button className={`btn tab ${preview ? '' : 'active'}`} onClick={() => setPreview(false)}>
                Edit
              </button>
              <button className={`btn tab ${preview ? 'active' : ''}`} onClick={() => setPreview(true)}>
                Preview
              </button>
            </>
          )}
        </div>
      </header>

      {(autoNotes.content || autoNotes.updated || editorHidden) && (
        <div
          className={`autonotes-panel${editorHidden ? ' solo' : ''}`}
          title="AI-generated notes from the transcript — kept in its own file, your own notes are never touched"
        >
          <div className="autonotes-head">
            <span className="autonotes-title">Live notes</span>
            {autoNotes.updated && <span className="autonotes-updated">updated {autoNotes.updated}</span>}
          </div>
          {autoNotes.content ? (
            <div className="markdown-body" dangerouslySetInnerHTML={{ __html: autoHtml }} />
          ) : (
            <p className="autonotes-empty">waiting for speech…</p>
          )}
        </div>
      )}

      {!editorHidden &&
        (preview ? (
          <div className="pane-body preview markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <textarea
          ref={textareaRef}
          className="pane-body notes-editor"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/Cmd+S -> save now
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
              e.preventDefault();
              onChange(value, { immediate: true });
            }
            // Tab inserts two spaces instead of leaving the textarea
            if (e.key === 'Tab') {
              e.preventDefault();
              const el = e.target;
              const { selectionStart: a, selectionEnd: b } = el;
              onChange(value.slice(0, a) + '  ' + value.slice(b));
              requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
            }
          }}
          onKeyUp={trackSelection}
          onMouseUp={trackSelection}
          spellCheck={false}
          placeholder="# Notes&#10;&#10;Type markdown here. Use the toolbar to pull in AI-generated content."
        />
        ))}

      <footer className="pane-footer">
        {!editorHidden && (
          <span className={`save-state ${saveState}`}>
            {saveState === 'saving' ? 'saving…' : saveState === 'dirty' ? 'unsaved' : saveState === 'error' ? 'save failed' : 'saved'}
          </span>
        )}
        <div className="spacer" />
        {!editorHidden && aiBusy && <span className="badge busy">{aiBusy}</span>}
        <label className="toggle" title="Background Ollama job that keeps the Live notes section refreshed">
          <input type="checkbox" checked={autoNotesOn} onChange={onToggleAutoNotes} /> auto notes
        </label>
        {autoNotesOn && (
          <button className="btn" onClick={onAutoNotesNow} disabled={!canInsertTranscript || !!aiBusy} title="Refresh the Live notes section now">
            ↻ Update now
          </button>
        )}
        {autoNotesOn && (
          <button
            className="btn"
            onClick={onAutoNotesRebuild}
            disabled={!canInsertTranscript || !!aiBusy}
            title="Regenerate the Live notes from the ENTIRE transcript — replaces the current bullets. Safe to click while the AI is busy: extra clicks are merged into the one running rebuild."
          >
            ⟳⟳ Rebuild all
          </button>
        )}
        <select
          className="model-select"
          value={ollamaModel || ''}
          onChange={(e) => onModelChange(e.target.value)}
          title="Ollama model used for all AI features"
        >
          {models.length === 0 && <option value="">no models found</option>}
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </footer>
    </section>
  );
}