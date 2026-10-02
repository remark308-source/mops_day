// MOPS 重大公告抓取 - Cloudflare Worker 版
// Cron（台北 08:00 / 21:30）→ 抓 MOPS → LLM 評分 → Telegram 推送 → 寫回 GitHub（Pages 展示）
// 免費版 Worker 單次約 30 秒，公告多時分批處理：進度存 KV，靠 cron 每小時接續直到清空
// 需要的 Secrets/Vars: TELEGRAM_BOT_TOKEN, LLM_API_KEY, GITHUB_TOKEN
//   可選: TELEGRAM_CHAT_ID(預設群組), LLM_BASE_URL, LLM_MODEL, CRON_SECRET(手動觸發口令)

const REPO = 'remark308-source/mops_day';
const BRANCH = 'main';
const DATA_PATH = 'data/announcements.json';
const DEFAULT_CHAT = '-1003333218073';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BATCH_MS = 20000; // 每次觸發最多跑 20 秒左右就存進度退出（留緩衝給 30 秒上限）
const KV_KEY = 'scrape_state';

const BASE_HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
};

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

// ==================== 工具 ====================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const taipeiNow = () => new Date(Date.now() + 8 * 3600 * 1000);
const taipeiDayKey = () => taipeiNow().toISOString().slice(0, 10);

function rocToday(d) {
  const y = d.getUTCFullYear() - 1911;
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

async function mopsFetch(url, options = {}, retries = 3) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      return await fetch(url, options);
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(3000);
    }
  }
  throw lastErr;
}

// ==================== MOPS ====================

async function fetchAnnouncementList() {
  const res = await mopsFetch('https://mops.twse.com.tw/mops/api/t05sr01_1', {
    method: 'POST',
    headers: {
      ...BASE_HEADERS,
      Accept: 'application/json,text/plain,*/*',
      'Content-Type': 'application/json',
      Origin: 'https://mops.twse.com.tw',
      Referer: 'https://mops.twse.com.tw/mops/',
    },
    body: JSON.stringify({ count: '0', marketKind: '' }),
  });
  const data = await res.json();
  if (data.code && data.code !== 200) throw new Error(`公告列表 API code=${data.code}`);
  return data;
}

function filterAnnouncements(data) {
  let list = [];
  if (data.result && Array.isArray(data.result.data)) list = data.result.data;
  else if (Array.isArray(data)) list = data;
  else if (Array.isArray(data.data)) list = data.data;
  else for (const k of Object.keys(data)) { if (Array.isArray(data[k]) && data[k].length > 0) { list = data[k]; break; } }

  const rocDate = rocToday(taipeiNow());
  const keywords = ['自結', '財務業務', '營收'];
  return list
    .filter((i) => keywords.some((kw) => (i.subject || '').includes(kw)))
    .map((i, idx) => ({
      companyId: i.companyId || i.url?.parameters?.companyId,
      companyAbbreviation: i.companyAbbreviation,
      subject: i.subject,
      date: i.date,
      time: i.time,
      _rocDate: i.url?.parameters?.date || rocDate,
      _serialNumber: i.url?.parameters?.serialNumber || idx + 1,
    }));
}

async function fetchDetail(item) {
  const res = await mopsFetch('https://mops.twse.com.tw/mops/api/t05sr01_1_detail', {
    method: 'POST',
    headers: {
      ...BASE_HEADERS,
      Accept: 'application/json,text/plain,*/*',
      'Content-Type': 'application/json',
      Origin: 'https://mops.twse.com.tw',
      Referer: 'https://mops.twse.com.tw/mops/',
    },
    body: JSON.stringify({ companyId: item.companyId, serialNumber: item._serialNumber, date: item._rocDate }),
  });
  return res.json();
}

function mergeData(item, detailResponse) {
  if (detailResponse?.message === '查無相符資料') return null;
  let detail = {};
  if (detailResponse?.result?.data) detail = detailResponse.result.data;
  else if (detailResponse?.data) detail = detailResponse.data;
  else detail = detailResponse || {};
  // result.data 是「外層陣列包一筆欄位陣列」（[[...]]）：欄位 7=符合條款、9=說明
  let row = [];
  if (Array.isArray(detail)) row = Array.isArray(detail[0]) ? detail[0] : detail;
  return {
    companyId: item.companyId,
    companyName: item.companyAbbreviation,
    subject: item.subject,
    date: item.date,
    time: item.time,
    clause: row[7] || detail.clause || '未提供',
    description: row[9] || detail.description || '未提供',
  };
}

// ==================== LLM 評分 ====================

