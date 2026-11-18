const { Anthropic } = require('@anthropic-ai/sdk');
const aiTools = require('./aiTools.js');
require('dotenv').config();

// Claude 的 provider adapter，經由 utility/llm.js 呼叫。
// 金鑰由 SDK 自動讀取 ANTHROPIC_API_KEY。暫時性錯誤（429、5xx、529 過載）交給 SDK 內建的重試
// （預設 2 次、會參考 retry-after），不另外包 withRetry，避免重試次數相乘。
// thinking 未設定時為 adaptive（Haiku 5.5 起預設開啟），深度以 effort 控制；thinking token 計入
// max_tokens，也已含在 usage.output_tokens 內（不像 Gemini 要另外加）。

// 單則訊息最多再送幾輪（自訂工具回傳結果、或 web search 的 pause_turn 續跑）；每一輪都會重送整段上下文、另外計費。
const MAX_TOOL_ROUNDS = 3;

// Claude 接受的圖片格式與單張大小上限；不符合的改以文字說明，避免整個請求被 400 拒絕。
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

// 用基本版 web search：_20260209 版的動態過濾會在背後跑 code execution，行為與費用較難預期。
// 每次搜尋另計費（見 models.json 的 searchPricePer1K），搜尋結果也算 input token，故限制單則次數。
const WEB_SEARCH = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 3,
    user_location: { type: 'approximate', country: 'TW', timezone: 'Asia/Taipei' },
};

// 延遲建立：未設定金鑰時只有實際選用 Claude 才會出錯，不影響機器人啟動。
let client = null;
function getClient() {
    return client ??= new Anthropic();
}

/** 自訂工具（aiTools，依 ctx 篩選可用者）＋可選的 web search。 */
function tools(ctx, webSearch) {
    const list = aiTools.declarations(ctx).map(d => ({
        name: d.name,
        description: d.description,
        input_schema: d.parametersJsonSchema,
    }));
    return webSearch ? [...list, WEB_SEARCH] : list;
}

function baseParams(profile) {
    return {
        model: profile.name,
        max_tokens: profile.maxOutputTokens,
        output_config: { effort: profile.effort },
    };
}

/** llm.js 的中立訊息格式轉成 Claude 的 content blocks。 */
function contentOf({ text, image }) {
    const content = [];
    if (image) {
        const bytes = Math.floor(image.data.length * 3 / 4);
        if (!IMAGE_TYPES.has(image.mimeType)) {
            content.push({ type: 'text', text: `（附上了一張 ${image.mimeType} 格式的圖片，無法讀取）` });
        } else if (bytes > IMAGE_MAX_BYTES) {
            content.push({ type: 'text', text: '（附上了一張超過 5 MB 的圖片，無法讀取）' });
        } else {
            content.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } });
        }
    }
    if (text) content.push({ type: 'text', text });
    return content;
}

/** 工具執行結果（aiTools.run 回傳 { output } 或 { error }）轉成 tool_result block。 */
function toolResult(id, result) {
    return 'error' in result
        ? { type: 'tool_result', tool_use_id: id, content: result.error, is_error: true }
        : { type: 'tool_result', tool_use_id: id, content: JSON.stringify(result.output) };
}

/** 回應沒有可用文字時的原因說明；正常有內容則回傳 null。 */
function emptyReason(response, text, profile) {
    // 拒答時即使已產生部分文字也不採用。Haiku 沒有伺服器端的備援模型可接手。
    if (response.stop_reason === 'refusal') {
        return `模型拒絕回應${response.stop_details?.category ? `：${response.stop_details.category}` : ''}`;
    }
    if (text.trim()) return null;
    if (response.stop_reason === 'max_tokens') {
        return `回應長度超過上限（maxOutputTokens = ${profile.maxOutputTokens}，thinking 也會佔用此額度）`;
    }
    if (response.stop_reason === 'tool_use' || response.stop_reason === 'pause_turn') {
        return `工具呼叫超過 ${MAX_TOOL_ROUNDS} 輪上限`;
    }
    return response.stop_reason || '未知原因';
}

module.exports = {
    /** 介面見 llm.chat。ctx = { userId, guild }，工具一律以此認定發問者，見 aiTools。 */
    async chat(profile, { system, history, message, ctx, webSearch }) {
        const messages = [
            ...history.map(m => ({ role: m.role, content: m.text })),
            { role: 'user', content: contentOf(message) },
        ];
        const params = { ...baseParams(profile), system, tools: tools(ctx, webSearch) };
        let inputTokens = 0, outputTokens = 0, searches = 0;
        let response;

        for (let round = 0; ; round++) {
            response = await getClient().messages.create({ ...params, messages });
            inputTokens += response.usage.input_tokens;
            outputTokens += response.usage.output_tokens;
            searches += response.usage.server_tool_use?.web_search_requests ?? 0;

            const pending = response.stop_reason === 'tool_use' || response.stop_reason === 'pause_turn';
            if (!pending || round >= MAX_TOOL_ROUNDS) break;

            // assistant 回應須原樣送回（含 thinking 與 web search 的 block）。
            // pause_turn 是 web search 的伺服器端迴圈暫停，原樣送回即可續跑，不需補 user 訊息。
            messages.push({ role: 'assistant', content: response.content });
            if (response.stop_reason === 'tool_use') {
                const calls = response.content.filter(b => b.type === 'tool_use');
                const results = await Promise.all(calls.map(async b =>
                    toolResult(b.id, await aiTools.run({ name: b.name, args: b.input }, ctx))));
                messages.push({ role: 'user', content: results });
            }
        }

        if (searches) console.log(`[claude] web search ${searches} 次`);
        // 未處理長 prompt 的加價（Haiku 5.5 超過 100K input token 時單價為 5 倍），此時費用會低估。
        const cost = (inputTokens / 1_000_000) * profile.inputPricePerM
            + (outputTokens / 1_000_000) * profile.outputPricePerM
            + (searches / 1000) * (profile.searchPricePer1K ?? 0);

        const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
        return { text, usage: { inputTokens, outputTokens, cost }, emptyReason: emptyReason(response, text, profile) };
    },

    /**
     * 以指定模型設定送一次極短的請求，確認模型名稱、effort 與工具組合可用。失敗時丟出原始錯誤。
     * tool_choice 設為 none：仍會驗證工具定義，但不會真的觸發搜尋而計費。
     */
    async probe(profile) {
        await getClient().messages.create({
            ...baseParams(profile),
            tools: tools(null, true),
            tool_choice: { type: 'none' },
            messages: [{ role: 'user', content: 'ping' }],
        });
    },
};
