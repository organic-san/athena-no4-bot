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

contact: 
Discord @organic_kaami