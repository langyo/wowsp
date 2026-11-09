# AI 模型分發：Hugging Face 通道與多 provider 鏡像（設計契約）

> 狀態：草案（DRAFT）——`feat/ai-models` 這波工作的實作契約。
> 範圍：把內建的決策／評分模型（ONNX 權重、艦艇屬性路由表，以及逐地圖
> 地形通視柵格）連同其訓練／部署腳本發布到公開的 Hugging Face 模型
> 儲存庫；透過一條新的、帶簽章的 `ai` 資源通道以逐檔下載方式提供給
> 用戶端；並把目前只支援 GitHub 的鏡像階梯泛化成與 provider 無關的
> 鏡像上下文，供所有可下載資源共用。
>
> 不在範圍內：已凍結的應用程式更新通道、`res-latest` 資源包（仍留在
> GitHub Releases）、訓練管線本身，以及回放資料集的發布。

## 1. 問題與目標

內建的決策模型（ONNX 開火／移動評分頭、屬性路由的建議模型、可選的
魚雷模型、路由表，以及逐地圖地形通視柵格）目前**完全沒有分發通道**。
它們以被 gitignore 的訓練產物形式存在於 `scripts/experiments/out/`
之下；已安裝的 `<cache>/decisions` 模型包是手工複製的目錄，應用程式
只能清點與清除。沒有發布腳本、沒有 manifest、沒有 digest、沒有下載器、
沒有版本戳，也沒有覆蓋率保證——如今 96 個已知地圖 id 中只有 35 個帶
LOS 柵格，已安裝的兩個模型比目前的 fp32 匯出更舊、體積約為其一半，
而 advice／torpedo 槽位乾脆是空的。

與此同時，應用程式已經知道如何服務一個更完整的資源包：`res-latest`
資源包由本儲存庫發布，對中國大陸網路透過 ghproxy 風格的鏡像階梯加速，
以官方 sha256 digest 校驗，並以原子性方式套用。決策模型通道應當達到
同樣的工程水準，但不必繼承 1.3 GB 資源包的種種限制。

目標：

1. **一個公開、可重現的產物。** 每次模型發布都由已簽入的腳本從指定的
   儲存庫 commit 產生，並連同其訓練與部署腳本一起發布到公開的
   Hugging Face 模型儲存庫。
2. **更新獨立於應用程式發版——但受特徵契約約束。** 只要輸入／特徵
   schema 與執行中的 featurizer 相符，重新訓練的模型就能在沒有新
   應用程式建置的情況下送達已安裝的用戶端；schema 變更按定義就是
   一次應用程式發版。
3. **先驗完整性，再執行。** 模型檔案由 ONNX Runtime 解析並執行，因此
   該通道採 fail-closed：帶簽章的 manifest 釘住每個檔案的 sha256 與
   Hugging Face commit，未簽章或不符的酬載永不安裝。
4. **中國大陸可達性。** 在 `huggingface.co` 不可達的環境（維護者網路
   已實測）下，執行階段階梯仍必須可用，且不能把任何單一第三方鏡像
   寫死。
5. **單一鏡像框架。** GitHub、Hugging Face 與（日後的）ModelScope
   共用同一個感知 provider 的上下文——候選重寫、探測、健康／黏性
   選擇，以及經漂移檢查的端點清單——而不是五份重複的 ghproxy 前綴
   清單。
6. **儲存庫中不含機密。** Hugging Face 憑證只存在於環境或使用者權杖
   儲存區；絕不進入受追蹤的檔案。

### 1.1 實測輸入

| 產物 | 來源（開發檢出） | 大小 |
| --- | --- | --- |
| 開火模型（fp32，v2 ablate NONE） | `scripts/experiments/out/fire_model/v2plain_std/fp32.onnx` | 2,592,543 B |
| 移動模型（fp32，17 類，ablate E11） | `scripts/experiments/out/move_model/node3/main/fp32.onnx` | 2,652,542 B |
| 建議開火模型（fp32，E24 屬性路由） | `scripts/experiments/out/fire_model/e24_attrs/fp32.onnx` | 2,595,135 B |
| 魚雷模型（fp32；int8 可選） | `scripts/experiments/out/torpedo_model/final/fp32.onnx` | 492,411 B（int8 136,214 B） |
| 艦艇屬性路由表 | `scripts/experiments/ship_attributes.json` | 261,507 B |
| 地形通視柵格 | `bake_terrain_los.py` 輸出，每張地圖一個 `terrain_los.npz` | 每個 5,986-221,638 B（已安裝 35 張） |

每個檔案都遠低於 10 MB 的更新大小預算。Hub 仍透過 Xet/LFS 儲存二進位 blob，
因此 `/resolve/` 回覆的是簽章 CDN 重新導向，而不是 200；下載器會跟隨它
（在最終主機上使用 Range／續傳）且不涉及 Xet 用戶端，而帶簽章的 manifest 加上逐檔 sha256，讓這些位元組仍具權威性（見 4.2 與 7.8）。

## 2. 現狀

