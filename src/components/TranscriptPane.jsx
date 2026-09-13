import React, { useEffect, useRef, useState } from 'react';

// Left pane: live transcript. Auto-scrolls while the user is pinned to the
// bottom; manual scrolling up pauses auto-scroll.
export default function TranscriptPane({ lines, live, busy, onClear }) {
  const bodyRef = useRef(null);
  const [stick, setStick] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (stick && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [lines, stick]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };

  const copyAll = async () => {
    const text = lines.map((l) => `[${l.t}] ${l.text}`).join('\n');
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const exportTxt = () => {
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const name = `transcript-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}-${p(now.getMinutes())}.txt`;
    const text = lines.map((l) => `[${l.t}] ${l.text}`).join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="pane">
      <header className="pane-header">
        <h2>
          Transcript
          {live && <span className="live-dot" title="recording" />}
        </h2>
        <div className="pane-actions">
          {busy && <span className="badge busy">transcribing…</span>}
          <button className="btn" onClick={copyAll} disabled={!lines.length} title="Copy transcript">
            {copied ? '✓' : 'Copy'}
          </button>
          <button className="btn" onClick={exportTxt} disabled={!lines.length} title="Download the transcript as a .txt file (a plain-text copy is also kept at data/latest.txt)">
            ⤓ Export
          </button>
          <button className="btn danger-ghost" onClick={onClear} disabled={!lines.length} title="Clear transcript">
            Clear
          </button>
        </div>
      </header>
      <div className="pane-body transcript" ref={bodyRef} onScroll={onScroll}>
        {lines.length === 0 ? (
          <div className="empty-state">
            <p>{live ? 'Listening… start talking and text will appear here.' : 'Press Record to start live transcription.'}</p>
          </div>
        ) : (
          lines.map((line, i) => (
            <p className="transcript-line" key={i}>
              <span className="time">{line.t}</span>
              {line.text}
            </p>
          ))
        )}
      </div>
    </section>
  );
}