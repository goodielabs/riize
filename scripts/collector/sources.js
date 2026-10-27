// scripts/collector/sources.js
// 采集：RSS / Atom、YouTube 频道、普通网页。每个信源失败都不影响其他信源。
import { createHash } from 'node:crypto';

const UA = 'Mozilla/5.0 (compatible; RIIZE-Bridge-Collector/1.0; +https://riize.netlify.app)';

async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko,ja;q=0.9,en;q=0.8,zh;q=0.7' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decode(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}

export function stripHtml(html = '') {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|header|footer|nav)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]).trim() : '';
};

export function parseFeed(xml) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map(b => {
    const atomLink = b.match(/<link[^>]*href="([^"]+)"/i);
    const desc = tag(b, 'description') || tag(b, 'media:description') || tag(b, 'summary') || tag(b, 'content');
    return {
      title: stripHtml(tag(b, 'title')),
      link: tag(b, 'link') || (atomLink ? decode(atomLink[1]) : ''),
      published: tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated'),
      text: stripHtml(desc).slice(0, 1500),
    };
  }).filter(x => x.title && x.link);
}

async function fetchRss(src) {
  return parseFeed(await get(src.url));
}

async function fetchYoutube(src) {
  const page = await get(`https://www.youtube.com/${src.handle}`);
  const m = page.match(/"(?:channelId|externalId)":"(UC[\w-]{22})"/) ||
            page.match(/channel_id=(UC[\w-]{22})/);
  if (!m) throw new Error('找不到 YouTube channelId');
  return parseFeed(await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${m[1]}`));
}

// 网页：整页文字作为一条，内容变化时才会重新处理（用内容哈希做 id）
async function fetchPage(src) {
  const text = stripHtml(await get(src.url)).slice(0, 9000);
  const hash = createHash('sha1').update(text).digest('hex').slice(0, 12);
  return [{ title: `${src.name} 页面`, link: src.url, published: new Date().toISOString(), text, idSuffix: hash }];
}

const FETCHERS = { rss: fetchRss, youtube: fetchYoutube, page: fetchPage };

export async function collect(sources) {
  const results = await Promise.allSettled(sources.map(s => FETCHERS[s.kind](s)));
  const items = [];
  results.forEach((r, i) => {
    const src = sources[i];
    if (r.status === 'rejected') {
      console.warn(`⚠️  信源 ${src.id} 失败: ${r.reason?.message || r.reason}`);
      return;
    }
    console.log(`✓ ${src.id}: ${r.value.length} 条`);
    for (const it of r.value) {
      items.push({
        ...it,
        id: it.idSuffix ? `${it.link}#${it.idSuffix}` : it.link,
        source: src,
      });
    }
  });
  return items;
}
