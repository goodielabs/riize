// scripts/collector/dedupe.js
// 聚簇：多个信源报道的同一件事合并为一个「事件」（AIHOT 的核心思路）

export function normalize(s = '') {
  return s.normalize('NFKC').toLowerCase()
    .replace(/riize|라이즈|ライズ/g, '')
    .replace(/20\d\d/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(s) {
  const n = normalize(s);
  if (n.length < 2) return new Set([n]);
  const set = new Set();
  for (let i = 0; i < n.length - 1; i++) set.add(n.slice(i, i + 2));
  return set;
}

export function similarity(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (Math.min(na.length, nb.length) >= 4 && (na.includes(nb) || nb.includes(na))) return 0.9;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export const SAME_EVENT = 0.5;

// 同一天 + 名字相似 → 合并；保留置信度最高的写法，记录所有来源
export function clusterEvents(events) {
  const clusters = [];
  for (const ev of events.sort((a, b) => b.confidence - a.confidence)) {
    const hit = clusters.find(c => c.date === ev.date && similarity(c.name, ev.name) >= SAME_EVENT);
    if (hit) {
      hit.sources.push(...ev.sources.filter(s => !hit.sources.some(h => h.id === s.id)));
      hit.confidence = Math.max(hit.confidence, ev.confidence);
      hit.time ||= ev.time;
      hit.location ||= ev.location;
    } else {
      clusters.push({ ...ev, sources: [...ev.sources] });
    }
  }
  return clusters;
}

export function clusterNews(news) {
  const clusters = [];
  for (const n of news.sort((a, b) => b.importance - a.importance)) {
    const hit = clusters.find(c => similarity(c.title, n.title) >= 0.45);
    if (hit) {
      if (!hit.sourceNames.includes(n.sourceNames[0])) hit.sourceNames.push(n.sourceNames[0]);
      hit.importance = Math.max(hit.importance, n.importance);
    } else {
      clusters.push({ ...n, sourceNames: [...n.sourceNames] });
    }
  }
  // 3 家以上媒体报道同一件事 → 重要度 +1（最多 5）
  for (const c of clusters) if (c.sourceNames.length >= 3) c.importance = Math.min(5, c.importance + 1);
  return clusters;
}