| 方面 | 現況 | 後果 |
| --- | --- | --- |
| 模型發布 | 無 | 模型除了手工複製之外無法送達使用者 |
| 已安裝模型包 | `<LOCALAPPDATA>/WoWSP/decisions`，手工複製 | 陳舊／不完整；沒有版本戳；無法偵測代次錯誤的模型 |
| 模型載入 | `decision_serve` 階梯：env -> 模型包槽位 -> 開發產物；`ship_attrs` 使用編譯期 `include_str!` 表 | 路由表變更需要應用程式發版；「模型包覆蓋內嵌表」的註解並未實作 |
| 資源包 | GitHub `res-latest` + delta 鏈 + relay 簽章 digest | 成熟；維持原樣 |
| 鏡像階梯 | 只含 GitHub 的主機清單搭配 ghproxy 前綴拼接；副本散見於 Rust、Cargo metadata、Python、website、webui mock 與 relay CSP | 無法代理 `huggingface.co`；只有其中一份受漂移測試 |
| 行動端 | ONNX Runtime 是預設 feature，因此 Android／iOS 建置會內附 ONNX；decisions 模型包並未內附 | 行動端同樣能受益於這條通道 |
| 註冊表列 | `decisions-pack`，channel 為空，trigger 為 `manual` | 沒有檢查／下載按鈕，也沒有 freshness 紀錄列 |

因此這一波是**新建一條通道**，而不是遷移既有通道。

> **實作狀態。** 此通道已上線：`langyo/wowsp-d1` 已發佈 seq 2（四個 ONNX 模型、屬性表，以及基於資源包樹 `6855322b…` 烘焙的 35 張地形 LOS 柵格），並已透過 `hf-mirror.com` 與官方端點驗證；應用程式的 `ai` 通道、設定卡片與 8 個設定語言包隨之上線。上表記錄的是本設計取代的通道前狀態；模型包攜帶的路由表現已覆蓋內嵌表（見 6.6 節）。

## 3. 架構總覽

三層，各司其職：

```text
  GitHub repo (source of truth)
      |  python scripts/publish_ai_models.py  (hash -> sign -> upload)
      v
  Hugging Face model repo  wowsp-d1  (generated release artifact + scripts snapshot)
      |  signed manifest.json + per-file resolve/<commit-sha>/<path>
      v
  client  commands/ai_pack.rs  --->  commands/mirror/ (MirrorContext)
      |      per-file download via download_hub        GitHub | Hugging Face | ModelScope
      v
  <cache>/decisions  (fire/move/advice/torpedo + attrs + <map>/terrain_los.npz)
```

| 決策 | 選擇 | 理由 |
| --- | --- | --- |
| 下載來源 | v1 只發 Hugging Face（加上內建的 `hf-mirror.com`）；GitHub Release 備援與 ModelScope 是日後的 provider | 只驗證一條發布路徑；鏡像上下文讓新增 provider 的成本很低 |
| manifest 信任錨 | 以現有已 pin 的 Ed25519 金鑰自簽章 manifest，並加上 `seq` 棘輪 | Hugging Face 不提供官方逐資產 digest；relay digest 通道會讓每次模型發布多一步部署，卻沒有額外保障 |
| 傳輸單位 | 每個產物一個檔案，原子性暫存安裝 | 所有檔案皆 < 10 MB；可增量更新；下載樞紐本就支援逐段進度、sha256、位元組上下限、續傳與取消 |
| 鏡像選擇 | 感知 provider 的階梯，搭配冷啟動競速避險、每輪黏性端點與健康冷卻 | 官方主機對部分受眾不可達；同時必須保留使用者列出的確定性順序 |
| 資源包 | 不變，只走 GitHub | 5.7k 個檔案、delta 鏈與 GitHub 資產 digest 仍是更合適的組合 |

## 4. Hugging Face 儲存庫

### 4.1 佈局

```text
wowsp-d1/                          public model repository (owner/repo TBD, see 11)
  README.md                        model card: purpose, provenance, metrics, file table, licence
  LICENSE                          Synthetic Source License 1.0 (same as the app repo)
  manifest.json                    signed runtime manifest (section 5)
  NOTICE.md                        game-data provenance and redistribution note (section 4.5)
  onnx/fire_model.onnx
  onnx/move_model.onnx
  onnx/advice_fire_model.onnx
  onnx/torpedo_model.onnx
  onnx-int8/                       optional quantized variants, never installed by default
  attrs/ship_attributes.json
  los/<mapId>/terrain_los.npz
  training/                        generated snapshot: scripts/experiments training/deployment scripts
  SOURCE.json                      {"repo","commit","generatedAt","tool":"scripts/publish_ai_models.py"}
```

`manifest.json` 是應用程式唯一視為通道入口的檔案。個別檔案本身也可由人與模型卡（model card）的檔案表個別下載。

### 4.2 檔案大小規則

