const Discord = require('discord.js');
const { ContextMenuCommandBuilder, ApplicationCommandType, PermissionFlagsBits, InteractionContextType } = require('discord.js');
const pf = require('../../utility/punishFlow.js');
const perm = require('../../utility/permission.js');
require('dotenv').config();

module.exports = {
    tag: "interaction",
    data: new ContextMenuCommandBuilder()
        .setName("給予處分")
        .setType(ApplicationCommandType.Message)
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(client, interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '此指令僅能在伺服器中使用。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }
        if (!interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers)) {
            await interaction.reply({ content: '你沒有給予處分的權限（需要「禁言成員」權限）。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        const target = interaction.targetMessage;
        if (target.author.bot) {
            await interaction.reply({ content: '無法對機器人訊息給予處分。', flags: Discord.MessageFlags.Ephemeral });
            return;
        }
        // 先擋身分組高低，免得填完理由才被拒（送出時處分流程會再檢查一次）
        const denied = await perm.targetError(interaction, target.author.id);
        if (denied) {
            await interaction.reply({ content: denied, flags: Discord.MessageFlags.Ephemeral });
            return;
        }

        // 進入統一處分流程（來源＝指定訊息）：選類型 → (mute) 選時長 → 填理由。選單只列出執行者有權限的類型。
        const token = pf.messageToken(target.channel.id, target.id);
        await interaction.reply({
            content: `請選擇要對 <@${target.author.id}> 執行的處分：`,
            components: [pf.typeSelectRow(token, interaction)],
            flags: Discord.MessageFlags.Ephemeral,
        });
    }
};
