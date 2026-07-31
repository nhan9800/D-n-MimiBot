# docs/DATABASE.md — CẤU TRÚC DỮ LIỆU & STORAGE SCHEMAS

## 1. TỔNG QUAN

MimiBot sử dụng cơ chế lưu trữ JSON nguyên tử (Atomic File Storage) để đảm bảo tốc độ và không phụ thuộc vào service database bên ngoài.

---

## 2. CÁC FILE LƯU TRỮ CHÍNH

### A. `config.json` (Cấu hình Server)
```ts
interface GuildConfig {
  welcomeChannelId?: string;
  isVerifySetup?: boolean;
  verifyDailyMode?: boolean;
  unverifiedRoleId?: string;
  verifiedRoleId?: string;
  verifyChannelId?: string;
  attendanceEnabled?: boolean;
  attendanceChannelId?: string;
  logChannelId?: string;
  weeklyReportChannelId?: string;
  bannedWords?: string[];
  prefix?: string;
}
```

### B. `economy.json` (Số dư & Thu nhập)
```ts
interface UserEconomy {
  balance: number;
  lastDaily: string; // YYYY-MM-DD
  dailyEarnings?: {
    dateKey: string;
    totalEarned: number;
    alertSent: boolean;
    sources: Record<string, number>;
  };
}
```

### C. `created_channels.json` (Voice room tạm thời)
Lưu danh sách ID kênh voice room được tạo tự động bởi tính năng Join to Create.