每個儲存庫檔案都維持在 **10 MB 以下**，讓更新保持精簡且可增量。即使低於該門檻，Hub 仍透過 Xet/LFS 儲存二進位 blob（以純 Git 推送二進位會被拒絕），因此 `/resolve/` 回覆的是簽章 CDN 重新導向，而不是 200；下載器會跟隨它，並在最終主機上保留 Range／續傳，且不涉及任何 Xet 用戶端。LOS 柵格目前每張地圖一個檔案（全都遠低於上限）；若未來某個資源包會讓單檔超過上限，就把 LOS 拆成編號的 bundle，讓每個都維持在上限之下。發布程式會拒絕超過 10 MB 的暫存檔案，並印出違規的路徑。

### 4.3 revision 模型

Hugging Face 的 revision 就是 commit；分支／標籤可以移動，commit SHA 不會。因此發布使用兩次 commit：

1. 上傳產物檔案（權重、屬性表、LOS、腳本快照）-> commit `A`；
2. 上傳 `manifest.json`、`README.md`、`LICENSE`、`NOTICE.md` 與 `SOURCE.json`，並在 manifest 內寫入 `"revision": "A"` -> commit `B`。

應用程式從分支頭（`main`）取得 `manifest.json`，驗證其簽章，接著從 `/{repo}/resolve/{A}/{path}` 下載每個檔案——這是一條不可變的 pin。快取了較舊 manifest 的用戶端，即使 `main` 往前推進，仍會繼續使用較舊的 commit。註記（`models-<seq>` 標籤）僅供人閱讀。

### 4.4 發布流程與操作

`scripts/publish_ai_models.py`（仿照 `scripts/release_models.py`）：

1. 蒐集輸入（權重、`ship_attributes.json`、烘焙好的 LOS 目錄、指定 commit 的 `git archive` 腳本快照）；
2. 逐檔計算雜湊，建構已簽章的 manifest（第 5 節），計算 tree 雜湊；
3. 上傳產物（commit A），再上傳 manifest 與說明文件（commit B，pin 到 A）；
4. 印出發布摘要（seq、manifest sha256、HF commit、檔案表）。`--dry-run` 會執行所有本機步驟但不上傳。

**帳號、權杖與儲存庫建立。** Hugging Face 沒有匿名寫入路徑：發布需要帳號與寫入權杖。權杖在網頁介面建立（Settings -> Access Tokens，建議使用僅限該儲存庫寫入範圍的細粒度權杖），並透過 `HF_TOKEN` 或標準使用者權杖儲存區（`~/.cache/huggingface/token`）提供。儲存庫本身可由腳本透過 `huggingface_hub.create_repo`（REST `POST /api/repos/create`）、網頁介面，或可選的 `hf repo create` CLI 建立——三者等價；**CLI 不是前提條件**。發布程式使用 `huggingface_hub` Python API，官方 `huggingface/hub-sync` GitHub Action 也不過是它的封裝；日後可讓一條 CI 車道以儲存庫 secret 中的 `HF_TOKEN` 執行同一支腳本（絕不進入版本追蹤）。

**網路現實。** 只有 `huggingface.co` 接受寫入。從中國大陸無法直連該主機（已實測：連線逾時），因此本機發布需要維護者的 HTTP(S) 代理（`HTTPS_PROXY`），或者改在 CI 上發布。鏡像是唯讀代理：執行階段讀取不需要代理，寫入則需要。上傳後的驗證可以透過鏡像完成（7.8 節）。

**版本標記。** `seq` 是嚴格遞增的發布計數，儲存在 `manifest.json` 中（若該值未超過目前已發布 manifest 的值，發布程式會提出警告）。`version` 是 UTC 發布時間；內容身分是 `treeSha256`（5.4 節）。

### 4.5 說明文件與來源

- `README.md` 是模型卡：每個模型做什麼、featurizer 契約、來自 `scripts/experiments/README.md` 的評估數字（視情況包含 auPRC/AUC/ECE/decile lift）、輸入／輸出張量形狀、如何重現、指向確切 GitHub commit 的連結，以及授權條款。
- `SOURCE.json` 記錄儲存庫、commit、產生時間與確切的 tree 雜湊，讓已發布的產物可追溯回程式碼。
- `training/` 是 `scripts/experiments/` 的**產生快照**（腳本、建置輔助工具、研究日誌）。模型卡聲明權威來源是記錄之 commit 處的 GitHub 儲存庫，且不得在 Hugging Face 上編輯該快照。
- 原始回放語料永不發布：那是使用者貢獻的對局工作階段資料。模型卡僅以彙總方式描述語料形態與過濾／同意依據。
- `NOTICE.md` 記錄 LOS 柵格由已發布的地圖幾何烘焙而來、屬性表衍生自遊戲資料，並重申 Synthetic Source License 的揭露要求。權重由回放衍生的特徵訓練而來。這與公開的 `res-latest` 通道已經在分發的資料類別相同；發布到第二個公開主機並不會改變授權條款，但確實改變了能見度，因此特別標明（第 11 節，決策 2）。

### 4.6 同步策略

GitHub 是唯一的真源。Hugging Face 是產生的發布產物：不得手工編輯、不得有第二條開發分支、不得反向同步。模型變更從本儲存庫開始（訓練腳本 + 納入發布程式輸入的產物），之後由維護者執行發布程式。因此兩個主機之間的差異由 commit 來源解釋，而非並行維護。

## 5. 已簽章的 manifest

