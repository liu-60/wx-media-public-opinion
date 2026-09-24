# wx-media-public-opinion

WxRank 账号同步、文章账号采集、热词统计和文章粗筛的可复跑管线，并提供第一阶段采集编排平台。SQLite 只保存过程数据；项目最终数据可通过 Supabase REST sink 写入现有 Supabase schema。

## 已实现

- 账号同步：合并 rank/search 返回，严格以 `wx_biz` 作为唯一关联键；重复行只合并一次，不计为失败。
- 账号更新：身份字段与统计快照分开保存；缺失值不覆盖已有值，数值 `0` 保留；同步批次刷新 `account_profiles.collected_at`。
- 文章账号采集：文章出现新 `wx_biz` 时先建 `accounts` 和最小 `account_profiles`，同一账号后续文章不重复刷新采集时间。
- 热词统计：中文重叠 2/3/4-gram、英文归一化词、标题权重、文章数/账号数/阅读量和示例标题；过滤文章仍参与统计。
- 文章粗筛：规则 105 只在 `read_median` 明确存在且 `< 50000` 时命中；`null` 不会被转换为 `0`。身份词严格区分 `verify` 与 `wx_name`。
- 审计：文章保留在 `articles`，筛选原因写入 `article_filter_audit`；报告输出为可复核 JSON。
- Supabase 最终落库：按现有 `public.accounts`、`account_profiles`、`articles`、`hotwords` 和 `filter_rules` 约束写入；账号关联仍只用 `wx_biz`，数据库生成的 `account_id` 用于文章关联。采集编排运行历史使用独立五表，不创建 `jobs`/`job_steps`。
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

### 第一阶段采集编排

编排的最小执行单元是一个完整 Node.js ESM 脚本。管理中心页面“采集编排”提供脚本库、工作流、运行中心、最终业务产物和发布边界；正式工作流由 Worker 串行领取，脚本库验证会自动启动指定 Run 的 one-shot Worker。

```powershell
# 当前未提交的新脚本需要显式使用本地验收模式；生产/CI 保持 Git 注册校验
pnpm run collection:register -- --db data/collection-orchestration.sqlite --allow-untracked-local
pnpm run collection:run -- --db data/collection-orchestration.sqlite --allow-untracked-local --publish-mode preview
pnpm run collection:worker -- --db data/collection-orchestration.sqlite --artifact-root data/collection-runs --allow-untracked-local
# 默认只预览清理范围；确认后才使用 --apply
pnpm run collection:cleanup -- --db data/collection-orchestration.sqlite
# 仅审计/清洗五张采集编排表中与新执行模型直接冲突的数据
pnpm run collection:orchestration-cleanup -- --remote --dry-run --allow-untracked-local
pnpm run collection:orchestration-cleanup -- --remote --apply --allow-untracked-local
```

