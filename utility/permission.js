const { PermissionFlagsBits } = require('discord.js');

// 處分類型對應的 Discord 權限。權限分層完全交給 Discord 身分組設定：
// 實習管理員＝有「禁言成員」(ModerateMembers)、沒有踢出／停權權限的身分組。
const NEED = {
    warn: PermissionFlagsBits.ModerateMembers,
    mute: PermissionFlagsBits.ModerateMembers,
    kick: PermissionFlagsBits.KickMembers,
    ban: PermissionFlagsBits.BanMembers,
};

module.exports = {
    /** 執行者是否具備該類型處分的權限（未知類型一律拒絕）。 */
    canPunish(interaction, type) {
        const perm = NEED[type];
        return perm !== undefined && !!interaction.memberPermissions?.has(perm);
    },

    /** 日常審核：警告、禁言、檢舉結案、查詢與撤回一般處分。 */
    canModerate(interaction) {
        return this.canPunish(interaction, 'mute');
    },

    /**
     * 檢查執行者能否處分該對象，比照 Discord 原生的身分組高低規則。
     * 處分由機器人以自己的權限執行，Discord 不會替我們擋「對身分組比自己高的人出手」，
     * 不檢查的話，實習可以禁言或連續警告比自己高的人（警告累積還會觸發違規過多的無限期禁言）。
     * 規則：不能處分自己、機器人、伺服器擁有者；擁有者可處分任何人；
     * 其餘需執行者最高身分組高於對象（同位階也不行，管理員一樣受限）。對象已不在伺服器時不限制。
     * @returns {Promise<string|null>} 不能處分時回傳原因，可以處分時回傳 null。
     */
    async targetError(interaction, targetUserId) {
        const guild = interaction.guild;
        if (targetUserId === interaction.user.id) return '不能處分自己。';
        if (targetUserId === guild.ownerId) return '不能處分伺服器擁有者。';

        const target = await guild.members.fetch(targetUserId).catch(() => null);
        if (!target) return null;
        if (target.user.bot) return '不能處分機器人。';
        if (interaction.user.id === guild.ownerId) return null;

        const executor = await guild.members.fetch(interaction.user.id).catch(() => null);
        if (!executor) return '無法確認你的身分組，請稍後再試。';
        if (executor.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
            return '對方的身分組不低於你，無法處分。';
        }
        return null;
    },
};
