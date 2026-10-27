// scripts/collector/config.js
// 采集器配置：信源、关键词、自动发布规则。改信源只需要改这个文件。

export const FEISHU = {
  NODE_TOKEN: 'JNj8wQqEhiFGfIkr7UYc7ztrnpb',
  SCHEDULE_TABLE_ID: 'tblY12iWOpwtIhJf', // 行程表（网站展示）
  PENDING_TABLE_ID: 'tblSL3YruFJAfVjH',  // 待审核行程表
  NEWS_TABLE_NAME: '新闻',                // 不存在会自动创建
};

export const MEMBERS = ['SHOTARO', 'EUNSEOK', 'SUNGCHAN', 'WONBIN', 'SOHEE', 'ANTON'];
export const TYPES = ['放送', '公演', '签售', '直播', '杂志', '其他'];

// 标题/摘要里出现这些词才送去 LLM（专门的 RIIZE 信源不过滤）
export const KEYWORDS = [
  'riize', '라이즈', 'ライズ',
  'shotaro', 'eunseok', 'sungchan', 'wonbin', 'sohee', 'anton',
  '쇼타로', '은석', '성찬', '원빈', '소희', '앤톤',
];

const gnews = (hl, gl, ceid) =>
  `https://news.google.com/rss/search?q=RIIZE+when:7d&hl=${hl}&gl=${gl}&ceid=${ceid}`;

// kind: rss = 文章列表；page = 行程/公告页面（整页交给 LLM 提取行程）；youtube = 官方频道上新
// official: true 表示官方渠道，提取到的行程可信度更高
// dedicated: true 表示信源本身只发 RIIZE 内容，不做关键词过滤
export const SOURCES = [
  { id: 'gnews-ko', name: 'Google News 韩国', kind: 'rss', url: gnews('ko', 'KR', 'KR:ko'), dedicated: true },
  { id: 'gnews-en', name: 'Google News 英文', kind: 'rss', url: gnews('en-US', 'US', 'US:en'), dedicated: true },
  { id: 'gnews-ja', name: 'Google News 日本', kind: 'rss', url: gnews('ja', 'JP', 'JP:ja'), dedicated: true },
  { id: 'gnews-tw', name: 'Google News 繁中', kind: 'rss', url: gnews('zh-TW', 'TW', 'TW:zh-Hant'), dedicated: true },
  { id: 'soompi', name: 'Soompi', kind: 'rss', url: 'https://www.soompi.com/feed' },
  { id: 'yt-official', name: 'RIIZE YouTube', kind: 'youtube', handle: '@RIIZE_official', official: true, dedicated: true },
  { id: 'jp-official', name: 'RIIZE 日本官网', kind: 'page', url: 'https://riizeofficial.jp/news/', official: true, dedicated: true },
  { id: 'kpopofficial', name: 'kpopofficial 行程汇总', kind: 'page', url: 'https://kpopofficial.com/schedule/riize/', dedicated: true },
];

export const RULES = {
  MAX_ITEM_AGE_DAYS: 7,        // 只处理最近 7 天的文章
  EVENT_PAST_DAYS: 3,          // 行程日期最早允许到 3 天前
  EVENT_FUTURE_DAYS: 365,      // 最晚允许到 1 年后
  // 自动发布：置信度达到阈值，并且（来自官方信源 或 至少 2 个不同信源都提到）才直接进行程表
  // 其余进「待审核行程」表，在飞书里把审核状态改成「通过」即可上线
  AUTO_PUBLISH: process.env.AUTO_PUBLISH !== 'off',
  AUTO_PUBLISH_MIN_CONFIDENCE: 0.85,
  AUTO_PUBLISH_MIN_SOURCES: 2,
  NEWS_MIN_IMPORTANCE: 2,      // 1–5 分，低于此分不进新闻表（AIHOT 的「精选」）
  LLM_BATCH_SIZE: 5,           // 每次送给 AI 的条目数（免费模型单次输入有限，不要调太大）
  SEEN_TTL_DAYS: 30,
};
