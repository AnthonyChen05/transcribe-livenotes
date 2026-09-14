# 🎙 Live Notes

**Local-first live transcription + AI-assisted markdown notes.** Speak on the left, take notes on the right — fully offline, nothing leaves your machine.

- 🗂 **Multi-note dashboard** — every note gets its own page at `/<name>`; the dashboard at `/` lists them all (rename/delete in place). Each note keeps its own transcript, notes document, AI bullets, auto-notes toggle and active profile.
- 🗣 **Live transcription** — whisper.cpp runs locally; voice-activity-detected utterances transcribe within seconds, timestamped with when the words were *spoken*. Backlogged speech is merged into single whisper windows so long monologues catch up several × faster than real time.
- 📝 **Live notes** — a background Ollama job distills the transcript into bullet points as you talk. They live in their own file (`data/sessions/<name>/autonotes.md`) and are shown above your editor — the AI never modifies your document. Regenerate the whole set from the full transcript anytime with **⟳⟳ Rebuild all**.
- ✍️ **Markdown editor** — live editing with rendered preview, autosaved to disk. Panes are resizable (drag the divider) and the editor can be hidden for a transcript + AI-notes view; both choices are remembered.
- 🧰 **AI toolbar** — summarize the transcript, extract action items, polish or re-read selected text. Results stream token-by-token into your notes at the cursor.
- 👤 **Profiles** — named event presets (topic, speaker accents, style guide) that steer every AI prompt.
- 🔒 **Zero cloud** — no API keys, no telemetry, no network calls beyond localhost.

## Quick start

```bash
# prerequisites: Node.js >= 20 (nodejs.org) and Ollama (ollama.com/download)
ollama pull qwen2.5:3b      # recommended small model for CPU — see SETUP.md

npm install
npm run setup               # one-time: whisper.cpp binaries + model (~65 MB)
npm run dev                 # → http://localhost:5173
```

`npm run dev` first runs the built-in **setup check** (also available as `npm run check`): it verifies Node, the whisper binary, the Whisper model, Ollama and its models, the data directory and the ports — printing the exact command that fixes whatever is missing, instead of failing obscurely. It also refuses to double-launch: if Live Notes is already running, it tells you where.

Windows x64 is the supported path (whisper binaries are prebuilt). Full prerequisites, configuration and troubleshooting: **[SETUP.md](SETUP.md)**.

## How it works

```
 mic ──AudioWorklet 16 kHz──▶ VAD chunker ──Float32 PCM──▶ Node server
                                                              │
                                              WAV ── POST ──▶ whisper-server.exe (child process)
                                                              │
                              left pane ◀── WebSocket ── transcript (spoken-at timestamps)
                                    │
                                    ├── AI toolbar ────▶ Ollama ──▶ results stream into your notes
                                    └── every ~20 s ───▶ Ollama ──▶ "Live notes" bullets (own file)
```

## Where things live

| Path | What it holds |
|---|---|
| `server/` | Express + WebSocket server: spawns whisper-server, queues + merges transcriptions, proxies Ollama, runs the auto-notes job, persists everything |
| `src/` | React UI: recorder hook (VAD + resampling), transcript pane, notes editor, profiles |
| `scripts/setup.mjs` | One-time download of whisper.cpp release binaries + the ggml model |
| `scripts/check.mjs` | The setup doctor behind `npm run check` (and every `dev`/`start`) |
| `bin/`, `models/` | whisper-server.exe and the models (gitignored, downloaded) |
| `data/` | Your notes: `sessions.json` index plus a `sessions/<name>/` directory per note (`notes.md`, `autonotes.md`, `transcript.md`, `latest.txt`), plus profiles and global config (gitignored) |

## Performance notes

- Transcription speed scales with CPU cores. The recommended model, `ggml-large-v3-turbo-q5_0` (547 MB), transcribes at or better than real time on a modern laptop CPU with far better accuracy than the 57 MB setup default — upgrading is just `npm run setup -- ggml-large-v3-turbo-q5_0.bin` plus a restart.
- AI feature speed depends on your Ollama model. On CPU a 3–4B model gives snappy summaries; 8–12B works but takes longer.
- `OLLAMA_NUM_THREADS` caps Ollama's CPU threads (default: cores/2 − 2) so live transcription keeps its cores during AI jobs — see SETUP.md.

## License

MIT — see [LICENSE](LICENSE).