凭据只从受控环境注入子进程，不写入运行参数、数据库配置、日志或产物。TopHub 热词脚本可单独执行，默认读取 [`https://tophub.today/c/news`](https://tophub.today/c/news) 和 [`https://tophub.today/n/WnBe01o371`](https://tophub.today/n/WnBe01o371)，复用公众号文章热词聚合方法，仅保留至少出现在 2 个平台的词，默认按文章数降序输出前 5 个；`max_hotwords` 可调整。同平台文章不按 `source_id`、URL 或平台内身份去重；仅在跨平台标题字符重叠度达到 `title_overlap_threshold`（默认 0.8）时合并，并保留全部来源平台证据。热词聚合后会统一读取 `filter_rules` 中启用的 `scope=hotword, field_name=hotword` 规则，再生成最终热词 Artifact；文章、TopHub 榜单原始数据及聚合前统计不受热词过滤影响。规则支持 `exact` 与 `contains`，初始化规则为“中国”“书记”。最终 Artifact 是过滤后的热词及平台/文章统计列表。WxRank 策略采集和正式发布仍按工作流边界执行。`data/collection-runs/<run-id>/` 按运行隔离保存快照、JSON/JSONL、manifest、日志和 attempt 目录。

### 脚本库单独验证

脚本库中的“执行验证”走服务端 atomic RPC → 复用 `validation:<script_key>:v<version>` 单步骤 workflow → `collection_runs`（`run_kind=single_script`）→ 自动启动/领取 one-shot Worker → `collection_step_runs` → Node.js collector，不需要手工启动 Worker。单机已有 Run 时，验证 Run 会显示“等待执行槽位”，槽位释放后自动执行；启动失败会持久化为 `failed/WORKER_START_FAILED`，不会伪装成长期 queued。验证模式固定为 `preview`，不会直接写入现有业务六表；发布仍保持 Preview → Commit 边界。

脚本能力由注册信息中的 `run_mode` 与 `required_artifacts` 声明，页面不硬编码依赖：

| 脚本 | 执行方式 |
| --- | --- |
| `wxrank-base` | 可单独执行，发现并规范化账号 |
| `article-collect`、`redfox-gzh` | 可单独执行；文章采集均经共享账号/文章过滤器 |
| `accounts-update`、`hotwords-update`、`articles-filter` | 需要匹配 `artifact_type/schema_version` 的输入产物 |
| `tophub-hotwords` | 可单独执行，按文章数优先进行跨平台匹配并输出最多 5 个热词及统计数；`max_hotwords` 可调整 |
| `wxrank-strategy`、`publish-results` | 仅工作流执行；不会用假输入伪造成功 |

`article-collect` 默认请求 `https://wxrank.com/api/rank/viral?range=7d&page=1` 与 `https://wxrank.com/api/rank/article?range=7d&page=1`。脚本从文章结果归并并更新账号，再用运行规则快照（缺少快照时读取当前启用的 Supabase `filter_rules`）执行账号和文章过滤；输出 `accounts`、完整 `articles`、`filtered_articles` 与预览用 `write_set`。RedFox 也复用同一过滤模块。规则执行留在 `scripts/collectors/article-filter-common.mjs`，新增文章来源应调用它；源接口原始响应和过滤报告作为隐藏 debug Artifact 保留。

运行详情提供业务摘要、步骤/重试/请求信息，以及最终业务 Artifact；原始响应、异常、快照和日志保留在 manifest 中但默认隐藏，不作为 Workflow 输入。统一类型包括 `accounts`、`articles`、`hotwords`、`filtered_articles`、`write_set`、`publish_result`、`exceptions`；旧的 `normalized_accounts`、`normalized_articles`、`frozen_write_set` 和旧文件名通过兼容层读取。JSON/JSONL 通过分页预览。输入候选来自最近兼容运行产物，也可以放入固定的本地测试目录：

```text
data/collection-test-artifacts/<bundle-id>/manifest.json
data/collection-test-artifacts/<bundle-id>/<artifact-file>
```

本地测试 manifest 必须声明 `artifact_id`、`relative_path`、`artifact_type`、`schema_version`、`sha256` 和 `availability=available`。Worker 会再次读取 manifest 并校验文件 hash，不接受浏览器传入任意路径；测试产物目录不会自动生成 fixture。

脚本库验证的最小命令：

```powershell
# 1. 启动本机管理中心（只绑定回环地址）
pnpm management-center

# 可选：需要使用外部固定令牌时才设置；显式令牌优先于本机持久令牌
# $env:MANAGEMENT_TOKEN = '<local-token>'
# $env:MANAGEMENT_TOKEN_FILE = "$env:LOCALAPPDATA\wx-media-opinion\management-token"

# 未设置 MANAGEMENT_TOKEN 时，服务端会在
# %LOCALAPPDATA%\wx-media-opinion\management-token
# 生成一次随机令牌并长期复用，不写入仓库、不写日志、不写数据库。
# 浏览器首次访问 /api/session 后取得同源 HttpOnly Cookie；手工输入令牌也会持久化到浏览器 localStorage。

# 2. 通过页面“执行验证”创建单脚本 Run；服务端会自动启动指定 Run 的 Worker
#    仅在排查时才需要手工运行正式 Worker：
# pnpm collection:worker -- --remote --worker-id formal-worker --artifact-root data/collection-runs --allow-untracked-local
```

一次真实远端验收创建并成功完成 Run `8b5238a6-1761-4372-8d0c-a1b2b06b0b75`，复用 `workflow_id=2`，最终 Artifact 为 `accounts.json`（`type=accounts`，70 条，2 次请求）；raw/异常仅作为隐藏 debug Artifact。随后并发创建的两个验证 Run 仍复用同一个 validation workflow，并按单机槽位串行完成。

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

本地 SQLite 表包括旧管线过程表和 `collector_scripts`、`collection_workflows`、`collection_workflow_steps`、`collection_runs`、`collection_step_runs`，用于过程审计和失败重跑。Supabase 编排迁移文件为 `supabase/migrations/20260922094802_collection_orchestration_platform.sql` 与 `supabase/migrations/20260922104104_collection_orchestration_hardening.sql`，均按 Supabase CLI 生成并已应用到目标项目；本机 PostgreSQL lint 仍因 Docker/本地 Postgres 不可用而未完成。迁移启用 RLS、拒绝浏览器角色直接访问，并只向服务端 `service_role` 授权。旧 `sql/001-account-updated-at.sql` 与 `sql/002-article-discovered-account-profile.sql` 仍仅作为历史审核参考，运行时不会执行。
