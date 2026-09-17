# Setup Guide — Live Notes

**English** | [繁體中文](SETUP.zh-TW.md)

A fully local, offline web app: live speech-to-text on the left, an AI-assisted markdown editor on the right.
Every note is its own page at `/<name>` — the dashboard at `/` organizes them all.
Transcription runs through **whisper.cpp**, text processing through **Ollama**. Nothing leaves your machine.

A fresh install takes about **10 minutes** plus download time. Work through the steps in order — each one ends with a command that verifies it worked.

---

## Requirements

| Requirement | Details & download | Verify |
|---|---|---|
| **Windows 10/11 x64** | The supported path — `npm run setup` downloads prebuilt Windows x64 whisper.cpp binaries. On Linux/macOS you must build whisper-server from source into `./bin`. | — |
| **Node.js ≥ 20** | Runs the server and dev tooling. Install the current **LTS** from **[nodejs.org/en/download](https://nodejs.org/en/download)** (tested up to Node 25). | `node --version` |
| **Ollama** | The local LLM runtime behind summaries, action items, polish and live notes. Install from **[ollama.com/download](https://ollama.com/download)** — the Windows installer also starts the background service. | `ollama --version` |
| **One Ollama model** | Pulled after Ollama is installed — see [Step 3](#step-3--pull-an-ollama-model). Recommended: `qwen2.5:3b` (~1.9 GB). Full catalog: [ollama.com/library](https://ollama.com/library). | `ollama list` |
| **A microphone** | Built-in or USB. The browser asks for permission the first time you record. | — |
| **Disk space** | ~1 GB for `node_modules` + whisper binaries (~8 MB) + the default Whisper model (57 MB) — plus your Ollama model (~2 GB for a 3B model). | — |
| **RAM** | 8 GB recommended — whisper and Ollama share the CPU during live sessions. | — |
| **Internet** | Only needed for the one-time downloads. Once everything is installed the app is fully offline — the only network calls are to `localhost`. | — |

One command verifies most of this at once: **`npm run check`** (it also runs automatically before every `npm run dev` / `npm run start`).

### Which Ollama model?

Everything runs on **CPU unless you have an NVIDIA GPU**. Model size directly determines how fast the AI features feel:

| Setup | Recommended models |
|---|---|
| CPU only | `ollama pull qwen2.5:3b` or `gemma3:4b` — snappy summaries |
| CPU only, patient | `qwen2.5:7b` — noticeably better notes |
| NVIDIA GPU | anything, e.g. `gemma3:12b`, `llama3.1:8b` |

`gemma3:12b` works on CPU too, but expect a summary of a long meeting to take a minute or more.
You can switch models anytime from the dropdown in the app's notes footer.

## Step-by-step setup

### Step 1 — Install Node.js

1. Download the **LTS** `.msi` for Windows x64 from <https://nodejs.org/en/download>.
2. Run the installer — the default options are fine (this adds `node` and `npm` to your PATH).
3. Open a **new** terminal (so the PATH change applies) and verify:

```bash
node --version      # v20.x or newer
npm --version
```

### Step 2 — Install Ollama

1. Download the Windows installer from <https://ollama.com/download> and run it.
2. It installs Ollama and starts it in the background (you get a tray icon). Verify it's alive: open **<http://localhost:11434>** in a browser — you should see *"Ollama is running"*. Or from a terminal:

```bash
ollama --version
```

If it's not running (e.g. after a reboot with autostart disabled):

```bash
ollama serve
```

### Step 3 — Pull an Ollama model

```bash
ollama pull qwen2.5:3b
```

A one-time ~1.9 GB download; alternatives are in the model table above. Verify:

```bash
ollama list         # should show qwen2.5:3b
```

### Step 4 — Get the code

With Git ([git-scm.com/download/win](https://git-scm.com/download/win)):

```bash
git clone https://github.com/SynesisLab/transcribe-livenotes.git
cd transcribe-livenotes
```

Without Git: on the GitHub repo page click **Code → Download ZIP**, extract it, then open a terminal inside the extracted folder. All following commands run from the project root.

### Step 5 — Install dependencies

```bash
npm install
```

Downloads `node_modules` (React, Vite, Express, ws — a minute or two on a normal connection).

### Step 6 — Download the transcription assets

```bash
npm run setup
```

A one-time step (safe to re-run — existing files are skipped) that downloads:

- **whisper.cpp** prebuilt Windows x64 binaries (~8 MB) → `bin/whisper-server.exe`
- the **Whisper model** `ggml-base.en-q5_1.bin` (57 MB) → `models/`

Want a different, multilingual or more accurate Whisper model? Any file from
[huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp/tree/main) works:

```powershell
npm run setup -- ggml-large-v3-turbo-q5_0.bin   # recommended upgrade — see "Better transcription quality"
npm run setup -- ggml-base-q5_1.bin             # multilingual (for non-English speech)
```

Rough guide: `tiny.en-q5_1` = fastest, `base.en-q5_1` = balanced (the default), `small.en-q5_1` = most accurate.

### Step 7 — Run the setup check

```bash
npm run check
```

`npm run setup` already ran this for you at the end — here's what it confirms:

| Check | Confirms | If it fails |
|---|---|---|
| Node.js | v20 or newer | ✗ — install from nodejs.org |
| Platform | Windows x64, matching the prebuilt binaries | ⚠ warning on other systems |
| whisper.cpp | `bin/whisper-server.exe` present | ✗ — run `npm run setup` |
| Whisper model | the exact model file the server will pick | ✗ — run `npm run setup` |
| Ollama | reachable at `127.0.0.1:11434` | ⚠ AI features disabled until fixed |
| Ollama models | at least one pulled | ⚠ — `ollama pull qwen2.5:3b` |
| Data directory | `data/` is writable | ✗ — check folder permissions |
| Ports | 3001 (app) and 5173 (dev) are free | ✗ — stop the other process, or change `PORT` |

Every ✗ / ⚠ row prints its own `fix:` line with the exact command. The check also runs automatically before every `npm run dev` / `npm run start` (npm's `predev` / `prestart` hooks), so a broken install stops early with instructions instead of a confusing **whisper offline** pill. If Live Notes is already running, the check tells you where instead of letting a second instance crash into the first.

When everything is in place you'll see:

```
✓ Everything is in place — start the app with:  npm run dev
```

### Step 8 — Start the app

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

That's the whole setup — continue with **[First run](#first-run)** below for a tour of the UI, or jump straight to **[Troubleshooting](#troubleshooting)** if anything misbehaves.

---

## First run

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

The default model, `ggml-base.en-q5_1.bin` (57 MB), is the smallest practical one — fast, but it mishears accents and domain terms (your Ollama profile's accent notes help the AI catch those, but better input is better). To upgrade, download a larger model and restart `npm run dev`:

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
