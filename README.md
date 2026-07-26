# 💳 BIN 查询

单 Worker 的 BIN(卡号前缀)查询站:输入卡号前 6-8 位,返回卡组织、预付/借贷类型、卡等级、发卡行、国家(带国旗)及数据来源。部署在 Cloudflare Workers。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lzyjianlai/bin-lookup)

## 架构

- `GET /` — 内联 HTML 单页(居中卡片、紫蓝渐变、深色模式)。输入框只保留前 8 位数字,完整卡号绝不进入页面或发出。
- `GET /api/lookup?bin=<6-8位>` — JSON API,三级回退:
  1. **HandyAPI 商业库** — `data.handyapi.com/bin/<bin>`,带 `x-api-key`;遇 429/402/403 或出错回退
  2. **binlist.net** — `lookup.binlist.net/<bin>`,带 `Accept-Version: 3`;出错回退
  3. **离线库** — [binlist-data](https://github.com/venelinkochev/bin-list-data) 约 37 万条,存 Neon Postgres,经 `@neondatabase/serverless` HTTP 驱动查询,按 8→7→6 位前缀匹配
- 已查过的 BIN 用 `caches.default` 做边缘缓存(s-maxage=86400)。
- `normalize()` 统一三源结构;预付判定:显式布尔优先,否则扫 type/category/brand 中的 "prepaid" 字样。

## 部署后必须补的两个 Secret

一键部署(或 `wrangler deploy`)之后,**必须**设置以下两个 Secret,否则只有 binlist.net 一级可用:

```bash
npx wrangler secret put HANDY_API_KEY   # HandyAPI 的 x-api-key
npx wrangler secret put DATABASE_URL    # Neon Postgres 连接串(postgres://...?sslmode=require)
```

密钥只存于 Cloudflare Secrets,绝不写进代码或提交仓库。本地开发复制 `.dev.vars.example` 为 `.dev.vars` 填入真实值(已被 .gitignore 忽略)。

## 数据导入(第三级离线库)

```bash
npm install
DATABASE_URL='postgres://...' npm run import
```

脚本会下载开源 CSV、按 BIN 去重后批量 UPSERT 进 Neon 的 `bins(bin, brand, type, category, bank, country_name, country_code)` 表。Neon 免费档即可,无每日写入限制。

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # 填入真实密钥
npm run dev
```

## 自定义域

域名托管在 Cloudflare 后,在 `wrangler.toml` 取消注释:

```toml
routes = [
  { pattern = "bin.example.com", custom_domain = true }
]
```

再 `wrangler deploy` 即可。
