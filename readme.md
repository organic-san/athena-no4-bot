### athena no.4 Discord bot
- gemini api access
- server moderation
- span detect
  
default .env file:
```
DISCORD_TOKEN=
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
BOT_USERID=
AUTHOR_USERID=
MAIN_GUILDID=
DATABASE_URL=
BACKUP_DIR=
```

### 聊天模型設定
@ 機器人與 `/chat` 經由 `utility/llm.js` 呼叫，可在 Gemini 與 Claude 之間切換（日程預告固定使用 Gemini，設定在 `config/schedule.json`）。
模型相關參數放在 `config/models.json`（隨 git 部署，不讀 .env）。每個模型是一組完整設定：
- `provider`：`gemini` 或 `claude`
- 思考深度：Gemini 用 `thinkingLevel`（`MINIMAL` / `LOW` / `MEDIUM` / `HIGH`，各模型支援的範圍不同）；
  Claude 用 `effort`（`low` / `medium` / `high` / `xhigh` / `max`）
- `maxOutputTokens`、`inputPricePerM` / `outputPricePerM`（USD / 每百萬 token，請以官方定價為準）
- `searchPricePer1K`（選填，僅 Claude）：web search 每千次的費用

thinking token 會計入 `maxOutputTokens`，也依 output 費率計價，
調高思考深度時請一併調高輸出上限，否則回應會被截斷成空內容。

- `/system model`：查看目前模型與可切換的清單
- `/system model <name>`：先送一次測試請求，成功才切換；選擇存在資料庫，立即生效、重啟後保留
- `/system pull`：拉下新版 `models.json` 後會自動重新載入
- 未曾切換時使用 `default`；選用的模型從檔案移除時也會退回 `default`

### 審核權限
審核指令依 Discord 身分組權限分層，機器人不另存管理員名單（判斷集中在 `utility/permission.js`）：

| 權限 | 可以做的事 |
|---|---|
| 禁言成員 (Moderate Members) | `/warn`、`/tempmute`、右鍵「給予處分」（只列警告、禁言）、`/close` 與其按鈕、`/modlog`、`/modrevoke`（警告、禁言）、偵測通報的「解除禁言」 |
| 踢出成員 (Kick Members) | `/kick`、處分流程的踢出、違規過多踢出裁決、撤回踢出 |
| 停權成員 (Ban Members) | `/ban`、處分流程的停權、違規過多停權裁決、偵測通報的「停權」、撤回停權 |
| 管理伺服器 (Manage Server) | `/modconfig`、`/chatconfig`、日程審核按鈕 |
| 管理員 (Administrator) | 以上全部 |
| 開發者本人（`.env` 的 `AUTHOR_USERID`） | `/system`、`/log`、`/log2`（後兩者在指令選單上只有管理員看得到） |

手動處分比照 Discord 原生規則：只能處分最高身分組比自己低的成員（管理員也一樣，伺服器擁有者例外），
不能處分自己、機器人與伺服器擁有者；對象已離開伺服器時不限制。

違規過多規則觸發踢出或停權時，一律先無限期禁言，再到管理員告知頻道發裁決訊息；
整則裁決訊息（含改判禁言、解除禁言）只有具該權限的人能操作。

**實習管理員身分組**：只開「禁言成員」，不開管理員、踢出、停權、管理身分組、管理伺服器、管理頻道、管理 Webhook。
在處分發布頻道、管理員告知頻道開放檢視；在檢舉討論串母頻道另外開放「管理討論串」，才看得到私人的檢舉討論串。
修改指令的預設權限後需重跑 `create-slash-global.js`。

contact: 
Discord @organic_kaami