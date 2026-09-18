# wx-media-public-opinion

WxRank 账号同步、文章账号采集、热词统计和文章粗筛的可复跑管线。SQLite 只保存过程数据；项目最终数据可通过 Supabase REST sink 写入现有 Supabase schema。

## 已实现

- 账号同步：合并 rank/search 返回，严格以 `wx_biz` 作为唯一关联键；重复行只合并一次，不计为失败。
- 账号更新：身份字段与统计快照分开保存；缺失值不覆盖已有值，数值 `0` 保留；同步批次刷新 `account_profiles.collected_at`。
- 文章账号采集：文章出现新 `wx_biz` 时先建 `accounts` 和最小 `account_profiles`，同一账号后续文章不重复刷新采集时间。
- 热词统计：中文重叠 2/3/4-gram、英文归一化词、标题权重、文章数/账号数/阅读量和示例标题；过滤文章仍参与统计。
- 文章粗筛：规则 105 只在 `read_median` 明确存在且 `< 50000` 时命中；`null` 不会被转换为 `0`。身份词严格区分 `verify` 与 `wx_name`。
- 审计：文章保留在 `articles`，筛选原因写入 `article_filter_audit`；报告输出为可复核 JSON。
- Supabase 最终落库：按现有 `public.accounts`、`account_profiles`、`articles`、`hotwords`、`jobs`、`job_steps` 写入；账号关联仍只用 `wx_biz`，数据库生成的 `account_id` 用于文章关联。
- 不迁移旧库：不会执行 `sql/` 下的迁移，也不会把本地旧 SQLite 批量搬到 Supabase；每次只写当前输入经过筛选后的项目数据。

## 运行

要求 Node.js 22+ 和 pnpm：

```bash
pnpm install
pnpm test
pnpm run pipeline -- --input fixtures/pipeline-input.json --db data/wx-media.sqlite --output data/pipeline-report.json
# 读取 WxRank 快照文件（可选 --supabase 写入最终数据）
pnpm run snapshot -- --accounts-file <accounts.json> --articles-file <articles.json> --db data/wxrank.sqlite --output data/wxrank-report.json
```

输入 JSON 使用以下结构：

```json
{
  "runDate": "2026-09-18",
  "accountRows": [],
  "articleRows": []
}
```

`accountRows` 可直接放入 WxRank 两个接口的原始账号行；`articleRows` 支持 `article_id`、`url`、`title`、`content`、`__biz`/`wx_biz`、`read_num` 等字段。CLI 默认只访问本地输入，不会自动调用远程服务。

要把本次运行的最终数据写入 Supabase，使用服务端密钥（新建的 secret key 或兼容的 service-role key，只放在服务端环境，不提交到仓库）：

```powershell
$env:SUPABASE_URL = 'https://<project-ref>.supabase.co'
$env:SUPABASE_SECRET_KEY = '<server-only-key>'
pnpm run snapshot -- --accounts-file <accounts.json> --articles-file <articles.json> --supabase
```

远程写入顺序为账号 upsert → 数据库 `account_id` 关联 → profile/article/hotword upsert → job 审计。只写 `SELECTED` 文章；被账号规则过滤或账号未匹配的文章留在本地过程审计中，但仍参与本次热词统计。`hotwords` 遵守现有表的 `article_count >= 2` 约束。

## WxRank 适配器

`src/wxrank-client.mjs` 提供 `fetchAccountSources()`，读取：

- `GET /api/rank/account?range=30d&page=1`
- `POST /api/search/account`，请求体 `{ "range": "30d" }`

适配器要求 HTTP 200 且响应 `code=0`，认证头由调用方显式传入；它不会输出 Cookie、密钥或完整响应体。

## 数据与迁移

本地 SQLite 表包括 `accounts`、`account_profiles`、`articles`、`article_filter_audit`、`hotwords` 和 `sync_runs`，用于过程审计和失败重跑。Supabase sink 只使用当前已有表结构，不创建表、不授权、不应用迁移；`sql/001-account-updated-at.sql` 与 `sql/002-article-discovered-account-profile.sql` 仅作为历史审核参考，运行时不会执行。
