const { GoogleGenAI, ApiError } = require('@google/genai');
const aiTools = require('./aiTools.js');
require('dotenv').config();

// Gemini 的 provider adapter。聊天功能請經由 utility/llm.js 呼叫，不要直接使用本檔；
// schedule.js 用到 Gemini 專屬功能（JSON schema 輸出、mediaResolution），直接使用 ai 與 withRetry。
// 注意：thinking token 會一併計入 maxOutputTokens，調高 thinkingLevel 時輸出上限必須跟著調高，
// 否則額度會被 thinking 吃光而回傳空內容（finishReason = MAX_TOKENS）。

// 暫時性錯誤：值得退避重試。其餘（400 參數錯誤、403 金鑰問題等）重試沒有意義。
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

// 單則訊息最多執行幾輪工具呼叫；每一輪都會重送整段上下文、另外計費。
const MAX_TOOL_ROUNDS = 3;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/** 取得錯誤的 HTTP 狀態碼；非 API 錯誤（如網路層失敗）回傳 null。 */
function statusOf(err) {
    // SDK 對所有 4xx/5xx 回應都會丟出帶 status 的 ApiError。
    // 同時比對 name，避免 CJS/ESM 各載入一份時 instanceof 失效。
    if ((err instanceof ApiError || err?.name === 'ApiError') && typeof err.status === 'number') {
        return err.status;
    }
    return typeof err?.status === 'number' ? err.status : null;
}

/** 對暫時性錯誤退避重試（0.5s、1s，含抖動避免重試同時湧入）。 */
async function withRetry(fn, retries = 2) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt >= retries || !RETRYABLE.has(statusOf(err))) throw err;
            const delay = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
            console.warn(`[gemini] ${statusOf(err)}，${delay}ms 後重試（第 ${attempt + 1}/${retries} 次）`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

/** 依模型設定組出 thinking 與輸出上限。 */
function generationParams(profile) {
    return {
        maxOutputTokens: profile.maxOutputTokens,
        thinkingConfig: { thinkingLevel: profile.thinkingLevel },
    };
}

/** tools 設定：自訂工具（aiTools，依 ctx 篩選可用者）＋可選的 Google 搜尋。 */
function tools(ctx, googleSearch) {
    const list = [{ functionDeclarations: aiTools.declarations(ctx) }];
    if (!googleSearch) return { tools: list };
    // 內建工具與自訂工具並用（Gemini 3 起支援，目前為 Preview）時，官方範例皆開啟此旗標。
    return {
        tools: [{ googleSearch: {} }, ...list],
        toolConfig: { includeServerSideToolInvocations: true },
    };
}

/**
 * 由 usageMetadata 取出計費用的 token 數與依模型單價估算的費用（USD）。
 * thinking token 不含在 candidatesTokenCount 內，但 Google 依 output 費率計價，須合併。
 */
function usageOf(response, profile) {
    const usage = response?.usageMetadata;
    const inputTokens = usage?.promptTokenCount || 0;
    const outputTokens = (usage?.candidatesTokenCount || 0) + (usage?.thoughtsTokenCount || 0);
    return {
        inputTokens,
        outputTokens,
        cost: (inputTokens / 1_000_000) * profile.inputPricePerM + (outputTokens / 1_000_000) * profile.outputPricePerM,
    };
}

/** 回應沒有可用文字時的原因說明；正常有內容則回傳 null。 */
function emptyReason(response, profile) {
    if (response?.text && response.text.trim()) return null;
    if (response?.functionCalls?.length) return `工具呼叫超過 ${MAX_TOOL_ROUNDS} 輪上限`;

    const finish = response?.candidates?.[0]?.finishReason;
    if (finish === 'MAX_TOKENS') {
        return `回應長度超過上限（maxOutputTokens = ${profile.maxOutputTokens}，thinking 也會佔用此額度）`;
    }

    const blocked = response?.promptFeedback?.blockReason;
    return blocked || finish || '未知原因';
}

/** llm.js 的中立訊息格式轉成 Gemini 的 parts。 */
function partsOf({ text, image }) {
    const parts = [];
    if (image) parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
    if (text) parts.push({ text });
    return parts;
}

module.exports = {
    ai,
    withRetry,

    /** 介面見 llm.chat。ctx = { userId, guild }，工具一律以此認定發問者，見 aiTools。 */
    async chat(profile, { system, history, message, ctx, webSearch }) {
        const chatSession = ai.chats.create({
            model: profile.name,
            config: { systemInstruction: system, ...generationParams(profile), ...tools(ctx, webSearch) },
            history: history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })),
        });

        // 模型要求呼叫工具時執行並回傳結果，直到產生最終回覆（最多 MAX_TOOL_ROUNDS 輪）。usage 為各輪加總。
        let response = await withRetry(() => chatSession.sendMessage({ message: partsOf(message) }));
        const usage = usageOf(response, profile);

        for (let round = 0; round < MAX_TOOL_ROUNDS && response.functionCalls?.length; round++) {
            const parts = await Promise.all(response.functionCalls.map(async call => ({
                functionResponse: { id: call.id, name: call.name, response: await aiTools.run(call, ctx) },
            })));
            response = await withRetry(() => chatSession.sendMessage({ message: parts }));
            const u = usageOf(response, profile);
            usage.inputTokens += u.inputTokens;
            usage.outputTokens += u.outputTokens;
            usage.cost += u.cost;
        }
        return { text: response.text || '', usage, emptyReason: emptyReason(response, profile) };
    },

    /** 以指定模型設定送一次極短的請求，確認模型名稱、thinkingLevel 與工具組合可用。失敗時丟出原始錯誤。 */
    async probe(profile) {
        await ai.models.generateContent({
            model: profile.name,
            contents: 'ping',
            config: { ...generationParams(profile), ...tools(null, true) },
        });
    },
};
