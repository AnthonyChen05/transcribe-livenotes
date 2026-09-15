# 安裝指南 — Live Notes

[English](SETUP.md) | **繁體中文**

這是一個完全在本機執行的離線網頁應用：左邊是即時語音轉文字，右邊是 AI 輔助的 Markdown 編輯器。
每則筆記在 `/<name>` 都有專屬頁面 — 位於 `/` 的總覽面板管理所有筆記。
轉錄透過 **whisper.cpp** 執行，文字處理透過 **Ollama**。任何資料都不會離開你的電腦。

全新安裝大約需要 **10 分鐘** 加上下載時間。請依序操作 — 每個步驟結尾都有可驗證該步驟是否成功的指令。

---

## 事前需求

| 需求 | 說明與下載 | 驗證 |
|---|---|---|
| **Windows 10/11 x64** | 正式支援的平台 — `npm run setup` 會下載預先建置的 Windows x64 whisper.cpp 執行檔。在 Linux/macOS 上必須自行從原始碼建置 whisper-server 放進 `./bin`。 | — |
| **Node.js ≥ 20** | 執行伺服器與開發工具。請從 **[nodejs.org/en/download](https://nodejs.org/en/download)** 安裝目前的 **LTS** 版（已測試至 Node 25）。 | `node --version` |
| **Ollama** | 驅動摘要、行動項目、潤飾與即時筆記的本機 LLM 執行環境。從 **[ollama.com/download](https://ollama.com/download)** 安裝 — Windows 安裝程式也會一併啟動背景服務。 | `ollama --version` |
| **一個 Ollama 模型** | 安裝 Ollama 之後拉取 — 見[步驟 3](#步驟-3--拉取-ollama-模型)。建議：`qwen2.5:3b`（約 1.9 GB）。完整目錄：[ollama.com/library](https://ollama.com/library)。 | `ollama list` |
| **麥克風** | 內建或 USB 皆可。第一次錄音時瀏覽器會詢問權限。 | — |
| **磁碟空間** | `node_modules` + whisper 執行檔（約 8 MB）+ 預設 Whisper 模型（57 MB）約需 1 GB — 再加上你的 Ollama 模型（3B 約 2 GB）。 | — |
| **記憶體** | 建議 8 GB — whisper 與 Ollama 在即時會議中共享 CPU。 | — |
| **網路** | 只有一次性下載需要。全部安裝完成後，應用完全離線 — 唯一的網路對象是 `localhost`。 | — |

只要一條指令就能驗證上述大部分項目：**`npm run check`**（每次 `npm run dev` / `npm run start` 前也會自動執行）。

### 該用哪個 Ollama 模型？

除非你有 NVIDIA GPU，否則全部跑在 **CPU** 上。模型大小直接決定 AI 功能的速度感：

| 環境 | 建議模型 |
|---|---|
| 只有 CPU | `ollama pull qwen2.5:3b` 或 `gemma3:4b` — 摘要反應靈敏 |
| 只有 CPU、有耐心 | `qwen2.5:7b` — 筆記品質明顯更好 |
| NVIDIA GPU | 任何模型皆可，例如 `gemma3:12b`、`llama3.1:8b` |

`gemma3:12b` 也能在 CPU 上跑，但一場長會議的摘要可能要等一分鐘以上。
你隨時可以從應用程式筆記頁尾的下拉選單切換模型。

## 逐步安裝

### 步驟 1 — 安裝 Node.js

1. 從 <https://nodejs.org/en/download> 下載 Windows x64 的 **LTS** `.msi` 安裝程式。
2. 執行安裝程式 — 預設選項即可（會將 `node` 與 `npm` 加入 PATH）。
3. 開一個**新的**終端機（讓 PATH 變更生效）並驗證：

```bash
node --version      # v20.x 或更新
npm --version
```

### 步驟 2 — 安裝 Ollama

1. 從 <https://ollama.com/download> 下載 Windows 安裝程式並執行。
2. 它會安裝 Ollama 並在背景啟動（系統匣會出現圖示）。驗證它正在執行：用瀏覽器開啟 **<http://localhost:11434>** — 應該會看到 *"Ollama is running"*。或在終端機執行：

```bash
ollama --version
```

如果它沒有在執行（例如重新開機後自動啟動被停用）：

```bash
ollama serve
```

### 步驟 3 — 拉取 Ollama 模型

```bash
ollama pull qwen2.5:3b
```

一次性的 ~1.9 GB 下載；替代方案見上方模型表。驗證：

```bash
ollama list         # 應該列出 qwen2.5:3b
```

### 步驟 4 — 取得程式碼

有 Git（[git-scm.com/download/win](https://git-scm.com/download/win)）：

```bash
git clone https://github.com/AnthonyChen05/transcribe-livenotes.git
cd transcribe-livenotes
```

沒有 Git：在 GitHub 儲存庫頁面點 **Code → Download ZIP**，解壓縮後在資料夾內開啟終端機。後續所有指令都在專案根目錄執行。

### 步驟 5 — 安裝相依套件

```bash
npm install
```

下載 `node_modules`（React、Vite、Express、ws — 一般網路下一至兩分鐘）。

### 步驟 6 — 下載轉錄檔案

```bash
npm run setup
```

一次性步驟（可安全重跑 — 已存在的檔案會跳過），會下載：

- **whisper.cpp** 預先建置的 Windows x64 執行檔（約 8 MB）→ `bin/whisper-server.exe`
- **Whisper 模型** `ggml-base.en-q5_1.bin`（57 MB）→ `models/`

想要不同、多語言或更準確的 Whisper 模型？[huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp/tree/main) 上的任何檔案都可以：

```powershell
npm run setup -- ggml-large-v3-turbo-q5_0.bin   # 建議升級 — 見「提升轉錄品質」
npm run setup -- ggml-base-q5_1.bin             # 多語言（非英語語音）
```

大概的選擇：`tiny.en-q5_1` = 最快、`base.en-q5_1` = 平衡（預設）、`small.en-q5_1` = 最準確。

### 步驟 7 — 執行環境檢查

```bash
npm run check
```

`npm run setup` 在結尾已經替你跑過了 — 以下是它確認的項目：

| 檢查項目 | 確認內容 | 失敗時 |
|---|---|---|
| Node.js | v20 或更新 | ✗ — 從 nodejs.org 安裝 |
| 平台 | Windows x64，符合預建執行檔 | ⚠ 其他系統顯示警告 |
| whisper.cpp | `bin/whisper-server.exe` 存在 | ✗ — 執行 `npm run setup` |
| Whisper 模型 | 伺服器實際會選用的模型檔 | ✗ — 執行 `npm run setup` |
| Ollama | 可連到 `127.0.0.1:11434` | ⚠ 修好前 AI 功能停用 |
| Ollama 模型 | 至少拉取一個 | ⚠ — `ollama pull qwen2.5:3b` |
| 資料目錄 | `data/` 可寫入 | ✗ — 檢查資料夾權限 |
| 連接埠 | 3001（應用）與 5173（開發）未被占用 | ✗ — 停掉占用連接埠的程序，或改 `PORT` |

每個 ✗ / ⚠ 列都會印出自己的 `fix:` 修復指令。這個檢查也會在每次 `npm run dev` / `npm run start` 前自動執行（npm 的 `predev` / `prestart` 掛鉤），因此安裝有問題時會提早中止並附上指示，而不是丟出一個莫名其妙的 **whisper offline** 藥丸提示。如果 Live Notes 已在執行，檢查會告訴你在哪裡，而不是讓第二個實例直接撞上第一個。

一切就緒時你會看到：

```
✓ Everything is in place — start the app with:  npm run dev
```

### 步驟 8 — 啟動應用程式

**開發模式**（Vite 開發伺服器 + 熱重載）：

```bash
npm run dev
```

→ 開啟 **http://localhost:5173**

**生產模式**（建置前端，由單一 Node 程序提供所有服務）：

```bash
npm start
```

→ 開啟 **http://127.0.0.1:3001**

安裝到此完成 — 接著請看下方的**[初次使用](#初次使用)**導覽 UI；若有任何異常，直接跳到**[疑難排解](#疑難排解)**。

---

## 初次使用

1. 你會進到**總覽面板**（dashboard）— 顯示所有筆記，最近使用的排最前面。輸入名稱並點 **+ Create note** 建立新筆記；這會開啟該筆記的專屬頁面（例如 `/economics-lecture-3`），以下所有操作都在那裡進行。重新命名與刪除都在總覽卡片上進行。直接輸入尚未存在的筆記網址，會開啟一個一鍵「建立它？」頁面。
2. 點 **● Record** 並允許麥克風存取。
3. 開始說話 — 聆聽時紅點會規律閃爍；每次停頓結束一個語句，文字在一兩秒內出現（whisper 處理期間會顯示 *transcribing…* 徽章）。
4. 在右側自由編輯 Markdown 筆記。**Edit/Preview** 切換渲染。拖曳窗格間的分隔線可調整大小（雙擊重設）。**◱ Hide** 隱藏你的編輯器，讓窗格只顯示 AI 的即時筆記（逐字稿 + AI 筆記檢視）；**◱ Show** 恢復編輯器。兩項版面選擇都會在重新載入後保留。
5. 工具列（輸出直接串流進筆記中游標所在位置）— 工具作用於該筆記自己的逐字稿：
   - **✨ Summarize** — Ollama 摘要整份逐字稿（Key points / Decisions / Open questions）
   - **✓ Action items** — 從逐字稿擷取 Markdown 核對清單
   - **✎ Polish selection** — 改寫你在編輯器中選取的文字
   - **⟳ Re-read** — 重新閱讀反白文字（若無反白則讀整份文件），然後重新組織並就地改寫（取代選取範圍／整份文件）
   - **⤓ Insert transcript** — 將近期逐字稿以純文字貼入（不經 AI）
6. **Auto notes**（頁尾開關，預設開啟，逐筆記設定）：約每 20 秒，若逐字稿新增 ≥ 250 個字元，Ollama 會把新的重點附加到編輯器上方的 *Live notes*（即時筆記）面板 — 執行時兩窗格之間的箭頭會以動畫標示。這些條列存放在自己的檔案（`data/sessions/<name>/autonotes.md`）；AI 絕不會修改你的筆記文件，UI 只是把兩者顯示在一起。面板會逐步成長 — 先前的重點保留、絕不改寫 — 並顯示最近一次的更新時間。**↻ Update now** 立即處理目前累積的素材。**⟳⟳ Rebuild all** 丟棄現有條列，從*完整*逐字稿重新產生即時筆記 — 清空筆記之後，或累積的條列已經失準時很有用；舊條列會保留到新條列就緒，因此重建失敗不會清空面板。
7. 筆記會自動儲存到該筆記的 `notes.md`（停止輸入後 700 毫秒，或按 **Ctrl+S** 立即儲存）。逐字稿會保存到它的 `transcript.md`，並隨時在 `latest.txt` 保持一份純文字副本（無時間戳）— 方便其他工具在工作階段進行中讀取。逐字稿窗格的 **⤓ Export** 按鈕可將含時間戳的逐字稿下載為 `.txt` 檔案。全部都存放在 `data/sessions/<name>/` 之下。
8. **情境預設檔（Profiles）**（頂欄）描述你正在錄製的活動：主題／情境、講者口音與風格指南。預設檔在所有筆記間共用（存在 `data/profiles.json`），但*使用中*的預設檔是逐筆記挑選 — 每則筆記是不同的活動。使用中的預設檔會注入每個 AI 提示詞 — 摘要、行動項目、潤飾與自動筆記工作 — 讓輸出符合情境（例如口音備註會告訴模型如何解讀可能的聽寫錯誤）。透過 **Profiles…** 建立與編輯預設檔。

## 設定

設定是分開的：**Ollama 模型選擇**存在 `data/config.json`（全域 — 整個應用共用一個模型），而**自動筆記開關**與**使用中的預設檔**是逐筆記的，存在 `data/sessions.json`。這些也都能從 UI 修改。環境變數覆寫：

| 變數 | 預設值 | 用途 |
|---|---|---|
| `PORT` | `3001` | 應用伺服器連接埠 |
| `WHISPER_MODEL` | `models/` 中最佳模型 | 強制指定 `models/` 裡的模型檔名 |
| `WHISPER_MODEL_PATH` | — | 完整路徑覆寫 |
| `WHISPER_PORT` | `1782` | （基準值；實際連接埠會自動挑選） |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama 端點 |
| `OLLAMA_NUM_THREADS` | 核心數 / 2 − 2 | 限制 Ollama 的 CPU 執行緒數，讓即時轉錄在 AI 工作執行時仍保有自己的核心 |

### 提升轉錄品質

預設模型 `ggml-base.en-q5_1.bin`（57 MB）是可用尺寸中最小的 — 快，但會聽錯口音與專業術語（Ollama 預設檔的口音備註能幫 AI 猜對，但輸入品質更好才是根本）。要升級，下載較大的模型並重新啟動 `npm run dev`：

```powershell
npm run setup -- ggml-large-v3-turbo-q5_0.bin
```

| 模型 | 大小 | 說明 |
|---|---|---|
| `ggml-large-v3-turbo-q5_0.bin` | 547 MB | **建議** — 準確度接近 large-v3，解碼快約 8 倍，口音表現好得多；在 CPU 上仍能即時 |
| `ggml-large-v3-turbo-q8_0.bin` | 834 MB | 同上，精度更高 |
| `ggml-small.en.bin` | 465 MB | 小幅升級，僅限英語 |
| `ggml-medium.en.bin` | 1.4 GB | 更大躍升，每個語句明顯變慢 |

伺服器會自動挑選 `models/` 中現有的最佳模型（依品質排序），無需其他設定。[whisper.cpp HuggingFace 儲存庫](https://huggingface.co/ggerganov/whisper.cpp/tree/main) 中的任何 `.bin` 都可以傳給 `npm run setup --`。

## 疑難排解

| 症狀 | 修法 |
|---|---|
| 任何異常／全新 clone 無法啟動 | 執行 `npm run check` — 它會指出問題並印出修法 |
| 頂欄顯示 **whisper offline** | 執行 `npm run setup`（缺少執行檔／模型） |
| **ollama offline** 藥丸提示 | 啟動 Ollama：`ollama serve` |
| 輸入的筆記網址不存在 | 不是錯誤 — 頁面提供一鍵 **Create this note** 按鈕 |
| 錄音紅點閃爍但逐字稿遲遲是空的 | 工作階段中麥克風裝置改變了 — 把 **Record** 關掉再開（會重新讀取裝置實際的取樣率；重新載入頁面也可以）。whisper 沒有回傳通常表示它收到非語音或取樣率錯誤的音訊。 |
| **mic error** 藥丸提示 | 檢查 Windows 設定 → 隱私權 → 麥克風；瀏覽器只允許在 `localhost`/`https` 上使用麥克風 |
| 說話時沒有逐字稿出現 | 說完整的句子並短暫停頓（約 1 秒）— 語句會在靜音時送出 |
| 轉錄進度落後 | 改用較小的模型：`WHISPER_MODEL=ggml-tiny.en-q5_1.bin npm run setup` |
| `whisper-server did not become ready` | 查看伺服器主控台的 `[whisper]` 訊息；防毒軟體可能封鎖該 exe |
| 轉錄語言不正確 | 改用多語言模型（`WHISPER_MODEL=ggml-base-q5_1.bin`）— `.en` 模型僅支援英語 |
| 連接埠 3001 被占用 | 環境檢查會在啟動時標記。`PORT=4000 npm start`（開發代理固定用 3001 — 一併修改 `vite.config.js`） |

## 檔案位置

```
teleprompt-livenotes/
├── bin/                  # whisper-server.exe + DLL（下載取得）
├── models/               # Whisper ggml 模型（下載取得）
├── data/
│   ├── sessions.json     # 筆記索引：名稱、時間戳、逐筆記設定
│   ├── sessions/
│   │   └── <name>/       # 每則筆記一個目錄：
│   │       ├── notes.md        # 你的筆記（自動儲存）— AI 絕不碰它
│   │       ├── autonotes.md    # AI 的「Live notes」條列（伺服器管理）
│   │       ├── transcript.md   # 逐字稿歷史
│   │       └── latest.txt      # 逐字稿的純文字鏡像（無時間戳）
│   ├── profiles.json     # 你的 AI 預設檔（主題、口音、風格指南）
│   └── config.json       # 全域設定（Ollama 模型）
├── server/               # Express + ws 後端，啟動 whisper-server
├── src/                  # React 前端（錄音、VAD、窗格）
├── scripts/
│   ├── setup.mjs         # 資產下載器
│   └── check.mjs         # 環境檢查醫生（`npm run check`）
```