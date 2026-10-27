# RIIZE 自动采集器

参考 [AIHOT](https://github.com/KKKKhazix/AIHOT) 的思路：**多源采集 → 预筛 → LLM 提取与打分 → 聚簇合并 → 去重 → 入库**。
不需要服务器，GitHub Actions 每 3 小时跑一次，结果写进你现有的飞书多维表格，网站自动读取。

**完全免费**：AI 用的是 GitHub Models 的免费额度（GitHub Actions 自带令牌，无需注册或绑卡）；
公开仓库的 GitHub Actions、飞书多维表格、Netlify 免费版也都不收费。

```
Google News(韩/英/日/繁中) ─┐
Soompi RSS                 ─┤
RIIZE 官方 YouTube          ─┼→ 预筛(关键词/7天内/已处理过的跳过) → LLM 提取行程+写中文摘要
RIIZE 日本官网 新闻页        ─┤      → 聚簇(多家报道同一件事合并) → 与飞书已有行程去重
kpopofficial 行程页          ─┘      → 高置信度+官方/多源 → 「行程」表（直接上线）
                                     → 其余               → 「待审核行程」表（审核状态改成「通过」即上线）
                                     → 新闻               → 「新闻」表（自动创建）→ 网站「📰 新闻」页
```

## 一次性设置

1. **GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret**，添加：
   - `FEISHU_APP_ID`、`FEISHU_APP_SECRET`：和 Netlify 环境变量里的一样
   - AI 不需要设置任何密钥
2. 飞书开放平台里，确认这个应用有多维表格的**编辑**权限（新建数据表需要）。网站投稿功能能用，通常就已经有了。
3. 打开仓库的 **Actions → RIIZE Collector → Run workflow**，保持「试运行」勾选，先看日志里会写入什么。
4. 结果满意后再手动跑一次（取消勾选试运行），之后就每 3 小时自动运行。

## 日常使用

- 不用再手动录入行程。偶尔打开飞书「待审核行程」表，把靠谱的那条的「审核状态」改为 **通过** 即可上线；不靠谱的删掉或改成「拒绝」。
- 自动收录的行程备注里带 🤖 和来源，出错时直接在飞书里改或删。
- 某条新闻不想展示：在「新闻」表加一列 **隐藏**（复选框），勾上即可。
- 想全部人工把关：在 Settings → Variables 添加 `AUTO_PUBLISH` = `off`。

## 免费额度说明

默认模型是 GitHub Models 上的 `openai/gpt-4o-mini`，每天有固定的免费调用次数。每次运行只处理新文章，
正常情况下远远用不完。万一某天用完了，日志会显示「⏸ 今日免费额度已用完」，剩下的文章会在下次运行时自动补上，不会丢失。

## 换成其他模型（可选）

在 Settings → Variables 添加 `LLM_PROVIDER=openai`、`LLM_BASE_URL`、`LLM_MODEL`，在 Secrets 添加 `LLM_API_KEY`，
即可换成任何 OpenAI 兼容接口（如 DeepSeek）。想用 Claude：`LLM_PROVIDER=anthropic` + Secret `ANTHROPIC_API_KEY`。

## 加信源

编辑 `config.js` 里的 `SOURCES`。支持 `rss`（任意 RSS/Atom）、`page`（任意网页，整页交给 LLM 提取行程）、`youtube`（填频道 handle）。
标记 `official: true` 的信源提取到的行程，置信度够就会直接上线。

## 目前抓不到的

Weverse 公告和 X（推特）需要登录或付费 API，没有接入。这两个渠道的行程，大多会在几小时内被媒体报道、再被采集到；
特别着急的，继续用网站上的「投稿行程」或直接写飞书即可。