### 5.1 範例

```json
{
  "format": 1,
  "seq": 7,
  "version": "2026-11-08T14:22:03Z",
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "source": { "repo": "langyo/wowsp", "commit": "89abcdef0123456789abcdef0123456789abcdef" },
  "resTreeSha256": "3f2a...",
  "files": [
    { "path": "fire_model.onnx", "sha256": "8ba9...", "size": 2592543,
      "kind": "fire-two-head", "featureSet": "fire-v1", "quant": "fp32" },
    { "path": "move_model.onnx", "sha256": "bc91...", "size": 2652542,
      "kind": "move-sectors-17", "featureSet": "move-v1", "quant": "fp32" },
    { "path": "advice_fire_model.onnx", "sha256": "b98f...", "size": 2595135,
      "kind": "advice-fire-attrs", "featureSet": "advice-e24", "quant": "fp32" },
    { "path": "torpedo_model.onnx", "sha256": "a7e3...", "size": 492411,
      "kind": "torpedo-three-head", "featureSet": "torpedo-e26d", "quant": "fp32" },
    { "path": "ship_attributes.json", "sha256": "2bbd...", "size": 261507 },
    { "path": "50_Gold_harbor/terrain_los.npz", "sha256": "9c1d...", "size": 172432 }
  ],
  "treeSha256": "d41d...",
  "metrics": { "fire": { "auprc": 0.32, "auc": 0.72 } },
  "key_id": "main",
  "sig": "MEUCIQ..."
}
```

### 5.2 欄位

| 欄位 | 含義 |
| --- | --- |
| `format` | manifest schema 版本（1） |
| `seq` | 嚴格遞增的發布計數；應用程式拒絕低於其上次安裝值的 manifest |
| `version` | UTC 發布時間，僅供顯示 |
| `revision` | 恰好包含所列檔案的 Hugging Face commit SHA |
| `source` | 本次發布所源自的 GitHub 儲存庫 + commit |
| `resTreeSha256` | LOS 柵格烘焙時所依據資源包的 tree 雜湊（可選；未發布 LOS 時省略） |
| `files[].path` | `<cache>/decisions` 內的目標路徑；純相對路徑，逐段校驗（`[A-Za-z0-9._-]`，不含 `..`，段內不含分隔符） |
| `files[].sha256` | 確切位元組的小寫 sha256 |
| `files[].size` | 位元組大小，用作傳輸下限／上限 |
| `files[].kind`、`featureSet`、`quant` | 模型契約 metadata；`.onnx` 條目必填，資料檔則無 |
| `treeSha256` | 內容身分：對排序後的 `path\0sha256\n` 行計算 sha256（與資源包完全相同的公式，因此同一套工具可為兩者計算雜湊） |
| `metrics` | 自訓練報告複製的顯示用 metadata |
| `key_id`、`sig` | Ed25519 簽章層 |

### 5.3 簽章與防回滾

簽章涵蓋 manifest 在**去除 `sig` 成員後**的正規 JSON——鍵排序、緊縮分隔符、UTF-8——與 `scripts/catalog_signing.py` 已實作、並由應用程式以編譯期 pin 的公鑰（`packages/app/tauri/res/keys/*.pub`）驗證的正規形式相同。簽章沿用現有的 release-digest 金鑰儀式；不引入新的金鑰對。

應用程式在解析欄位前先驗章，接著套用 `seq` 棘輪：已驗證真確但 seq 低於本機儲存值的 manifest 會被拒絕（防重放／降級）。因此鏡像最壞只能重新提供舊的已簽章 manifest，永遠無法偽造。manifest 取得失敗或簽章無效是本檢查的硬失敗——該通道刻意**沒有**「接受未經驗證的鏡像 manifest」這種回退，因為酬載是可執行的模型內容。

### 5.4 新鮮度與陳舊

`manifest.json` 從 Hugging Face 分支頭取得。鏡像快取可能在一小段時間內提供陳舊副本；陳舊的 manifest 仍是真實的，只是較舊，因此檢查要嘛以舊 seq 回報「已是最新」，要嘛等下一次檢查。發布程式的上傳順序（先產物、後 manifest）保證 manifest 絕不會指名在其 pin 修訂上尚無法解析的檔案。快取檔案只有在 sha256 與 manifest 相符時才會被接受。

## 6. 執行階段通道（`ai`）

### 6.1 註冊表與 RPC 介面

| 項目 | 變更 |
| --- | --- |
| `resources.rs` 註冊表列 | `decisions-pack` 改為 channel `ai`，trigger `boot`（靜默檢查）+ 手動，progress kind `ai-models` |
| 狀態記錄 | 把 `decisions-pack` 加入 `STAMPED_ROWS`，使 `<data>/resources/decisions-pack.json` 記錄已安裝／已檢查的時間戳 |
| 新命令 | `ai_pack_status`、`ai_pack_check`、`ai_pack_download`、`ai_pack_cancel`；清除沿用 `clear_decisions_pack`（擴充為同時移除版本戳） |
| 進度 | `wowsp://download-progress`，kind `ai-models`，每輪一個 job，逐檔分段置於 `detail` |
| webui | 設定 → 資源卡片（6.8 節）、api 模組、`rpc.ts`、webMock、parity 測試 |

