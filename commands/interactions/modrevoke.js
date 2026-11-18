const Discord = require('discord.js');
const { PermissionFlagsBits, InteractionContextType } = require('discord.js');
const moderation = require('../../utility/moderation.js');
const perm = require('../../utility/permission.js');
require('dotenv').config();

module.exports = {
    tag: "interaction",
    data: new Discord.SlashCommandBuilder()
        .setName("modrevoke")
        .setDescription("撤回一筆處分紀錄（禁言會同時解除）")
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addIntegerOption(o => o.setName("id").setDescription("處分編號").setRequired(true).setMinValue(1)),

    async execute(client, interaction) {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers)) {
            await interaction.reply({ content: '你沒有撤回處分的權限（需要「禁言成員」權限）。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        const id = interaction.options.getInteger('id');
        const p = moderation.getPunishment(id);
        if (!p || p.guild_id !== interaction.guildId) {
            await interaction.reply({ content: `找不到本伺服器的處分 #${id}。`, flags: Discord.MessageFlags.Ephemeral });
            return;
        }
        // 待裁決禁言只能在裁決訊息處理：在這裡撤回會讓裁決按鈕仍可執行，也會繞過裁決的權限限制。
        if (p.source === 'escalation_freeze') {
            await interaction.reply({ content: `處分 #${id} 是違規過多的待裁決禁言，請在管理員告知頻道的裁決訊息處理。`, flags: Discord.MessageFlags.Ephemeral });
            return;
        }
        // 撤回停權＝解除停權，撤回需要與原處分相同的權限
        if (!perm.canPunish(interaction, p.type)) {
            const label = moderation.TYPE_LABEL[p.type] || p.type;
            await interaction.reply({ content: `你沒有${label}權限，無法撤回這筆${label}。`, flags: Discord.MessageFlags.Ephemeral });
            return;
        }
        if (p.revoked) {
            await interaction.reply({ content: `處分 #${id} 已經是撤回狀態。`, flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        await interaction.deferReply({ flags: Discord.MessageFlags.Ephemeral });

        // 統一撤回流程：標記 + 解除禁言/unban + 於處分頻道發布撤回標示
        const res = await moderation.revokePunishmentFull(interaction.guild, id, interaction.user.id);
        if (!res.ok) {
            await interaction.editReply(res.error || '撤回失敗。');
            return;
        }
        const warn = res.unmuteErr ? `\n⚠️ 解除禁言失敗：${res.unmuteErr}` : res.unbanErr ? `\n⚠️ 解除停權失敗：${res.unbanErr}` : '';
        await interaction.editReply(`✅ 已撤回處分 #${id}，並已於處分頻道發布撤回標示。${warn}`);
    }
};
