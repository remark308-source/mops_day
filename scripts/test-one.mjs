// 單條驗證腳本：抓列表 → 取 1 條公告 → LLM 評分 → 列印將發送到 Telegram 的訊息（不發送、不寫檔）
import {
  initSession,
  fetchAnnouncementList,
  filterAnnouncements,
  fetchDetail,
  mergeData,
  formatMessage,
  rateWithLLM,
  parseRatingFromAnalysis,
} from './scrape.mjs';

const idx = parseInt(process.argv[2] || '0', 10);

await initSession();
const listResponse = await fetchAnnouncementList();
const items = filterAnnouncements(listResponse);
if (items.length === 0) {
  console.log('目前無符合關鍵字的公告');
  process.exit(0);
}
const item = items[Math.min(idx, items.length - 1)];
console.log(`測試第 ${Math.min(idx, items.length - 1) + 1}/${items.length} 條：${item.companyId ?? '?'}`);

const detailResponse = await fetchDetail(item);
const merged = mergeData(item, detailResponse);
if (!merged) {
  console.log('查無相符資料，無法測試');
  process.exit(0);
}

const { message: base, subject, description } = formatMessage(merged);
const llm = await rateWithLLM(base);
const rating = llm.analysis
  ? parseRatingFromAnalysis(llm.analysis.trim(), `${subject} ${description}`)
  : llm;
const header = `【${merged.companyName || '未提供'} | ${merged.companyId || '未提供'}】`;
const message = llm.analysis
  ? `${header}\n${llm.analysis.trim()}`
  : `${base}\n  ${rating.label}`;

console.log('===== 準備發送到 Telegram 的訊息 =====');
console.log(message);
console.log(`===== 評分徽章：${rating.label} =====`);