### 6.2 檢查順序

1. 透過鏡像上下文解析 manifest URL 並取得 `manifest.json`（小檔案；冷啟動競速避險，之後改用黏性端點）。
2. 驗證 Ed25519 簽章與正規形式；解析；套用 seq 棘輪。
3. 與 `<cache>/.ai-version.json` 比較 `seq` / `treeSha256`（版本戳放在 `decisions/` 旁邊而非內部，讓 tree 雜湊保持純淨）。無差異 -> 回報目前狀態。
4. 當 manifest 宣告了執行中的建置無法載入的模型（見 6.6），把該發布標記為不相容，而不是下載它。

開機時的檢查是靜默的，受 TTL（24 小時）管制，且隨時可從卡片手動觸發。檢查永不進行下載；下載始終是使用者的動作。

### 6.3 逐檔下載

所有檔案都經由 `download_hub::transfer` 傳輸，`kind = "ai-models"`：

- 候選來自鏡像上下文（Hugging Face provider，revision 取自 manifest 的 pin），永不套用鏡像前綴；
- `expected_sha256` = manifest 雜湊，`min_bytes = max_bytes = size`，`total_hint = size`，`resume = true` 並使用逐檔的 part 名稱；
- 單一檔案失敗時，只有該檔案會回退到下一個端點；該輪已驗證的位元組仍保留在暫存樹中；
- 進度回報整輪的彙總位元組（`base_received`/`base_total`），外加 `detail: {file, index, files}`；取消遵循下載樞紐的標準作用範圍；
- 檔案寫入 `<cache>/.ai-staging/<path>` 之下；在每個檔案都到位並驗證通過之前，絕不觸碰現行模型包。

### 6.4 安裝前校驗

在交換之前，於阻塞任務中進行：

1. 對暫存檔案重算 `treeSha256` 並與 manifest 比較（任何多餘／缺失的檔案都會使該輪失敗）；
2. 對每個 `.onnx` 檔案，透過現有的 ONNX Runtime 封裝載入並分類：kind、輸入寬度與輸出頭必須與宣告的 `kind`/`featureSet` 相符（開火：24 x `ENTITY_DIM_V2` x `GLOBAL_DIM_V2`；移動：17 類；建議：屬性路由頭；魚雷：`TORP_GLOBAL_DIM_V2` 全域區塊）；
3. 若必要模型失敗，則拒絕該輪；可選模型（advice、torpedo）只有在 manifest 標記其為可選時，才可附帶警告地捨棄。行程中已快取的已載入模型會持續服務直到重新啟動。

這消滅了目前手工模型包無法偵測的「代次錯誤模型包」故障模式，代價是在交換前解析幾 MB 的內容。

### 6.5 安裝、版本戳與回滾

1. 把 `decisions` 更名為 `.decisions-backup`，把暫存區更名為 `decisions`；
2. 以 `{schema, seq, version, revision, treeSha256, manifestSha256, keyId, installedAt}` 寫入 `<cache>/.ai-version.json`；
3. 寫入 freshness 記錄列；成功後刪除備份；
4. 任何一步失敗（交換、版本戳、記錄）都還原備份並讓命令失敗；被取消的一輪不會動到舊模型包。

因此校驗失敗、該輪崩潰或使用者取消，都會回退到上一個可用的模型包。卡片在 `decisions` 存在後提供「清除」；已載入的工作階段會保留到重新啟動（現有行為）。

### 6.6 特徵契約

模型檔案與鏡射 Python 訓練腳本的 Rust featurizer 耦合。manifest 的 `featureSet` 值就是契約：

| 模型 | Kind | v1 特徵集 | 必需 |
| --- | --- | --- | --- |
| fire_model.onnx | 開火雙頭（24 實體 deep sets） | `fire-v1` | 是 |
| move_model.onnx | 17 類移動扇區 | `move-v1` | 是 |
| advice_fire_model.onnx | 屬性路由建議頭 | `advice-e24` | 否 |
| torpedo_model.onnx | 三頭魚雷模型 | `torpedo-e26d` | 否 |

只有當每個必要模型的特徵集都在應用程式支援的集合內，且每個可選模型的特徵集不是受支援、就是缺席時，應用程式才會接受該發布。featurizer 變更時，會在同一支修改 Rust featurizer 的 PR 中提升特徵集名稱，因此過時的應用程式永遠不會把新權重餵給錯誤的張量。

### 6.7 LOS 柵格與資源包

LOS 柵格烘焙自資源包中的地圖幾何。當資源包的地圖 GLB 變更（遊戲版本升級）時，舊柵格描述的是舊地形。manifest 的可選 `resTreeSha256` 記錄烘焙柵格時所依據的資源包 tree；應用程式會與已安裝資源包的版本戳比較，不符時仍安裝模型但跳過 LOS 檔案（現有的逐地圖查找本就容忍柵格缺失），並提示使用者先更新資源包。發布程式在資源包發布之後才烘焙 LOS，並記錄相同的 tree 雜湊。

