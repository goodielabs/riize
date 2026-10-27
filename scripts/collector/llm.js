// scripts/collector/llm.js
// LLM 调用：
//   github（默认，免费）：GitHub Models，在 GitHub Actions 里用自带的 GITHUB_TOKEN，无需注册和付费
//   anthropic：Claude API（需 ANTHROPIC_API_KEY）
//   openai：任何 OpenAI 兼容接口（需 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）
import { MEMBERS, TYPES } from './config.js';

export const PROVIDER = process.env.LLM_PROVIDER || 'github';

// 免费额度有每分钟次数限制，两次调用之间至少间隔几秒
const MIN_INTERVAL_MS = Number(process.env.LLM_MIN_INTERVAL_MS ?? (PROVIDER === 'github' ? 5000 : 0));
let lastCall = 0;

export class RateLimitError extends Error {}

async function complete(system, user) {
  const wait = lastCall + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();

  if (PROVIDER === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || 'claude-haiku-5-5',
        max_tokens: 8000,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${d.error?.message || JSON.stringify(d)}`);
    return d.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }
  // GitHub Models 与其他 OpenAI 兼容接口
  const isGithub = PROVIDER === 'github';
  const base = isGithub
    ? 'https://models.github.ai/inference'
    : (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${isGithub ? process.env.GITHUB_TOKEN : process.env.LLM_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || (isGithub ? 'openai/gpt-4o-mini' : undefined),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.1,
      max_tokens: 4000,
    }),
  });
  const raw = await res.text();
  if (res.status === 429) throw new RateLimitError('今日免费额度已用完或请求太快，剩余条目下次运行再处理');
  let d;
  try { d = JSON.parse(raw); } catch { throw new Error(`LLM ${res.status}: ${raw.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`LLM ${res.status}: ${d.error?.message || raw.slice(0, 200)}`);
  return d.choices[0].message.content;
}

function parseJson(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  return JSON.parse(clean.slice(start, end + 1));
}

async function completeJson(system, user) {
  try {
    return parseJson(await complete(system, user));
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    console.warn('LLM 返回解析失败，重试一次:', e.message);
    return parseJson(await complete(system, user + '\n\n只输出合法 JSON，不要任何其他文字。'));
  }
}

const EXTRACT_SYSTEM = (today) => `你是 RIIZE（SM 娱乐男团，成员 ${MEMBERS.join(' / ')}）中文粉丝站的资讯编辑。
今天是 ${today}（韩国时间）。你会收到一批抓取到的条目（新闻、视频、官方公告或行程页面），逐条判断：

1. relevant：是否确实与 RIIZE 或其成员有关（"rise" 等普通词、同名的其他人一律 false）。
2. news：如果是一条值得粉丝知道的资讯，用中文写：
   - title：简洁的中文标题（不超过 30 字，用你自己的话，不要照抄原标题）
   - summary：1–2 句中文摘要（不超过 80 字，用你自己的话转述，不要复制原文句子）
   - importance：1–5 分。5=回归/发专/巡演官宣；4=颁奖礼、大型公演、重要成绩；3=综艺、杂志、品牌合作；2=一般花絮；1=水文或无关紧要
   - category：回归、公演、综艺、成绩、品牌、成员个人、其他 之一
   "页面"类条目（行程汇总页、官网新闻列表）不需要 news，设为 null。
3. events：从内容中提取**有明确日期**的未来或近期行程，每条：
   - date：YYYY-MM-DD（按韩国时间；年份不明时按"今天之后最近的那个日期"推断；没有具体日期就不要输出）
   - time：如 "18:00(KST)"，不确定留空
   - name：中文为主、保留英文专有名词，格式统一，例如 "MMA 2026 Melon Music Awards"、"《Insomnia》数字单曲发行"、"人气歌谣 打歌"
   - type：只能是 ${TYPES.join(' / ')} 之一（音源/MV 发布、粉丝见面会等归为 其他；音乐节目和综艺为 放送；演唱会、颁奖礼、音乐节为 公演）
   - location：城市/场馆/电视台，不确定留空
   - members：参与成员数组，全员参加写 ["全员"]，否则用上面的英文大写名
   - confidence：0–1，表示日期和内容的确定程度。官方公告明确写出 = 0.9 以上；媒体报道 = 0.7–0.85；只是传闻、"预计"、"据悉" = 0.5 以下
   - evidence：支持这条行程的原文关键信息（不超过 40 字）
   已经过去很久的活动、只是回顾的旧行程不要输出。

只输出 JSON：{"items":[{"i":0,"relevant":true,"news":{...}或null,"events":[...]}]}，每个输入条目都要有一项。`;

export async function extract(batch, today) {
  const payload = batch.map((it, i) => ({
    i,
    source: it.source.name + (it.source.official ? '（官方）' : ''),
    kind: it.source.kind === 'page' ? '页面' : '条目',
    title: it.title,
    published: it.published,
    text: it.text.slice(0, it.source.kind === 'page' ? 4000 : 800),
  }));
  const out = await completeJson(EXTRACT_SYSTEM(today), JSON.stringify(payload));
  return out.items || [];
}

// 字符串相似度判断不了的（比如中英文名字不同），交给 LLM 判断是否同一活动
export async function judgeDuplicates(pairs) {
  if (!pairs.length) return new Set();
  const system = `判断每组里"新行程"是否和"已有行程"列表中的某一条是同一个活动（同一天、同一件事，只是写法或语言不同）。
只输出 JSON：{"duplicates":[组编号,...]}`;
  const user = JSON.stringify(pairs.map((p, k) => ({ k, 新行程: p.candidate, 已有行程: p.existing })));
  const out = await completeJson(system, user);
  return new Set(out.duplicates || []);
}
