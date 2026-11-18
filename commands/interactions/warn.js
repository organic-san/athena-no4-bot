const Discord = require('discord.js');
const { PermissionFlagsBits, InteractionContextType } = require('discord.js');
const moderation = require('../../utility/moderation.js');
const pf = require('../../utility/punishFlow.js');
const perm = require('../../utility/permission.js');
require('dotenv').config();

module.exports = {
    tag: "interaction",
    data: new Discord.SlashCommandBuilder()
        .setName("warn")
        .setDescription("對指定成員給予警告（累積會觸發違規過多）")
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(o => o.setName("user").setDescription("處分對象").setRequired(true))
        .addStringOption(o => o.setName("reason").setDescription("處分理由").setRequired(true).setMaxLength(500)),

    async execute(client, interaction) {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers)) {
            await interaction.reply({ content: '你沒有警告成員的權限（需要「禁言成員」權限）。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        const target = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason");
        const denied = await perm.targetError(interaction, target.id);
        if (denied) {
            await interaction.reply({ content: denied, flags: Discord.MessageFlags.Ephemeral });
            return;
        }
        await interaction.deferReply();

        // 與右鍵流程相同，但不產生證據圖（evidenceSrc 省略）
        const { pid } = await moderation.finalizePunishment({
            guild: interaction.guild, executorId: interaction.user.id,
            targetUserId: target.id, type: 'warn', durationMin: null,
            reason, source: 'manual',
        });

        // 公開告知 + 30 秒撤回按鈕（限原處分者）
        const embed = pf.buildPunishNotice({ executorId: interaction.user.id, targetUserId: target.id, type: 'warn', reason, pid });
        await interaction.editReply({ embeds: [embed], components: [pf.revokeRow(pid, interaction.user.id)] });
        setTimeout(() => interaction.editReply({ components: [] }).catch(() => {}), pf.REVOKE_WINDOW_MS);
    }
};