### 6.8 UI、i18n 與行動端

- 設定 → 資源卡片新增：目前版本（發布時間與 tree 雜湊後綴）、逐模型列（存在狀態／大小／sha 前綴）、LOS 覆蓋率（`x/known maps`）、總大小、檢查／下載／取消按鈕、重新啟動提示，以及鏡像階梯分組（7.6 節）。
- i18n：現有 13 個 `settings.resourcesDecisions*` 鍵會擴充出檢查／下載／進度／版本／LOS 覆蓋率等字串，涵蓋八個設定 locale（en-US、zh-CN、zh-TW、ja-JP、ko-KR、fr-FR、es-ES、ru-RU）；正確性的把關者是 `scripts/check_i18n.py`。
- 行動端使用同一條通道（ONNX Runtime 已是預設 feature）。Slim APK 按需下載模型；把基線內附到安裝程式／APK 是日後的選項（第 10 節，PR4）。
- 未啟用 `ai` feature 的建置（portable 形態）不會連結 ONNX Runtime：該通道不是隱藏、就是顯示為不可用，且絕不下載無法載入的模型。

### 6.9 失敗模式

| 失敗 | 行為 |
| --- | --- |
| 無鏡像可達／manifest 4xx-5xx | 檢查失敗，現行模型包繼續服務，原因記錄於日誌並在卡片中顯示 |
| 簽章無效／seq 回退 | 硬失敗；不安裝，也不回退到未驗證的內容 |
| 檔案 sha 不符 | 捨棄該候選；嘗試下一個端點；全部失敗則該輪失敗 |
| 模型載入／kind／寬度不符 | 交換前拒絕該輪；還原舊模型包 |
| LOS 對應到不同的資源包 tree | 安裝模型，附帶說明性警告跳過 LOS |
| 磁碟已滿／取消 | 暫存區清理或保留以便續傳；現行模型包不受影響 |
| 應用程式更新、特徵集提升 | 舊模型仍保持安裝，但新版本在安裝到相容發布前不會載入它們 |

## 7. 鏡像上下文

### 7.1 目前的痛點

`github_mirror.rs` 只認得 `github.com`/`api.github.com`，並以 `{prefix}/{full-url}` 重寫。Hugging Face 鏡像則是替換端點基址、保留路徑；ModelScope 又是另一種路徑範本。內建清單重複出現在應用程式、`Cargo.toml` 的 shun metadata、`scripts/fetch_models.py`、網站下載頁、webui mock 與 relay CSP 中；只有 Cargo 那一份有漂移測試。六個消費者（`update`、`model_pack`、`data_pack`、`mod_catalog`、`changelog`、`media`）各走各的迴圈。

### 7.2 provider 模型

新模組 `packages/app/tauri/src/commands/mirror/`：

```rust
pub enum ProviderId { GitHub, HuggingFace, ModelScope }

pub enum Rewrite {
    UrlPrefix,                                  // GitHub: {prefix}/{official_url}
    Endpoint { template: &'static str },        // HF: {base}/{repo}/resolve/{rev}/{path}
                                                // MS: {base}/models/{repo}/resolve/{rev}/{path}
}

pub struct HfResource<'a> {
    pub repo: &'a str,      // "owner/name"
    pub revision: &'a str,  // pinned commit sha (validated as a plain segment)
    pub path: &'a str,      // repository-relative file path (validated segment by segment)
}

pub struct MirrorContext { /* config snapshot, provider ladders, health/last-good cache */ }

impl MirrorContext {
    pub fn candidates(&self, target: Target<'_>) -> Vec<Candidate>;
    pub fn probe(&self, provider: ProviderId) -> Vec<ProbeRow>;
    pub fn sticky(&self, provider: ProviderId) -> Option<Endpoint>;
}
```

下載樞紐仍接收 `Vec<String>` 來源：provider 解析是 (config, target) 的純函式。digest／簽章策略留在各通道中，維持「鏡像 URL 只是傳輸層、絕不是內容身分」的不變式。

### 7.3 URL 矩陣

| Provider | 官方 | 鏡像重寫 | 探測 |
| --- | --- | --- | --- |
| GitHub | `https://github.com/langyo/wowsp/releases/download/<tag>/<asset>` | `{ghproxy-prefix}/{official-url}` | 儲存庫 `releases/latest` 頁（現有） |
| Hugging Face | `https://huggingface.co/{repo}/resolve/{rev}/{path}` | `{endpoint}/{repo}/resolve/{rev}/{path}`（例如 `https://hf-mirror.com/...`） | pin 一個小檔案：`{endpoint}/{repo}/resolve/{rev}/manifest.json`，HEAD 或 `Range: bytes=0-1023`，接受 200/206 |
| ModelScope（日後） | `https://www.modelscope.cn/models/{repo}/resolve/{rev}/{path}` | 端點替換，同一範本 | HEAD `resolve/{rev}/manifest.json` |

Hugging Face API 端點（`/api/models/...`）永不進入下載路徑；若探測需要 metadata，就使用 pin 的檔案，因為匿名 API 的額度池遠比 resolver 的額度池緊。

