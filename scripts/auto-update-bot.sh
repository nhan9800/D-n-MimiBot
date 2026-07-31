#!/bin/bash
# Script tự động Pull code từ GitHub và Restart Bot bằng PM2 trên VPS / VibeHost
# Chạy lệnh: chmod +x scripts/auto-update-bot.sh && ./scripts/auto-update-bot.sh

echo "=========================================="
echo "   TỰ ĐỘNG CẬP NHẬT CODE MIMI BOT"
echo "=========================================="

echo "[1/3] Đang kéo mã nguồn mới nhất từ GitHub..."
git pull origin main --force

echo "[2/3] Đang kiểm tra và cài đặt thư viện mới..."
npm install --ignore-scripts

echo "[3/3] Đang khởi động lại Bot trong PM2..."
if pm2 list | grep -q "mimi-bot"; then
    pm2 restart mimi-bot
else
    pm2 start index.js --name "mimi-bot"
fi

echo "=========================================="
echo "   ĐÃ HOÀN TẤT CẬP NHẬT & RESTART BOT!"
echo "=========================================="
pm2 status mimi-bot
