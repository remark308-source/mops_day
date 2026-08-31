// MOPS 重大公告抓取脚本 —— 从 n8n flow「MOPS 營業收入資訊爬蟲 v2」flow1 移植
// 对应关系：
//   node2 初始化 Session      → initSession()
//   node3 取得公告列表        → fetchAnnouncementList()
//   node4 篩選關鍵字公告      → filterAnnouncements()
//   node5 取得公告詳細內容1   → fetchDetail()
//   node6 合併資料            → mergeData()
//   node7 過濾無效資料        → mergeData 内过滤「查無相符資料」
//   node11 四级评分           → rateAnnouncement()（本地规则）
//   node12 Telegram 推送      → sendTelegram()
//   node8 格式化輸出          → formatMessage()

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = join(ROOT, 'data', 'announcements.json');
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-1003333218073';

const BASE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- node2 初始化 Session：访问首页拿 cookie ----------
let cookieJar = '';

async function initSession() {
  const res = await fetch('https://mops.twse.com.tw/mops/', {
    headers: {
      ...BASE_HEADERS,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  cookieJar = cookies.join('; ');
  console.log(`初始化 Session：HTTP ${res.status}，cookies: ${cookieJar || '无'}`);
}

// ---------- node3 取得公告列表 ----------
async function fetchAnnouncementList() {
  const res = await fetch('https://mops.twse.com.tw/mops/api/home_page/t05sr01_1', {
    method: 'POST',
    headers: {
      ...BASE_HEADERS,
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Origin: 'https://mops.twse.com.tw',
      Referer: 'https://mops.twse.com.tw/mops/',
      ...(cookieJar ? { Cookie: cookieJar } : {}),
    },
    body: JSON.stringify({ count: '0', marketKind: '' }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json();
  if (data.code && data.code !== 200) {
    throw new Error(`公告列表 API 回传错误 code=${data.code}: ${data.message || ''}`);
  }
  return data;
}

// ---------- node4 篩選關鍵字公告（原 Code 节点逻辑移植） ----------
function filterAnnouncements(data) {
  // 兼容不同层级的资料结构
  let announcements = [];
  if (data.result && Array.isArray(data.result.data)) {
    announcements = data.result.data;
  } else if (Array.isArray(data)) {
    announcements = data;
  } else if (Array.isArray(data.listData)) {
    announcements = data.listData;
  } else if (Array.isArray(data.data)) {
    announcements = data.data;
  } else if (Array.isArray(data.items)) {
    announcements = data.items;
  } else if (Array.isArray(data.list)) {
    announcements = data.list;
  } else if (Array.isArray(data.result)) {
    announcements = data.result;
  } else {
    for (const key of Object.keys(data)) {
      if (Array.isArray(data[key]) && data[key].length > 0) {
        announcements = data[key];
        break;
      }
    }
  }

  const today = new Date();
  const rocYear = today.getFullYear() - 1911;
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  const rocDate = `${rocYear}${month}${day}`;

  const keywords = ['自結', '財務業務', '營收'];
  const filtered = announcements.filter((item) => {
    const subject = item.subject || '';
    return keywords.some((kw) => subject.includes(kw));
  });

  return filtered.map((item, index) => ({
    ...item,
    _rocDate: item.url?.parameters?.date || rocDate,
    _index: index,
    _companyId: item.companyId || item.url?.parameters?.companyId,
    _serialNumber: item.url?.parameters?.serialNumber || index + 1,
  }));
}

// ---------- node5 取得公告詳細內容1（每笔间隔 500ms） ----------
async function fetchDetail(item) {
  const res = await fetch('https://mops.twse.com.tw/mops/api/t05sr01_1_detail', {
    method: 'POST',
    headers: {
      ...BASE_HEADERS,
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Origin: 'https://mops.twse.com.tw',
      Referer: 'https://mops.twse.com.tw/mops/',
      ...(cookieJar ? { Cookie: cookieJar } : {}),
    },
    body: JSON.stringify({
      companyId: item._companyId,
      serialNumber: item._serialNumber,
      date: item._rocDate,
    }),
    signal: AbortSignal.timeout(30000),
  });
  return res.json();
}

// ---------- node6 合併資料 + node7 過濾無效資料（原每笔 Code 逻辑移植） ----------
function mergeData(item, detailResponse) {
  if (detailResponse?.message === '查無相符資料') return null; // node7：过滤无效

  const listData = item;
  let detail = {};
  if (detailResponse?.result?.data) {
    detail = detailResponse.result.data;
  } else if (detailResponse?.data) {
    detail = detailResponse.data;
  } else {
    detail = detailResponse || {};
  }

  return {
    companyId: listData._companyId || listData.companyId,
    companyName: listData.companyAbbreviation || detail.companyName,
    subject: listData.subject,
    date: listData.date,
    time: listData.time,
    spokesperson: detail.spokesperson || detail.發言人,
    spokespersonTitle: detail.spokespersonTitle || detail.發言人職稱,
    eventDate: detail.eventDate || detail.事實發生日,
    description: detail.description || detail.說明 || detail.content,
    clause: detail.clause || detail.符合條款,
    _rawDetailResponse: detailResponse,
  };
}

// ---------- node11 四级评分（LLM 分析，提示词与原 n8n Gemini 节点一致） ----------
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.b.ai/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'glm-5.3-flash';
const LLM_SYSTEM_PROMPT = `你是一個專業的台灣股票分析師。請分析股票重大公告並提供簡潔的投資評分建議。(不用回應我,直接提供分析內容即可)
**重要規則: **
1.括號內數字代表負數，如(0.0.1) = -0.01
2.分析要簡潔明確，重點突出，並且如果有提供月營收或月獲利情形，應以月營收和月獲利為主要評估標準，其次才是季營收和季獲利。
3.使用評分機制建議：
🔴 強烈買進：營收大幅成長且獲利顯著改善，虧轉盈或EPS大幅提升
🟠 建議買進：營收穩定成長，獲利表現良好或持續改善
🟡 一般觀望：營收獲利表現平穩，無明顯利多或利空
🟢 需要小心：營收下滑、獲利惡化、盈轉虧或財務出現警訊

分析格式:
對每家公司提供：
-評分等級(包含中文建議)+公司名稱與代號
-關鍵財務數據 (營收年增率、EPS變化)
-評分理由 (2~3行重點說明)


評分標準:
- 營收年增率 >20% 且獲利改善 = 🔴或🟡
- 虧轉盈且營收成長 = 🔴
- 營收成長但獲利下滑 = 🟡
- EPS大幅衰退 >20% =🟢`;

async function rateWithLLM(messageText) {
  const apiKey = process.env.LLM_API_KEY;
  // 未設定 API Key 時退回本地關鍵字評分
  if (!apiKey) {
    return ruleFallback(messageText);
  }
  try {
    const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: LLM_SYSTEM_PROMPT },
          { role: 'user', content: `請分析以下股票重大公告:${messageText}` },
        ],
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      console.error(`LLM API 失敗 HTTP ${res.status}，使用本地規則評分`);
      return ruleFallback(messageText);
    }
    const data = await res.json();
    const analysis = data.choices?.[0]?.message?.content || '';
    if (!analysis) {
      console.error('LLM 回應為空，使用本地規則評分');
      return ruleFallback(messageText);
    }
    console.log(`LLM 評分完成（${LLM_MODEL}）`);
    return { analysis };
  } catch (err) {
    console.error(`LLM 調用異常(${err.message})，使用本地規則評分`);
    return ruleFallback(messageText);
  }
}

// 從 LLM 分析文字中解析出評分等級（找不到時退回本地規則）
function parseRatingFromAnalysis(analysis, text) {
  if (analysis.includes('🔴')) return { key: 'red', label: '🔴 強烈買進' };
  if (analysis.includes('🟠')) return { key: 'orange', label: '🟠 建議買進' };
  if (analysis.includes('🟢')) return { key: 'green', label: '🟢 需要小心' };
  if (analysis.includes('🟡')) return { key: 'yellow', label: '🟡 一般觀望' };
  console.error('LLM 分析中未找到評分 emoji，使用本地規則評分');
  return ruleFallback(text);
}

// 本地關鍵字評分（LLM 失敗時的兜底）
function ruleFallback(text) {
  const NEGATIVE = ['虧損', '衰退', '減少', '下滑', '盈轉虧'];
  const TURNAROUND = ['虧轉盈', '轉虧為盈'];
  const GROWTH = ['成長', '增加', '提升'];

  if (NEGATIVE.some((k) => text.includes(k))) {
    return { key: 'green', label: '🟢 需要小心' };
  }
  if (TURNAROUND.some((k) => text.includes(k))) {
    return { key: 'red', label: '🔴 強烈買進' };
  }
  if (GROWTH.some((k) => text.includes(k))) {
    return { key: 'orange', label: '🟠 建議買進' };
  }
  return { key: 'yellow', label: '🟡 一般觀望' };
}

// ---------- node8 格式化輸出（原 Set 节点逻辑移植，用于 Telegram 与网页） ----------
function formatMessage(a) {
  const getDateStr = (raw) => {
    if (!raw) return '未提供';
    const parts = String(raw).split('/');
    if (parts.length !== 3) return raw;
    const year = 1911 + parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const day = parseInt(parts[2], 10);
    return `${year}年${month}月${day}日`;
  };

  const name = a.companyName || '未提供';
  const code = a.companyId || '未提供';
  const date = getDateStr(a.date);
  const time = a.time || '未提供';
  const subject = a.subject ? a.subject.replace(/\r\n/g, ' ') : '未提供';

  const detailData = a._rawDetailResponse?.result?.data?.[0] || [];
  const clause = detailData[7] || '未提供';
  const description = detailData[9] || '未提供';

  const message =
    `\n【${name} | ${code} 】\n` +
    `    發言日期: ${date}\n` +
    `    發言時間: ${time}\n` +
    `  📌 主旨：${subject}\n` +
    `  📑 符合條款：${clause}\n` +
    `  📝 說明：${description}`;

  return { message, subject, description };
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- node12 Telegram 推送 ----------
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('未设置 TELEGRAM_BOT_TOKEN，跳过 Telegram 推送');
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Telegram 推送失败 HTTP ${res.status}: ${body}`);
  } else {
    console.log(`Telegram 推送成功 → ${TELEGRAM_CHAT_ID}`);
  }
}

// ---------- data/announcements.json 读写（保留最近 30 天） ----------
function loadHistory() {
  if (!existsSync(DATA_FILE)) return { updatedAt: '', days: {} };
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { updatedAt: '', days: {} };
  }
}

function saveHistory(history) {
  const dayKeys = Object.keys(history.days).sort().slice(-30);
  const days = {};
  for (const k of dayKeys) days[k] = history.days[k];
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(
    DATA_FILE,
    JSON.stringify({ updatedAt: new Date().toISOString(), days }, null, 2),
    'utf8'
  );
}

// ---------- 主流程 ----------
async function main() {
  await initSession();
  await sleep(500);

  // MOPS 清晨時段列表可能短暫為空，重試幾次再放棄
  let items = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const listResponse = await fetchAnnouncementList();
    items = filterAnnouncements(listResponse);
    if (items.length > 0 || attempt === 3) break;
    console.log(`第 ${attempt} 次取得的公告列表為空，30 秒後重試`);
    await sleep(30000);
  }
  console.log(`公告总数已筛选：${items.length} 条`);

  const todayKey = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const history = loadHistory();

  // 只保留當月資料：月末已由 archive.js 存檔，這裡丟棄上個月的殘留日子
  const monthPrefix = todayKey.slice(0, 7);
  for (const k of Object.keys(history.days)) {
    if (!k.startsWith(monthPrefix)) delete history.days[k];
  }

  if (items.length === 0) {
    history.days[todayKey] = [];
    saveHistory(history);
    console.log('今日无符合关键字的公告');
    return;
  }

  const results = [];
  for (const item of items) {
    const detailResponse = await fetchDetail(item);
    const merged = mergeData(item, detailResponse);
    if (!merged) {
      console.log(`跳过（查無相符資料）：${item.companyId ?? '?'}`);
    } else {
      const { message: base, subject, description } = formatMessage(merged);
      // node11：LLM 四级评分（提示词同原 n8n），失败时退回本地规则
      const llm = await rateWithLLM(base);
      let rating, message;
      if (llm.analysis) {
        const analysis = llm.analysis.trim();
        rating = parseRatingFromAnalysis(analysis, `${subject} ${description}`);
        message = `${base}\n  🤖 評分分析：${analysis.replace(/\n+/g, '\n  ')}`;
      } else {
        rating = llm;
        message = `${base}\n  ${rating.label}`;
      }
      results.push({
        companyId: merged.companyId,
        companyName: merged.companyName,
        date: merged.date,
        time: merged.time,
        subject: merged.subject,
        clause: merged.clause,
        description: merged.description,
        rating: rating.key,
        ratingLabel: rating.label,
        analysis: llm.analysis ? llm.analysis.trim() : '',
        message,
      });
      // node12：逐条推送（失败不中断）
      await sendTelegram(escapeHtml(message));
    }
    await sleep(500); // node5 原限速
  }

  history.days[todayKey] = results;
  saveHistory(history);
  console.log(`完成：${results.length} 条公告已写入 ${todayKey}`);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  main().catch((err) => {
    console.error('抓取失败：', err);
    process.exit(1);
  });
}

export { filterAnnouncements, mergeData, ruleFallback, formatMessage };
