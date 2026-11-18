const fs = require('fs');
const modelConfig = require('./modelConfig.js');

// 聊天模型呼叫的單一入口（@ 機器人與 /chat）。依 config/models.json 中模型的 provider
// 交給對應的 adapter，呼叫端只使用這裡的中立格式，不接觸各家 SDK。
// 模型與參數每次呼叫時才讀取，/system model 切換後立即生效。
const PROVIDERS = {
    gemini: require('./gemini.js'),
    claude: require('./claude.js'),
};

const PROMPT_FILE = './prompts/default.txt';

// system prompt 每則訊息都會用到，只在首次使用與 reloadPrompt() 時讀檔，不在 event loop 上重複同步讀檔。
let promptTemplate = null;

function systemPrompt(botName) {
    if (promptTemplate === null) promptTemplate = fs.readFileSync(PROMPT_FILE, 'utf-8');
    return promptTemplate.replaceAll('{botName}', botName);
}

module.exports = {
    /** 目前使用中的模型名稱。 */
    model() {
        return modelConfig.current().name;
    },

    /** 重新讀取 prompts/default.txt（git pull 後呼叫）。讀取失敗或內容為空時丟例外並保留原內容。 */
    reloadPrompt() {
        const text = fs.readFileSync(PROMPT_FILE, 'utf-8');
        if (!text.trim()) throw new Error(`${PROMPT_FILE} 內容為空`);
        promptTemplate = text;
    },

    /**
     * 以目前模型送出一則訊息，含工具呼叫迴圈。
     * - history：[{ role: 'user' | 'assistant', text }]，由舊到新
     * - message：{ text?, image?: { mimeType, data(base64) } }
     * - ctx：{ userId, guild }，工具一律以此認定發問者（見 aiTools）
     * - webSearch：是否開放網路搜尋（Gemini 為 Google 搜尋，Claude 為 web search，後者另計費）
     * 回傳 { text, usage: { inputTokens, outputTokens, cost }, emptyReason }；
     * emptyReason 非 null 時表示沒有可用的回覆內容。
     */
    async chat({ botName, history = [], message, ctx, webSearch = false }) {
        // 兩家都要求對話以 user 開頭。使用者回覆機器人訊息時重建出的歷史會以 assistant 開頭
        // （prefill 形式，Gemini 3.x 不建議、Claude 則直接拒絕），補一則開場 user 訊息使其合法。
        if (history[0]?.role === 'assistant') {
            history = [{ role: 'user', text: '（以下是先前的對話紀錄）' }, ...history];
        }
        const profile = modelConfig.current();
        return PROVIDERS[profile.provider].chat(profile, {
            system: systemPrompt(botName), history, message, ctx, webSearch,
        });
    },

    /**
     * 以指定模型設定送一次極短的請求，確認可用；失敗時丟出原始錯誤。
     * 用於切換模型前，避免切過去後每則訊息都失敗。
     */
    async probe(profile) {
        await PROVIDERS[profile.provider].probe(profile);
    },

    /**
     * 是否為「服務忙碌／額度用盡」這類該對使用者說軟話的錯誤（已重試仍失敗）。
     * 兩家 SDK 的錯誤都帶數字 status；529 是 Anthropic 的過載狀態碼。
     */
    isOverloaded(err) {
        return [429, 503, 529].includes(err?.status);
    },
};
