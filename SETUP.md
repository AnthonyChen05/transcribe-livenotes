# Setup Guide — Live Notes

A fully local, offline web app: live speech-to-text on the left, an AI-assisted markdown editor on the right.
Every note is its own page at `/<name>` — the dashboard at `/` organizes them all.
Transcription runs through **whisper.cpp**, text processing through **Ollama**. Nothing leaves your machine.

---

## 1. Prerequisites

| Requirement | Check | Notes |
|---|---|---|
| **Node.js ≥ 20** | `node --version` | Tested on Node 25 |
| **Ollama** installed & running | `curl http://localhost:11434/api/tags` | [ollama.com/download](https://ollama.com/download) |
| At least one Ollama model | `ollama list` | See model advice below |
| A microphone | — | Windows will prompt for permission |

One command verifies all of these at once — **`npm run check`** (it also runs automatically before every `npm run dev` / `npm start`).

### Which Ollama model?

Everything runs on **CPU unless you have an NVIDIA GPU**. Model size directly determines how fast the AI features feel:

| Setup | Recommended models |
|---|---|
| CPU only | `ollama pull qwen2.5:3b` or `gemma3:4b` — snappy summaries |
| CPU only, patient | `qwen2.5:7b` — noticeably better notes |
| NVIDIA GPU | anything, e.g. `gemma3:12b`, `llama3.1:8b` |

`gemma3:12b` works on CPU too, but expect a summary of a long meeting to take a minute or more.
You can switch models anytime from the dropdown in the app's notes footer.

## 2. Install & download assets

```bash
npm install
npm run setup
```

`npm run setup` is a one-time step that downloads (skipped automatically if already present):

- **whisper.cpp** prebuilt Windows x64 binaries (~8 MB) → `bin/whisper-server.exe`
- **Whisper model** `ggml-base.en-q5_1.bin` (~57 MB) → `models/`

Want a different / multilingual Whisper model? Any file from
[huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp/tree/main) works:

```bash
WHISPER_MODEL=ggml-small.en-q5_1.bin npm run setup   # more accurate, slower
WHISPER_MODEL=ggml-base-q5_1.bin npm run setup        # multilingual (non-English speech)
```

Good default: `tiny.en-q5_1` = fastest, `base.en-q5_1` = balanced (default), `small.en-q5_1` = most accurate.

`npm run setup` finishes by running the built-in **setup check** — and the same check runs automatically before every `npm run dev` / `npm start`, so a broken install stops early with the exact fix instead of a confusing "whisper offline" pill:

```bash
npm run check
```

It verifies Node, the whisper binary, which model the server will pick, Ollama and its models, a writable `data/` directory, and that the ports are free — each ✗ row comes with its own `fix:` line. If Live Notes is already running, the check says so instead of letting a second instance crash into the first.

## 3. Start Ollama

Ollama usually runs in the background automatically after install. If not:

```bash
ollama serve
```

## 4. Run the app

**Development** (Vite dev server + hot reload):

```bash
npm run dev
```

→ open **http://localhost:5173**

**Production** (builds the frontend, serves everything from one Node process):

```bash
npm start
```

→ open **http://127.0.0.1:3001**

## 5. First run

1. You land on the **dashboard** — all your notes, most recently used first. Type a name and click **+ Create note** to start a new one; that opens the note's own page (`/economics-lecture-3`, say), where all of the below happens. Renaming and deleting happens on the dashboard cards. Typing a note's URL directly opens a one-click "create it?" page if it doesn't exist yet.
2. Click **● Record** and allow microphone access.
3. Talk — a red dot pulses while listening; each pause ends an utterance and text appears within a second or two (a *transcribing…* badge shows while whisper works).
4. On the right, edit markdown notes freely. **Edit/Preview** toggles rendering. Drag the divider between the panes to resize them (double-click resets it). **◱ Hide** hides your editor so the pane shows only the AI's Live notes (a transcript + AI notes view); **◱ Show** brings the editor back. Both layout choices are remembered across reloads.
5. Toolbar (streams output straight into your notes at the cursor) — the tools work on the note's own transcript:
   - **✨ Summarize** — Ollama summarizes the whole transcript (Key points / Decisions / Open questions)
   - **✓ Action items** — extracts a markdown checklist from the transcript
   - **✎ Polish selection** — rewrites whatever text you selected in the editor
   - **⟳ Re-read** — re-reads the highlighted text — or the whole document if nothing is highlighted — then re-organizes and rewrites it in place (replaces the selection / document)
   - **⤓ Insert transcript** — pastes the recent transcript as plain text (no AI)
6. **Auto notes** (footer toggle, on by default, per note): every ~20 s, if ≥ 250 new characters were transcribed, Ollama appends the new key points to the *Live notes* panel above the editor — an animated arrow between the panes marks while it runs. The bullets live in their own file (`data/sessions/<name>/autonotes.md`); your notes document is never modified by the AI, the UI just shows the two together. The panel grows incrementally — earlier points are kept, never rewritten — and displays the single latest update time. **↻ Update now** processes the material accumulated so far immediately. **⟳⟳ Rebuild all** discards the current bullets and regenerates the Live notes from the *entire* transcript — useful after clearing the notes or when the accumulated set has drifted; the old bullets stay until the new set is ready, so a failed rebuild never blanks the panel.
7. Notes autosave to the note's `notes.md` (700 ms after you stop typing, or **Ctrl+S** immediately). The transcript persists to its `transcript.md`, and a plain-text copy (no timestamps) is always kept up to date at its `latest.txt` — handy for other tools to read mid-session. The transcript pane's **⤓ Export** button downloads the timestamped transcript as a `.txt` file. All of it lives under `data/sessions/<name>/`.
8. **Profiles** (topbar) describe the event you're recording: topic / scenario, speaker accents, and a style guide. Profiles are shared across notes (stored in `data/profiles.json`), but the *active* profile is picked per note — each note is a different event. The active profile is injected into every AI prompt — summaries, action items, polish, and the auto-notes job — so the output matches the context (e.g. accent notes tell the model to interpret likely mishearings). Create and edit profiles via **Profiles…**.

## Configuration

Settings are split: the **Ollama model choice** lives in `data/config.json` (global — one model for the whole app), while the **auto-notes toggle** and **active profile** are per note and live in `data/sessions.json`. Everything is also editable from the UI. Environment overrides:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | App server port |
| `WHISPER_MODEL` | best model in `models/` | Force a specific model file name in `models/` |
| `WHISPER_MODEL_PATH` | — | Full path override |
| `WHISPER_PORT` | `1782` | (base value; actual port is auto-picked) |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama endpoint |
| `OLLAMA_NUM_THREADS` | cores/2 − 2 | Cap Ollama's CPU threads so live transcription keeps its cores during AI jobs |

### Better transcription quality

The default model, `ggml-base.en-q5_1.bin` (59 MB), is the smallest practical one — fast, but it mishears accents and domain terms (your Ollama profile's accent notes help the AI catch those, but better input is better). To upgrade, download a larger model and restart `npm run dev`:

```powershell
npm run setup -- ggml-large-v3-turbo-q5_0.bin
```

| Model | Size | Notes |
|---|---|---|
| `ggml-large-v3-turbo-q5_0.bin` | 547 MB | **Recommended** — near large-v3 accuracy, ~8× faster decoding, much better with accents; still real-time on CPU |
| `ggml-large-v3-turbo-q8_0.bin` | 834 MB | Same, higher precision |
| `ggml-small.en.bin` | 465 MB | Mild upgrade, English-only |
| `ggml-medium.en.bin` | 1.4 GB | Bigger jump, noticeably slower per utterance |

The server automatically picks the best model present in `models/` (quality-ranked), so no other configuration is needed. Any `.bin` from the [whisper.cpp HuggingFace repo](https://huggingface.co/ggerganov/whisper.cpp/tree/main) can be passed to `npm run setup --`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Anything broken / fresh clone won't start | Run `npm run check` — it pinpoints the problem and prints the fix |
| Top bar shows **whisper offline** | Run `npm run setup` (binaries/model missing) |
| **ollama offline** pill | Start Ollama: `ollama serve` |
| Typing a note's URL that doesn't exist | Not an error — the page offers a one-click **Create this note** button |
| Recording dot pulses but transcript stays empty | Mic device changed mid-session — toggle **Record** off/on (re-reads the device's actual sample rate; a reload also works). Whisper returning nothing usually means it got non-speech or wrong-rate audio. |
| **mic error** pill | Check Windows Settings → Privacy → Microphone; browsers only allow mic on `localhost`/`https` |
| No transcript while speaking | Speak a full sentence and pause briefly (~1 s) — utterances are sent on silence |
| Transcription lags behind | Use a smaller model: `WHISPER_MODEL=ggml-tiny.en-q5_1.bin npm run setup` |
| `whisper-server did not become ready` | Check the server console for `[whisper]` lines; antivirus may block the exe |
| Transcription is wrong language | Use a multilingual model (`WHISPER_MODEL=ggml-base-q5_1.bin`) — `.en` models are English-only |
| Port 3001 busy | The setup check flags this at startup. `PORT=4000 npm start` (dev proxy hardcodes 3001 — edit `vite.config.js` too) |

## Where things live

```
teleprompt-livenotes/
├── bin/                  # whisper-server.exe + DLLs (downloaded)
├── models/               # Whisper ggml models (downloaded)
├── data/
│   ├── sessions.json     # note index: names, timestamps, per-note settings
│   ├── sessions/
│   │   └── <name>/       # one directory per note:
│   │       ├── notes.md        # your notes (autosaved) — never touched by the AI
│   │       ├── autonotes.md    # the AI's "Live notes" bullets (server-managed)
│   │       ├── transcript.md   # transcript history
│   │       └── latest.txt      # plain-text mirror of the transcript (no timestamps)
│   ├── profiles.json     # your AI profiles (topic, accents, style guide)
│   └── config.json       # global settings (Ollama model)
├── server/               # Express + ws backend, spawns whisper-server
├── src/                  # React frontend (recorder, VAD, panes)
├── scripts/
│   ├── setup.mjs         # the asset downloader
│   └── check.mjs         # the setup doctor (`npm run check`)
```