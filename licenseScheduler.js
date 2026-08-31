function startLicenseScheduler() {
    console.log('🛡️ [LicenseScheduler] MIMI BOT đang chạy chế độ MIỄN PHÍ 100% cho mọi máy chủ.');
}

async function handleGuildCreate(guild) {
    if (!guild) return;
    console.log(`🎉 [MimiBot] Vừa tham gia máy chủ mới: ${guild.name} (${guild.id}) - Miễn phí 100%!`);
}

module.exports = {
    startLicenseScheduler,
    handleGuildCreate
};