async function rateWithLLM(text, env) {
  // 供應商優先序：NaraRouter（agnes-3-flash）→ OpenRouter 兩個帳號（模型鏈輪換防 429）
  const attempts = [];
  if (env.LLM_API_KEY) {
    attempts.push({
      base: env.LLM_BASE_URL || 'https://router.bynara.id/v1',
      model: env.LLM_MODEL || 'agnes-3-flash',
      key: env.LLM_API_KEY,
      label: 'nara',
    });
  }
  const orBase = env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1';
  const orModels = (env.LLM_MODELS ||
    'qwen/qwen3.8-27b:free,inclusionai/ling-3.0-flash-sante:free,nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-26b-a4b-it:free')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const orKeys = [env.LLM_API_KEY_2, env.LLM_API_KEY_3].filter(Boolean);
  for (const model of orModels) {
    for (const key of orKeys) {
      attempts.push({ base: orBase, model, key, label: 'openrouter' });
    }
  }
  if (attempts.length === 0) return ruleFallback(text);

  for (const a of attempts) {
    try {
      const res = await fetch(`${a.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.key}` },
        body: JSON.stringify({
          model: a.model,
          messages: [
            { role: 'system', content: LLM_SYSTEM_PROMPT },
            { role: 'user', content: `請分析以下股票重大公告:${text}` },
          ],
        }),
        signal: AbortSignal.timeout(25000),
      });
      const d = await res.json();
      if (res.status === 429 || res.status === 402 || res.status === 404) {
        console.log(`LLM [${a.label}] ${a.model} → ${res.status}，換下一個供應商/模型`);
        continue;
      }
      if (d.error) throw new Error(d.error.message || `HTTP ${res.status}`);
      const analysis = d.choices?.[0]?.message?.content || '';
      if (analysis) return { analysis: analysis.trim() };
    } catch (e) {
      console.log(`LLM [${a.label}] ${a.model} 失敗: ${e.message}`);
    }
  }
  return ruleFallback(text);
}

function ruleFallback(text) {
  const NEG = ['虧損', '衰退', '減少', '下滑', '盈轉虧'];
  const TURN = ['虧轉盈', '轉虧為盈'];
  const GROW = ['成長', '增加', '提升'];
  if (NEG.some((k) => text.includes(k))) return { key: 'green', label: '🟢 需要小心' };
  if (TURN.some((k) => text.includes(k))) return { key: 'red', label: '🔴 強烈買進' };
  if (GROW.some((k) => text.includes(k))) return { key: 'orange', label: '🟠 建議買進' };
  return { key: 'yellow', label: '🟡 一般觀望' };
}

function parseRating(analysis, text) {
  if (analysis.includes('🔴')) return { key: 'red', label: '🔴 強烈買進' };
  if (analysis.includes('🟠')) return { key: 'orange', label: '🟠 建議買進' };
  if (analysis.includes('🟢')) return { key: 'green', label: '🟢 需要小心' };
  if (analysis.includes('🟡')) return { key: 'yellow', label: '🟡 一般觀望' };
  return ruleFallback(text);
}

// 從公告說明中抽出含關鍵數字的行（LLM 輸入精簡 + 失敗兜底訊息共用）
function extractFigures(description, max = 4) {
  if (!description) return [];
  const SKIP = /事實發生日|公司名稱|與公司關係|持股比例|發生緣由|因應措施|應敘明|查證|記者會|精華版|營運概況|財務報表|IFRS|證券交易法|基本資料|觀測站|路徑|自願性公告/;
  const HAS_NUM = /\d+(\.\d+)?\s*(%|％)|\d[\d,.]*\s*(億|百萬|仟萬|萬元)|營業收入|稅前淨利|本期淨利|每股盈餘/;
  const lines = [];
  for (const raw of String(description).split(/[\n；;]/)) {
    const line = raw.trim().replace(/^\d+[.、]\s*/, '');
    if (line.length < 5 || SKIP.test(line)) continue;
    if (HAS_NUM.test(line)) {
      lines.push(line);
      if (lines.length >= max) break;
    }
  }
  return lines;
}

// Telegram HTML 格式工具
const tgE = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mdBold = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

// ==================== Telegram ====================

async function sendTelegram(text, env, isHtml = false) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID || DEFAULT_CHAT,
        text,
        disable_web_page_preview: true,
        ...(isHtml ? { parse_mode: 'HTML' } : {}),
      }),
    });
  } catch (e) {
    console.error('TG 推送失敗:', e.message);
  }
}

// ==================== GitHub 資料讀寫 ====================

async function ghApi(env, path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'mops-day-worker', // GitHub API 必填
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text || '{}');
}

async function readData(env) {
  const blob = await ghApi(env, `/contents/${DATA_PATH}?ref=${BRANCH}`);
  const json = decodeURIComponent(escape(atob(blob.content.replace(/\n/g, ''))));
  return { sha: blob.sha, data: JSON.parse(json) };
}

