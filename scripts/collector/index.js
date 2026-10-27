// scripts/collector/index.js
// RIIZE 行程 & 新闻自动采集器
// 流程（参考 AIHOT）：多源采集 → 去重/关键词预筛 → LLM 提取与打分 → 聚簇合并 → 与飞书已有数据去重 → 写入飞书
//
// 运行：node scripts/collector/index.js
// 环境变量：FEISHU_APP_ID, FEISHU_APP_SECRET, GITHUB_TOKEN（GitHub Actions 自动提供，免费调用 GitHub Models）
//          换用其他模型见 llm.js 顶部说明
//          DRY_RUN=1 只打印不写入；AUTO_PUBLISH=off 全部进待审核表
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { FEISHU, KEYWORDS, MEMBERS, RULES, SOURCES, TYPES } from './config.js';
import { Feishu, FT, cellText, msToDate } from './feishu.js';
import { collect } from './sources.js';
import { extract, judgeDuplicates, RateLimitError, PROVIDER } from './llm.js';
import { clusterEvents, clusterNews, similarity, SAME_EVENT } from './dedupe.js';

const STATE_FILE = new URL('./.state/seen.json', import.meta.url);
const DRY_RUN = process.env.DRY_RUN === '1';
const DAY = 86400e3;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const weekday = (date) => { const [y, m, d] = date.split('-').map(Number); return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; };
const daysFromToday = (date) => (Date.parse(date + 'T00:00:00Z') - Date.parse(kstToday() + 'T00:00:00Z')) / DAY;

async function loadSeen() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return {}; }
}
async function saveSeen(seen) {
  const cutoff = Date.now() - RULES.SEEN_TTL_DAYS * DAY;
  for (const [k, t] of Object.entries(seen)) if (t < cutoff) delete seen[k];
  await mkdir(new URL('./.state/', import.meta.url), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(seen));
}

function prefilter(items, seen) {
  const maxAge = RULES.MAX_ITEM_AGE_DAYS * DAY;
  const kw = new RegExp(KEYWORDS.join('|'), 'i');
  const uniq = new Map();
  for (const it of items) {
    if (seen[it.id] || uniq.has(it.id)) continue;
    const t = Date.parse(it.published);
    if (!isNaN(t) && Date.now() - t > maxAge) continue;
    if (!it.source.dedicated && !kw.test(it.title + ' ' + it.text)) continue;
    uniq.set(it.id, it);
  }
  return [...uniq.values()];
}

function cleanEvent(ev) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.date || '') || !ev.name) return null;
  const delta = daysFromToday(ev.date);
  if (isNaN(delta) || delta < -RULES.EVENT_PAST_DAYS || delta > RULES.EVENT_FUTURE_DAYS) return null;
  let members = (ev.members || []).map(m => String(m).toUpperCase().trim())
    .filter(m => MEMBERS.includes(m) || m === '全员');
  if (!members.length || members.includes('全员') || members.length === MEMBERS.length) members = ['全员'];
  return {
    date: ev.date,
    time: ev.time || '',
    name: String(ev.name).trim(),
    type: TYPES.includes(ev.type) ? ev.type : '其他',
    location: ev.location || '',
    members,
    confidence: Math.max(0, Math.min(1, Number(ev.confidence) || 0)),
    evidence: ev.evidence || '',
  };
}

