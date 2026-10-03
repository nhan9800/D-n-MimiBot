#!/usr/bin/env bash
# Chạy thủ công trên VPS có PM2. Dừng ngay nếu pull/cài đặt/kiểm tra thất bại.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain)" ]; then
    echo 'Workspace có thay đổi chưa commit. Cần xử lý trước khi cập nhật.' >&2
    exit 1
fi
git pull --ff-only origin main
# Trên host thật cần install script để cài ffmpeg/yt-dlp/native codec.
npm ci
npm run check
npm test
if pm2 describe mimi-bot >/dev/null 2>&1; then
    pm2 restart mimi-bot --update-env
else
    pm2 start index.js --name mimi-bot
fi
pm2 status mimi-bot