### 7.4 選擇、健康狀態與競速避險

- 候選順序是逐 provider 的策略：GitHub 維持既有的使用者端點 -> 官方路線 -> 內建端點順序；Hugging Face 則採使用者端點 -> 內建端點 -> 官方路線（中國大陸優先）。設定面板會以與現行 GitHub 階梯相同的形式，顯示官方、內建與使用者列。
- **冷啟動**：對小檔案請求在已設定的候選之間做交錯啟動的探測／競速避險（官方 + 內建），第一個驗證通過的回應勝出；其餘取消。這避免了目前「官方優先、等 8-15 秒再回退」的行為——否則中國大陸使用者每次都得付這段等待。
- **每輪／每個 provider 的黏性端點**：一旦某個候選回應，該輪其餘部分（所有檔案）都優先使用它；失敗時從已提交的偏移在階梯內故障轉移（下載樞紐行為）。
- **健康快取**：逐端點記錄最近結果、延遲與短暫的失敗冷卻，範圍為工作階段，另加每個 provider 持久化的上次可用端點（appdata，非使用者可見設定）。使用者主動發起的探測會清除冷卻。
- 大檔案傳輸繼續使用下載樞紐既有的競速／故障轉移；上下文只負責排序來源。

### 7.5 設定與 IPC

`network-config.toml` 新增一個追加式、可選的欄位（與其餘欄位一樣採 camelCase）：

```toml
githubMirrors = ["https://ghfast.top"]
huggingfaceMirrors = ["https://hf-mirror.com", "https://hf-mirror.example"]
```

- 僅限基底端點（必須有 scheme、僅允許 https、不得含 query／fragment、去除結尾斜線、<= 8 項、去重）；官方路線是隱含的，永不儲存。
- `githubMirrors` 語意不變；舊式的單一 `githubMirror` 字串仍會折入其開頭。
- 日後的 `providerMirrors` 映射可以在不破壞舊寫法的前提下取代逐 provider 欄位。
- IPC：`mirror_ladder(provider)` 與 `mirror_probe(provider)` 回傳帶 provider 標籤的 DTO；舊的 GitHub 命名命令會保留一個版本作為薄封裝，讓 webui／api 的 parity 測試能平順切換。
- webui 抽出逐 provider 的 `useMirrorLadder(provider)` hook 與共用的階梯／探測元件；GitHub 分組留在更新頁，Hugging Face 分組放在模型卡旁。

### 7.6 端點清單與漂移檢查

唯一受追蹤的真源：`res/config/mirror-endpoints.json`（providers -> 官方端點 + 內建端點清單 + 探測目標類型）。Rust 以 `include_str!` 嵌入；Python（`fetch_models.py`）、網站與 relay CSP 允許清單則由新的 `scripts/check_mirror_endpoints.py` 消費或據以核對，該腳本接入 CI 與 `just lint`——取代目前只有 Cargo shun metadata 受測試的處境。`res/config/upstream-endpoints.json`（傳輸健康目錄）會加入新主機，讓代理／直連回退與 upstream-health 頁面認得它們。

### 7.7 實測的中國大陸行為（2026-11-08，維護者網路）

| 目標 | 結果 |
| --- | --- |
| `https://huggingface.co/api/models/...` | 連線逾時（直連路線不可用） |
| `https://hf-mirror.com/api/models/...` | 200，完整 Hub API JSON，包含 commit sha |
| `hf-mirror.com/<repo>/resolve/main/<file>` | 307 -> `/api/resolve-cache/models/<repo>/<sha>/<file>` -> 200，`Accept-Ranges: bytes` |
| 固定 commit 的 resolve | 200 |
| 經鏡像的 LFS/Xet 檔案 | 302 -> 簽章的 `cas-bridge.xethub.hf.co` URL -> 200/206（鏡像不存放 blob 位元組） |
| `www.modelscope.cn/models/<repo>/resolve/master/<file>` | 200 JSON，獨立的中國 CDN |

這就是中國大陸使用者的預設 Hugging Face 階梯為何是內建鏡像優先、官方最後，也是執行階段從不依賴 `huggingface.co` 可達的原因。

### 7.8 鏡像注意事項

- 第三方鏡像是盡力而為的公共服務，沒有正式 SLA 或條款（hf-mirror.com 是社群專案；ModelScope 的再分發條款與配額未經核實）。它們只是傳輸層：每個位元組都經過簽章／sha256 驗證，且端點可由使用者設定。
- 大檔案可能經簽章重新導向後由 Hugging Face 的 CDN 提供；該通道固定 commit 並驗證 sha256，因此陳舊或錯誤的檔案只會失敗，絕不會被接受。
- 簽章的 CDN URL 會過期（約一小時）；下載器在 403／過期時重新解析，而不是把它們快取起來。
- 用戶端永不內嵌權杖：只使用公開儲存庫。

## 8. 相容性、安全性與不變式

