# mops_day - Cloudflare Worker 部署說明

GitHub Actions 的 IP 被 MOPS 間歇性封鎖（TCP RESET），Cloudflare Workers 的出口 IP 實測可正常存取
（2026-09 測試：HTTP 200、452 筆、1.2s）。抓取邏輯改在 Worker 上跑，結果照舊寫回本倉庫的
`data/announcements.json`，GitHub Pages 展示不受影響。

## 部署步驟（一次性，約 10 分鐘）

1. **建立 KV namespace**（存分批進度）：
   ```bash
   npx wrangler kv namespace create MOPS_KV
   ```
   把輸出的 `id` 填進 `wrangler.toml` 的 `[[kv_namespaces]]`。

2. **設定 Secrets**（Dashboard → Workers → mops-day → Settings → Variables，或用 wrangler）：
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put LLM_API_KEY
   npx wrangler secret put GITHUB_TOKEN      # 需要 contents:write 權限
   npx wrangler secret put TELEGRAM_CHAT_ID  # 可選，預設 -1003333218073
   npx wrangler secret put CRON_SECRET       # 可選，保護 /run
   ```

3. **部署**：
   ```bash
   npx wrangler deploy
   ```

4. **驗證**：
   - 瀏覽器開 `https://mops-day.<你的子網域>.workers.dev/run?key=<CRON_SECRET>`
   - 回傳「進度 x/y」→ 等一次 cron 接續，或再手動 /run 幾次直到「完成 N 條」
   - 到 GitHub 倉庫看 `data/announcements.json` 更新、TG 群收到訊息

## 運作方式

- **Cron**：UTC 11:00 / 15:00（台北 19:00 / 23:00）自動觸發
- **分批**：免費版 Worker 單次約 30 秒上限，每次觸發處理約 20 秒的量，
  進度（佇列位置＋已抓結果）存 KV，下一輪接續，直到佇列清空寫入 GitHub
- **接續觸發**：cron 是定時的，批次之間最多隔一小時；想快一點就手動多打幾次 /run
- **月末存檔**：原本的 `scripts/archive.js`（GitHub Actions）保留不動，仍由 Actions 每月最後一天執行
- **LLM 評分**：glm-5.3-flash，提示詞與原 n8n 一致；失敗自動退回本地關鍵字規則

## 本機 CLI 仍可用

`scripts/scrape.mjs` 保留，本機網路可直接跑（不受資料中心封鎖影響）：
```bash
node scripts/scrape.mjs
```

## 注意

- Worker 免費版每天 10 萬次請求、cron 觸發次數無限制，本場景用量極小
- MOPS 若連 Cloudflare IP 也封鎖（目前未發生），可再評估自架 runner
