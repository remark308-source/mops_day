// 每月最後一天 21:00（台北）由 GitHub Actions 呼叫：
// 把當月重大公告存檔到 data/archive/，並清空 announcements.json 讓下個月從零開始
const fs = require('fs');
const path = require('path');

const FORCE = process.env.ARCHIVE_FORCE === '1'; // 手動測試用

function main() {
    const nowTpe = new Date(Date.now() + 8 * 3600 * 1000); // 台北時間 (UTC+8)
    const lastDay = new Date(nowTpe.getFullYear(), nowTpe.getMonth() + 1, 0).getDate();
    if (!FORCE && nowTpe.getDate() !== lastDay) {
        console.log('今天不是當月最後一天，跳過存檔');
        return;
    }

    const monthKey = `${nowTpe.getFullYear()}-${String(nowTpe.getMonth() + 1).padStart(2, '0')}`;
    const dataFile = path.join(__dirname, '../data/announcements.json');

    if (!fs.existsSync(dataFile)) {
        console.log('找不到 announcements.json，跳過');
        return;
    }

    let data = {};
    try { data = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch (e) {}
    const days = data.days || {};

    // 只歸檔當月「有公告內容」的日子
    const monthDays = {};
    for (const [k, v] of Object.entries(days)) {
        if (k.startsWith(monthKey) && Array.isArray(v) && v.length > 0) monthDays[k] = v;
    }

    if (Object.keys(monthDays).length > 0) {
        const archiveDir = path.join(__dirname, '../data/archive');
        if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
        const archivePath = path.join(archiveDir, `announcements_${monthKey}.json`);
        fs.writeFileSync(
            archivePath,
            JSON.stringify({ month: monthKey, days: monthDays }, null, 2)
        );
        console.log(`已存檔 ${Object.keys(monthDays).length} 天 → data/archive/announcements_${monthKey}.json`);
    } else {
        console.log('當月沒有可存檔的公告資料');
    }

    // 清空頁面資料
    fs.writeFileSync(
        dataFile,
        JSON.stringify({ updatedAt: new Date().toISOString(), days: {} }, null, 2)
    );
    console.log('announcements.json 已清空，下個月從零開始');
}

main();
