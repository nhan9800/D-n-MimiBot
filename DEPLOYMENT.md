# Triển khai Mimi

Bot triển khai lên VibeHost bằng [workflow](.github/workflows/deploy.yml); website có pipeline riêng. Workflow chỉ chạy check/test, upload mã/tài nguyên theo whitelist rồi restart Pterodactyl nếu đã cấu hình. Nó không upload `.env`, cấu hình server, economy hoặc dữ liệu runtime.

Không đánh dấu đã chạy production chỉ vì upload thành công. Restart cần cấu hình panel; xác minh commit tự động cần `MIMI_HEALTH_URL`. Hướng dẫn secrets, binary nhạc và kiểm tra trên Discord: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