async function main() {
  const startedAt = Date.now();
  const fs = new Feishu({
    appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET,
    nodeToken: FEISHU.NODE_TOKEN, dryRun: DRY_RUN,
  });
  await fs.init();
  const newsTableId = await fs.ensureTable(FEISHU.NEWS_TABLE_NAME, [
    { field_name: '标题', type: FT.TEXT },
    { field_name: '摘要', type: FT.TEXT },
    { field_name: '链接', type: FT.URL },
    { field_name: '来源', type: FT.TEXT },
    { field_name: '分类', type: FT.TEXT },
    { field_name: '重要度', type: FT.NUMBER },
    { field_name: '发布时间', type: FT.DATE },
  ]);

  // 1. 采集 + 预筛
  const seen = await loadSeen();
  const raw = await collect(SOURCES);
  const items = prefilter(raw, seen);
  console.log(`\n采集 ${raw.length} 条，预筛后待处理 ${items.length} 条`);

  // 2. LLM 提取
  const today = kstToday();
  const events = [];
  const news = [];
  // 官方页面优先处理，且每个页面单独一批（页面文字较长）
  const pages = items.filter(it => it.source.kind === 'page');
  const others = items.filter(it => it.source.kind !== 'page')
    .sort((a, b) => (b.source.official ? 1 : 0) - (a.source.official ? 1 : 0));
  const batches = pages.map(p => [p]);
  for (let i = 0; i < others.length; i += RULES.LLM_BATCH_SIZE) batches.push(others.slice(i, i + RULES.LLM_BATCH_SIZE));
  console.log(`使用 ${PROVIDER} 模型，共 ${batches.length} 批`);

  let rateLimited = false;
  for (const [n, batch] of batches.entries()) {
    let results;
    try {
      results = await extract(batch, today);
    } catch (e) {
      if (e instanceof RateLimitError) { console.warn('⏸  ' + e.message); rateLimited = true; break; }
      console.warn(`⚠️  第 ${n + 1} 批 LLM 失败，下次重试: ${e.message}`);
      continue;
    }
    for (const r of results) {
      const it = batch[r.i];
      if (!it) continue;
      seen[it.id] = Date.now();
      if (!r.relevant) continue;
      // Google News 按实际媒体区分来源，避免同一篇文章在不同语言版本里被算成"多源"
      const outlet = it.source.id.startsWith('gnews') ? guessOutlet(it.title) : null;
      const src = {
        id: outlet ? `outlet:${outlet}` : it.source.id,
        name: outlet || it.source.name,
        link: it.link,
        official: !!it.source.official,
      };
      for (const e of r.events || []) {
        const ev = cleanEvent(e);
        if (ev) events.push({ ...ev, sources: [src] });
      }
      if (r.news && it.source.kind !== 'page' && r.news.importance >= RULES.NEWS_MIN_IMPORTANCE) {
        const t = Date.parse(it.published);
        news.push({
          title: r.news.title, summary: r.news.summary, category: r.news.category || '其他',
          importance: Number(r.news.importance) || 1, link: it.link,
          published: isNaN(t) ? Date.now() : t,
          sourceNames: [it.source.name.replace(/^Google News .*/, guessOutlet(it.title))],
        });
      }
    }
  }

  // 3. 聚簇 + 与飞书已有行程去重
  const clustered = clusterEvents(events);
  const [scheduleRows, pendingRows] = await Promise.all([
    fs.listRecords(FEISHU.SCHEDULE_TABLE_ID),
    fs.listRecords(FEISHU.PENDING_TABLE_ID),
  ]);
  const existing = [...scheduleRows, ...pendingRows].map(r => ({
    date: typeof r.fields['日期'] === 'number' ? msToDate(r.fields['日期']) : cellText(r.fields['日期']),
    name: cellText(r.fields['活动名称']),
  })).filter(e => e.date && e.name);

  const fresh = [];
  const toJudge = [];
  for (const ev of clustered) {
    const sameDay = existing.filter(e => e.date === ev.date);
    if (sameDay.some(e => similarity(e.name, ev.name) >= SAME_EVENT)) continue;
    if (sameDay.length) toJudge.push({ ev, candidate: ev.name, existing: sameDay.map(e => e.name) });
    else fresh.push(ev);
  }
  if (toJudge.length && rateLimited) {
    toJudge.forEach(p => fresh.push({ ...p.ev, forcePending: true }));
  } else if (toJudge.length) {
    try {
      const dup = await judgeDuplicates(toJudge.map(({ candidate, existing }) => ({ candidate, existing })));
      toJudge.forEach((p, k) => { if (!dup.has(k)) fresh.push(p.ev); });
    } catch (e) {
      console.warn('重复判断失败，这些行程进待审核:', e.message);
      toJudge.forEach(p => fresh.push({ ...p.ev, forcePending: true }));
    }
  }

  // 4. 分流：高置信 + 官方/多源 → 行程表；其余 → 待审核表
  const publish = [];
  const pending = [];
  for (const ev of fresh) {
    const distinct = new Set(ev.sources.map(s => s.id)).size;
    const trusted = ev.sources.some(s => s.official) || distinct >= RULES.AUTO_PUBLISH_MIN_SOURCES;
    const auto = RULES.AUTO_PUBLISH && !ev.forcePending && ev.confidence >= RULES.AUTO_PUBLISH_MIN_CONFIDENCE && trusted;
    const link = (ev.sources.find(s => s.official) || ev.sources[0]).link;
    const srcNames = [...new Set(ev.sources.map(s => s.name))].join('、');
    const row = {
      '日期': ev.date, '星期': weekday(ev.date), '时间': ev.time, '活动名称': ev.name,
      '活动类型': ev.type, '地点': ev.location, '成员': ev.members, '链接': link,
    };
    if (auto) {
      publish.push({ ...row, '备注': `🤖 自动收录 · ${srcNames}` });
    } else {
      pending.push({
        ...row,
        '备注': `🤖 置信度 ${ev.confidence.toFixed(2)} · ${srcNames} · 依据：${ev.evidence}`,
        '审核状态': '待审核',
        '提交时间': Date.now(),
      });
    }
  }

  // 5. 新闻：聚簇 + 与最近的新闻去重
  const newsRows = await fs.listRecords(newsTableId);
  const recentTitles = newsRows
    .filter(r => Date.now() - Number(r.fields['发布时间'] || 0) < 14 * DAY)
    .map(r => cellText(r.fields['标题']));
  const freshNews = clusterNews(news)
    .filter(n => !recentTitles.some(t => similarity(t, n.title) >= 0.45));

  const nPub = await fs.createRecords(FEISHU.SCHEDULE_TABLE_ID, publish);
  const nPend = await fs.createRecords(FEISHU.PENDING_TABLE_ID, pending);
  const nNews = await fs.createRecords(newsTableId, freshNews.map(n => ({
    '标题': n.title, '摘要': n.summary, '链接': n.link, '来源': n.sourceNames.join('、'),
    '分类': n.category, '重要度': n.importance, '发布时间': n.published,
  })));
  if (!DRY_RUN) await saveSeen(seen);

  const summary = [
    `## RIIZE 采集结果 ${DRY_RUN ? '（试运行，未写入）' : ''}`,
    `- 采集 ${raw.length} 条，处理 ${items.length} 条，耗时 ${((Date.now() - startedAt) / 1000).toFixed(0)} 秒`,
    `- 提取行程 ${events.length} 条 → 聚簇后 ${clustered.length} 条 → 新增 ${fresh.length} 条`,
    `- ✅ 直接上线 ${nPub} 条：${publish.map(r => `${r['日期']} ${r['活动名称']}`).join('；') || '无'}`,
    `- 🕐 待审核 ${nPend} 条：${pending.map(r => `${r['日期']} ${r['活动名称']}`).join('；') || '无'}`,
    `- 📰 新闻 ${nNews} 条：${freshNews.map(n => n.title).join('；') || '无'}`,
  ].join('\n');
  console.log('\n' + summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
}

// Google News 标题格式为「标题 - 媒体名」，取出媒体名
function guessOutlet(title) {
  const m = title.match(/\s[-–]\s([^-–]+)$/);
  return m ? m[1].trim() : 'Google News';
}

main().catch(e => { console.error('❌', e); process.exit(1); });
