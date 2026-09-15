# 🎙 Live Notes

[English](README.md) | **繁體中文**

**本機優先的即時語音轉錄 + AI 輔助 Markdown 筆記。** 左邊說話、右邊做筆記 — 完全離線，任何資料都不會離開你的電腦。

- 🗂 **多筆記總覽** — 每則筆記在 `/<name>` 都有專屬頁面；位於 `/` 的總覽面板列出所有筆記（可就地重新命名／刪除）。每則筆記各自保有專屬的逐字稿、筆記文件、AI 條列摘要、自動筆記開關與使用中的預設檔。
- 🗣 **即時轉錄** — whisper.cpp 在本機執行；以語音活動偵測（VAD）切分的語句會在幾秒內完成轉錄，時間戳標記的是字句*說出口*的當下。積存下來的語音會被合併成單一 whisper 視窗，因此長篇獨白能以數倍於即時的速度趕上進度。
- 📝 **即時筆記** — 背景的 Ollama 工作會在你說話的同時，將逐字稿濃縮成條列重點。它們存放在獨立檔案（`data/sessions/<name>/autonotes.md`），顯示在編輯器上方 — AI 絕不會更動你的文件。隨時可用 **⟳⟳ Rebuild all** 從完整逐字稿重新產生整組摘要。
- ✍️ **Markdown 編輯器** — 即時編輯並同步渲染預覽，自動儲存到磁碟。窗格可拖曳分隔線調整大小，編輯器也能隱藏，切換成逐字稿 + AI 筆記的檢視模式；兩項選擇都會被記住。
- 🧰 **AI 工具列** — 摘要逐字稿、擷取行動項目、潤飾或重讀選取的文字。結果會逐 token 串流寫入筆記中游標所在的位置。
- 👤 **情境預設檔（Profiles）** — 針對活動命名的預設（主題、講者口音、風格指南），會引導所有 AI 提示詞。
- 🔒 **零雲端** — 沒有 API 金鑰、沒有遙測，除了 localhost 之外沒有任何網路請求。

## 快速開始

```bash
# 事前需求：Node.js >= 20（nodejs.org）與 Ollama（ollama.com/download）
ollama pull qwen2.5:3b      # 推薦的 CPU 小型模型 — 詳見 SETUP.zh-TW.md

npm install
npm run setup               # 一次性：whisper.cpp 執行檔 + 模型（約 65 MB）
npm run dev                 # → http://localhost:5173
```

`npm run dev` 會先執行內建的**環境檢查**（也可單獨用 `npm run check` 執行）：它會驗證 Node、whisper 執行檔、Whisper 模型、Ollama 與其模型、資料目錄及連接埠 — 並印出能修正缺失項目的確切指令，而不是莫名其妙地失敗。它也會防止重複啟動：如果 Live Notes 已在執行，它會告訴你它正在哪裡執行。

正式支援的平台是 Windows x64（whisper 執行檔為預先建置版本）。完整的事前需求、設定與疑難排解請見 **[SETUP.zh-TW.md](SETUP.zh-TW.md)**。

## 運作原理

```
 麥克風 ──AudioWorklet 16 kHz──▶ VAD 分段器 ──Float32 PCM──▶ Node 伺服器
                                                              │
                                              WAV ── POST ──▶ whisper-server.exe（子程序）
                                                              │
                              左窗格 ◀── WebSocket ── 逐字稿（標記說話當下的時間）
                                    │
                                    ├── AI 工具列 ───▶ Ollama ──▶ 結果串流進你的筆記
                                    └── 約每 20 秒 ──▶ Ollama ──▶ 「即時筆記」條列（獨立檔案）
```

## 檔案位置

| 路徑 | 存放內容 |
|---|---|
| `server/` | Express + WebSocket 伺服器：啟動 whisper-server、將轉錄排隊並合併、代理 Ollama、執行自動筆記工作、將一切持久化到磁碟 |
| `src/` | React UI：錄音 hook（VAD + 重取樣）、逐字稿窗格、筆記編輯器、情境預設檔管理 |
| `scripts/setup.mjs` | 一次性下載 whisper.cpp 發布版執行檔 + ggml 模型 |
| `scripts/check.mjs` | `npm run check`（以及每次 `dev`/`start`）背後的環境檢查醫生 |
| `bin/`、`models/` | whisper-server.exe 與模型（gitignore，另行下載） |
| `data/` | 你的筆記：`sessions.json` 索引，加上每則筆記一個 `sessions/<name>/` 目錄（`notes.md`、`autonotes.md`、`transcript.md`、`latest.txt`），以及情境預設檔與全域設定（gitignore） |

## 效能須知

- 轉錄速度隨 CPU 核心數提升。推薦模型 `ggml-large-v3-turbo-q5_0`（547 MB）在現代筆記型電腦的 CPU 上可達到甚至超越即時速度，且準確度遠優於安裝時預設的 57 MB 模型 — 升級只需執行 `npm run setup -- ggml-large-v3-turbo-q5_0.bin` 再重新啟動。
- AI 功能的速度取決於你所用的 Ollama 模型。在 CPU 上，3–4B 的模型能快速產生摘要；8–12B 也可行，但耗時較久。
- `OLLAMA_NUM_THREADS` 會限制 Ollama 的 CPU 執行緒數（預設：核心數 / 2 − 2），讓即時轉錄在 AI 工作執行期間仍保有自己的核心 — 詳見 SETUP.zh-TW.md。

## 授權

MIT — 詳見 [LICENSE](LICENSE)。