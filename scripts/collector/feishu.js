// scripts/collector/feishu.js
// 飞书多维表格的最小客户端：鉴权、读表、按字段类型写入、自动建表
const API = 'https://open.feishu.cn/open-apis';

// 飞书字段类型编号
export const FT = { TEXT: 1, NUMBER: 2, SELECT: 3, MULTI: 4, DATE: 5, URL: 15 };

export class Feishu {
  constructor({ appId, appSecret, nodeToken, dryRun = false }) {
    Object.assign(this, { appId, appSecret, nodeToken, dryRun });
    this.fieldCache = new Map();
  }

  async call(path, { method = 'GET', body } = {}) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(`飞书 ${method} ${path} 失败: ${data.code} ${data.msg}`);
    return data.data;
  }

  async init() {
    const r = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const d = await r.json();
    if (d.code !== 0) throw new Error('飞书 token 失败: ' + d.msg);
    this.token = d.tenant_access_token;
    const node = await this.call(`/wiki/v2/spaces/get_node?token=${this.nodeToken}&obj_type=wiki`);
    this.appToken = node.node.obj_token;
  }

  async listTables() {
    const d = await this.call(`/bitable/v1/apps/${this.appToken}/tables?page_size=100`);
    return d.items || [];
  }

  // 找不到同名表就创建（用于「新闻」表）
  async ensureTable(name, fields) {
    const found = (await this.listTables()).find(t => t.name === name);
    if (found) return found.table_id;
    if (this.dryRun) { console.log(`[dry-run] 将创建数据表「${name}」`); return 'DRY_RUN_TABLE'; }
    const d = await this.call(`/bitable/v1/apps/${this.appToken}/tables`, {
      method: 'POST',
      body: { table: { name, default_view_name: '全部', fields } },
    });
    console.log(`已创建数据表「${name}」(${d.table_id})`);
    return d.table_id;
  }

  async fields(tableId) {
    if (this.fieldCache.has(tableId)) return this.fieldCache.get(tableId);
    if (tableId === 'DRY_RUN_TABLE') return new Map();
    const d = await this.call(`/bitable/v1/apps/${this.appToken}/tables/${tableId}/fields?page_size=100`);
    const map = new Map((d.items || []).map(f => [f.field_name, f.type]));
    this.fieldCache.set(tableId, map);
    return map;
  }

  async listRecords(tableId) {
    if (tableId === 'DRY_RUN_TABLE') return [];
    const out = [];
    let pageToken = '';
    do {
      const d = await this.call(
        `/bitable/v1/apps/${this.appToken}/tables/${tableId}/records?page_size=500` +
        (pageToken ? `&page_token=${pageToken}` : ''),
      );
      out.push(...(d.items || []));
      pageToken = d.has_more ? d.page_token : '';
    } while (pageToken);
    return out;
  }

  // 按表里真实的字段类型转换值；表里没有的列直接跳过，不会报错
  async buildFields(tableId, plain) {
    const types = await this.fields(tableId);
    const fields = {};
    for (const [name, value] of Object.entries(plain)) {
      if (value == null || value === '' || (Array.isArray(value) && !value.length)) continue;
      const type = types.get(name);
      if (type == null && types.size) continue;
      fields[name] = convert(value, type);
    }
    return fields;
  }

  async createRecords(tableId, plainRows) {
    if (!plainRows.length) return 0;
    const records = [];
    for (const row of plainRows) records.push({ fields: await this.buildFields(tableId, row) });
    if (this.dryRun) {
      console.log(`[dry-run] 将写入 ${tableId} 共 ${records.length} 条：`);
      records.forEach(r => console.log('   ', JSON.stringify(r.fields)));
      return records.length;
    }
    for (let i = 0; i < records.length; i += 100) {
      await this.call(`/bitable/v1/apps/${this.appToken}/tables/${tableId}/records/batch_create`, {
        method: 'POST',
        body: { records: records.slice(i, i + 100) },
      });
    }
    return records.length;
  }
}

function convert(value, type) {
  switch (type) {
    case FT.MULTI:  return Array.isArray(value) ? value : String(value).split(/[,，、]/).map(s => s.trim()).filter(Boolean);
    case FT.NUMBER: return Number(value);
    case FT.DATE:   return typeof value === 'number' ? value : dateToMs(value);
    case FT.URL:    return { link: String(value), text: String(value).slice(0, 80) };
    default:        return Array.isArray(value) ? value.join(',') : String(value);
  }
}

// 'YYYY-MM-DD' → 当天北京时间中午的时间戳（和 schedule.js 的 +8 小时解析对应）
export function dateToMs(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return Date.UTC(y, m - 1, d, 4, 0, 0);
}

// 读取单元格为纯文本
export function cellText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.some(x => typeof x === 'object') ? v.map(x => x.text || x.name || '').join('') : v.join(','); // 富文本片段直接拼接；多选值用逗号
  if (typeof v === 'object') return v.text || v.link || '';
  return String(v);
}

export function msToDate(ms) {
  const d = new Date(Number(ms) + 8 * 3600e3);
  return d.toISOString().slice(0, 10);
}