async function writeData(env, sha, data, message) {
  // btoa 只吃 latin1，先 escape 處理中文
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
  await ghApi(env, `/contents/${DATA_PATH}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content, branch: BRANCH, sha }),
  });
}

// ==================== 主流程（分批） ====================

async function runBatch(env) {
  const started = Date.now();
  const out = (m) => console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${m}`);

  // 讀進度
  let state = { day: '', queue: [], results: null, dataSha: null, baseData: null };
  if (env.MOPS_KV) {
    const saved = await env.MOPS_KV.get(KV_KEY, 'json');
    if (saved) state = saved;
  }

  const todayKey = taipeiDayKey();

  // 新的一天 / 沒有進度 → 重新開始
  if (state.day !== todayKey || !Array.isArray(state.queue)) {
    out('新的一天，抓取公告列表…');
    const listData = await fetchAnnouncementList();
    const items = filterAnnouncements(listData);
    out(`篩選後 ${items.length} 條`);

    // 讀倉庫現有資料
    const { sha, data } = await readData(env);
    // 只保留當月
    const monthPrefix = todayKey.slice(0, 7);
    for (const k of Object.keys(data.days || {})) {
      if (!k.startsWith(monthPrefix)) delete data.days[k];
    }

    state = {
      day: todayKey,
      queue: items,
      pos: 0,
      results: [],
      dataSha: sha,
      data,
      done: false,
    };
    if (items.length === 0) {
      state.data.days[todayKey] = [];
      state.data.updatedAt = new Date().toISOString();
      state.done = true;
      await writeData(env, state.dataSha, state.data, `update: 無符合關鍵字公告 ${todayKey}`);
      if (env.MOPS_KV) await env.MOPS_KV.delete(KV_KEY);
      out('今日無公告，已寫入空資料');
      return '今日無符合關鍵字的公告';
    }
  }

  // 處理佇列（受時間預算限制）
  while (state.pos < state.queue.length && Date.now() - started < BATCH_MS) {
    const item = state.queue[state.pos];
    try {
      const detailResp = await fetchDetail(item);
      const merged = mergeData(item, detailResp);
      if (merged) {
        const header = `【${merged.companyName} | ${merged.companyId}】`;
        // LLM 輸入精簡：主旨＋關鍵數字行（減少 token、避免免費模型逾時）
        const figures = extractFigures(merged.description, 8);
        const text = `${header}主旨:${merged.subject}` + (figures.length ? `\n關鍵數據:\n${figures.join('\n')}` : `\n說明:${merged.description}`);
        const llm = await rateWithLLM(text, env);
        const rating = llm.analysis ? parseRating(llm.analysis, text) : llm;
        // 純文字版存檔
        const figLines = extractFigures(merged.description, 4).map((l) => l.replace(/\s+/g, ' '));
        const messagePlain = llm.analysis
          ? `${header}\n${llm.analysis.trim()}`
          : `${header}\n${rating.label}` + (figLines.length ? '\n' + figLines.map((l) => `· ${l}`).join('\n') : '');
        // HTML 版發 Telegram：LLM 分析的 **粗體** 轉 <b>；兜底數字用等寬 <pre> 對齊
        const messageHtml = llm.analysis
          ? `${tgE(header)}\n${mdBold(tgE(llm.analysis.trim()))}`
          : figLines.length
            ? `${tgE(header)}\n${rating.label}\n<pre>${tgE(figLines.join('\n'))}</pre>`
            : `${tgE(header)}\n${rating.label}`;
        state.results.push({
          companyId: merged.companyId,
          companyName: merged.companyName,
          date: merged.date,
          time: merged.time,
          subject: merged.subject,
          clause: merged.clause,
          description: merged.description,
          rating: rating.key,
          ratingLabel: rating.label,
          analysis: llm.analysis || '',
          message: messagePlain,
        });
        await sendTelegram(messageHtml, env, true);
        out(`✅ ${merged.companyName}(${merged.companyId}) ${rating.label}`);
      } else {
        out(`跳過（查無資料）: ${item.companyId}`);
      }
    } catch (e) {
      out(`❌ ${item.companyId} 失敗跳過: ${e.message}`);
    }
    state.pos++;
    await sleep(500);
  }

  // 全部處理完 → 寫入 GitHub
  if (state.pos >= state.queue.length) {
    out(`佇列清空（${state.results.length} 條），寫入 GitHub…`);
    // 重新取 sha（批次期間資料可能被別的運行更新過）
    const { sha } = await readData(env);
    state.data.days[todayKey] = state.results;
    state.data.updatedAt = new Date().toISOString();
    await writeData(env, sha, state.data, `update: 抓取結果 ${todayKey}`);
    if (env.MOPS_KV) await env.MOPS_KV.delete(KV_KEY);
    out(`完成：${state.results.length} 條已寫入 ${todayKey}`);
    return `完成 ${state.results.length} 條`;
  }

  // 未完成 → 存進度，等下次觸發接續
  out(`本批處理到 ${state.pos}/${state.queue.length}，存進度等待接續`);
  if (env.MOPS_KV) await env.MOPS_KV.put(KV_KEY, JSON.stringify(state));
  return `進度 ${state.pos}/${state.queue.length}`;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runBatch(env).catch((e) => {
        console.error('scheduled 失敗:', e.message);
      })
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      // 手動觸發：有設 CRON_SECRET 時需帶 ?key=
      if (env.CRON_SECRET && url.searchParams.get('key') !== env.CRON_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      const result = await runBatch(env).catch((e) => `錯誤: ${e.message}`);
      return new Response(result, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return new Response('mops_day worker\nGET /run?key=... 手動觸發一批', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};