- **已凍結的應用程式更新通道不受影響**：`v*` 更新器、其 shun metadata 與 digest 流程都不因這一波而修改。
- **資源包不變**：仍是 GitHub `res-latest` 搭配 delta 與簽章 digest；鏡像上下文只改變候選的產生方式（GitHub 的順序與 URL 完全一致）。
- **舊用戶端不受影響**：現有用戶端都不會下載 decisions 模型包，因此新通道不產生相容性義務；資源包的傳輸格式也不會重新編排。
- **設定相容性**：新的 TOML 欄位是可選的，舊建置會忽略；降級時的設定自癒會丟棄它們（已有文件記載），應用程式則在下次升級時重新補上預設值。
- **安全性不變式**：版本與 digest 只信官方；鏡像只是傳輸層；一旦取得官方錨點即具約束力；可執行酬載採 fail-closed；儲存庫中無機密；ONNX 檔案在交換前完成（kind／寬度）校驗。
- **威脅模型**：請對照 `docs/en/designs/threat-model.md`；新增的暴露面是模型通道（公開、傳輸中未加密的內容，由簽章保護）與第三方鏡像端點（唯讀傳輸）。

## 9. 風險與緩解

| 風險 | 緩解措施 |
| --- | --- |
| 遊戲衍生的 LOS／屬性資料被公開再分發（授權問題） | 沿用現有公開資源包的先例；`NOTICE.md` 說明來源；第 11 節決策 2 |
| 第三方鏡像消失或轉為惡意 | 簽章 + sha256 驗證；端點可由使用者設定；官方路線仍是候選 |
| Hugging Face 速率限制／政策變更 | 每次安裝 46-120 個請求，遠低於匿名 resolver 額度；manifest 優先設計；重試遵守 `RateLimit`/`Retry-After` |
| Hugging Face 把小檔案改用 Xet | 下載器跟隨重新導向並支援 Range／續傳；若真發生，先端到端驗證再內建端點 |
| 特徵漂移（權重 vs Rust featurizer） | 明確的 `featureSet` 契約；應用程式端校驗；featurizer 變更時提升特徵集 |
| LOS／遊戲版本不匹配 | `resTreeSha256` 比較；附提示跳過 LOS |
| 鏡像 manifest 陳舊 | 已驗證真確的內容 + seq 棘輪；發布程式上傳順序；下次檢查重試 |
| 未簽章／惡意 manifest | fail-closed；pin 的 Ed25519 公鑰；無明文回退 |
| 發布時意外洩漏權杖 | `HF_TOKEN` 只來自環境／CI secret；依儲存庫規則做 pre-commit grep |

## 10. 落地計畫

每一步都是獨立的 worktree + PR，遵循儲存庫工作流程；**設計文件會涵蓋全部九種文件 locale**（en、zh-CN、zh-TW、ja、ko、fr、es、ru、ar）。

1. **PR1 - 鏡像上下文（行為中立）。** 抽出 `commands/mirror/`、語意完全相同的 GitHub provider、設定欄位 + sanitize + IPC 封裝、webui 通用 hook、端點清單與漂移檢查。門檻：現有階梯／設定／樞紐／upstream 測試維持全綠；沒有傳輸格式變更。
2. **PR2 - Hugging Face provider + 發布程式。** HF provider（重寫／競速避險／探測）、`scripts/publish_ai_models.py`、模型卡與授權條款範本、`just publish-ai-models`。門檻：dry-run 的 manifest 夾具、provider 單元測試、對私有測試儲存庫進行發布演練。
3. **PR3 - `ai` 通道。** `commands/ai_pack.rs`、註冊表／記錄列、安裝期 ONNX 校驗、`ship_attrs` 的模型包覆蓋、設定卡片 + i18n + RPC／webMock parity、`docs/{en,zh-CN}/designs/resources.md` 更新（locale 有該檔案者同步更新譯文列）。門檻：端到端演練（鏡像離線、錯誤 sha、錯誤 ONNX、取消、回滾）、完整 lint／test 矩陣。
4. **PR4 - 可選。** ModelScope provider／發布、GitHub Release 備援來源、安裝程式／APK 內附基線、逐地圖延遲載入 LOS。

## 11. 待定決策

1. **Hugging Face owner/repo 名稱** —— 已決定：`langyo/wowsp-d1`（公開）。帳號與寫入權杖由維護者持有；發布程式會在首次使用時建立儲存庫。
2. 針對遊戲衍生的 LOS 柵格與屬性表的**再分發聲明**：連同權重一起依現有授權條款加上來源說明發布（建議，與公開資源包一致），或把它們排除在公開模型儲存庫之外、只透過應用程式的 GitHub 資源包提供。
3. **訓練腳本快照範圍**：整個 `scripts/experiments/`（建議）還是精選子集；是否包含研究日誌。
4. **更新策略**：在 24 小時 TTL 之下於開機時靜默檢查 + 手動下載（建議），對比自動下載約 12 MB 的模型包；是否提供「自動更新模型」開關。
5. **第二個 provider**：把 ModelScope 作為一等 provider（需要帳號、金鑰與條款審查），以及／或加上 GitHub Release 備援來源。
6. **可選產物**：是否發布 `onnx-int8/` 變體與 `checkpoint.pt` 檔案，還是只發權重（建議：int8 可選，checkpoint 不發布）。
