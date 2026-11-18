const Discord = require('discord.js');
require('dotenv').config();
const func = require('../utility/functions');
const system = require('../utility/system');
const gptConfig = require('../utility/gptConfig');
const notify = require('../utility/notify');
const llm = require('../utility/llm');

const MAX_DEPTH = 200;

/** 多人頻道中 role 無法分辨發話者，故在使用者訊息前標上暱稱（格式同步寫在 system prompt）。 */
function speakerOf(msg) {
    return msg.member?.displayName || msg.author.displayName || msg.author.username;
}

async function buildHistory(channel, referenceId, botId, depth) {
    if (!referenceId || depth <= 0) return [];

    let msg;
    try {
        msg = await channel.messages.fetch(referenceId);
    } catch {
        return [];
    }

    const parent = await buildHistory(channel, msg.reference?.messageId, botId, depth - 1);

    const isBot = msg.author.id === botId;
    const text = msg.content.replace(/<@!?\d+>/g, '').trim() || '(empty)';

    return [...parent, {
        role: isBot ? 'assistant' : 'user',
        text: isBot ? text : `[${speakerOf(msg)}]: ${text}`,
    }];
}

module.exports = {
    name: "message",
    event: Discord.Events.MessageCreate,
    async execute(client, msg) {
        if (msg.webhookId) return;
        if (msg.author.bot) return;
        // 私訊不經頻道白名單，等同任何人都能無限制消耗 API 額度，故一律不回應。
        if (!msg.guild) return;
        // mentions.has() 預設連 @everyone 與身分組提及都算命中（見 MessageMentions#has），
        // 會被當成免費觸發器；只認直接 @ 機器人（回覆機器人並保留提及也算）。
        if (!msg.mentions.users.has(client.user.id)) return;
        // 僅在管理員以 /chatconfig 指定的頻道內才觸發（未設定則不觸發）
        if (!gptConfig.isAllowed(msg.guild.id, msg.channel.id)) return;
        if(msg.channel.permissionsFor(client.user).has(Discord.PermissionsBitField.Flags.SendMessages) === false) return;

        const prompt = msg.content.replace(/<@!?\d+>/g, '').trim();

        // 取得第一張圖片或附件
        const imageAttachment = msg.attachments.find(a => a.contentType?.startsWith('image/'));
        if (!prompt && !imageAttachment) return;

        console.log(`message command, from: ${msg.guild.name}, user: ${msg.author.tag} (ID: ${msg.author.id})`);

        await msg.channel.sendTyping();

        // 若有圖片，下載並轉為 base64
        let image = null;
        if (imageAttachment) {
            try {
                const res = await fetch(imageAttachment.url);
                const buffer = await res.arrayBuffer();
                image = { mimeType: imageAttachment.contentType, data: Buffer.from(buffer).toString('base64') };
            } catch (e) {
                console.error('Failed to fetch image attachment:', e);
            }
        }

        const history = msg.reference?.messageId
            ? await buildHistory(msg.channel, msg.reference.messageId, client.user.id, MAX_DEPTH)
            : [];

        try {
            const toolCtx = { userId: msg.author.id, guild: msg.guild };
            const { text, usage: { inputTokens, outputTokens, cost }, emptyReason } = await llm.chat({
                botName: client.user.username,
                history,
                message: { text: prompt ? `[${speakerOf(msg)}]: ${prompt}` : undefined, image },
                ctx: toolCtx,
                webSearch: true,
            });
            system.recordUsage(
                msg.author.id, msg.author.username,
                inputTokens, outputTokens, cost
            );

            // 回應可能沒有文字（被安全過濾擋下、輸出額度用盡、或空回應）→ 給明確訊息而非丟例外
            if (emptyReason) {
                await msg.reply(`這次沒有產生內容（${emptyReason}），換個說法再試試看。`);
                return;
            }

            // AI 產生的內容不允許觸發 @everyone／身分組／任意成員提及，避免被誘導轟炸
            const sends = func.sliceByWordCount(text, 1950);
            await msg.reply({ content: sends[0], allowedMentions: { parse: [], repliedUser: true } });
            for (let i = 1; i < sends.length; i++) {
                await msg.channel.send({ content: sends[i], allowedMentions: { parse: [] } });
            }
        } catch (err) {
            notify.error('處理 chat 時發生錯誤', err);
            // 依錯誤的 status 判斷，而非比對訊息字串（回應內文含 "429" 也會誤判）。
            // 這裡是重試 2 次後仍然失敗的情況。
            if (llm.isOverloaded(err)) {
                await msg.reply(`逼逼! 能量飲料耗光了...`);
                return;
            }
            console.error(err);
            await msg.reply('在處理過程中發生意外的錯誤：```' + err + '```請稍後再試一次。\n' + `<@${process.env.AUTHOR_USERID}>`).catch(
                async () => await msg.channel.send(`<@${msg.author.id}> 在處理過程中發生意外的錯誤：\`\`\`${err}\`\`\`請稍後再試一次。\n<@${process.env.AUTHOR_USERID}>`)
            )
        }
    }
}