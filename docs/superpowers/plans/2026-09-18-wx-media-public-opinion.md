# Wx Media Public Opinion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在当前空仓库中建立可复跑的 WxRank 账号同步、文章账号采集、热词统计和文章粗筛闭环。

**Architecture:** 以 Node.js ESM + 内置 SQLite 保存过程数据和筛选审计。账号同步先按 `wx_biz` 合并两类 WxRank 返回，再把身份字段和统计快照分开更新；文章进入时只在新发现账号上写入 `account_profiles.collected_at`，账号过滤结果写入本地文章状态，但不删除 Raw 文章或阻断热词统计。最终数据通过 `src/supabase-sink.mjs` 写入当前已有 Supabase 表结构；不迁移旧库、不应用迁移。

**Tech Stack:** Node.js 24 ESM、pnpm、`node:sqlite`、`node:test`、原生 `fetch`、Supabase/Postgres SQL。

## Global Constraints

- `wx_biz` 是账号唯一关联键；同名账号不得合并。
- 重复的 rank/search 账号记录只合并一次，不计为失败。
- 空值和缺失值不得覆盖已有非空值；数值 `0` 是有效值。
- `last_pub_time` 统一转换为 ISO 时间；账号 `updated_at` 优先使用详情采集时间，否则使用本次时间。
- 账号同步时本批账号统一刷新 `account_profiles.collected_at`；文章采集发现新账号时才刷新该新账号的 `collected_at`。
- `read_median` 只有明确有值且 `< 50000` 才命中规则 105；`NULL` 必须跳过规则 105。
- 账号过滤先于文章进入候选，但所有 Raw 文章仍参与热词统计并保留过滤审计。
- 认证主体词只检查 `verify`；名称词只检查 `wx_name`；不把简介或正文关键词泄漏到身份规则。
- 默认运行只写本地 SQLite 和可审核 JSON；显式传入 `--supabase` 且提供服务端密钥时，才写当前运行的最终项目数据，不读取或搬运旧 SQLite 数据。

---

### Task 1: Project skeleton and database contract

**Files:**
- Create: `package.json`
- Create: `config/default.json`
- Create: `src/db.mjs`
- Create: `test/db.test.mjs`
- Create: `README.md`

**Interfaces:**
- `openDatabase(filePath)` returns an initialized `DatabaseSync` instance.
- `ensureSchema(db)` creates `sync_runs`, `accounts`, `account_profiles`, `articles`, `article_filter_audit`, and `hotwords`.

- [ ] Write a failing schema test that asserts all six tables and the `accounts.wx_biz` unique index exist.
- [ ] Run `node --test test/db.test.mjs` and observe failure because the module does not exist.
- [ ] Implement the schema, including nullable source metrics, `collected_at`, `last_pub_time`, raw JSON, and article status fields.
- [ ] Run the focused test and then `node --test test/db.test.mjs` to confirm it passes.

### Task 2: Account update and article-discovery account creation

**Files:**
- Create: `src/account-sync.mjs`
- Create: `src/account-collection.mjs`
- Create: `test/account-sync.test.mjs`
- Create: `test/account-collection.test.mjs`
- Keep for historical review only: `sql/001-account-updated-at.sql`

**Interfaces:**
- `normalizeAccountRow(row, { source, collectedAt })` returns one canonical account/profile row.
- `mergeAccountRows(rows)` returns `{ rows, rawCount, uniqueCount, duplicateCount, invalidCount }` keyed only by exact `wx_biz`.
- `syncAccounts(db, rows, options)` returns an auditable summary and per-field changes.
- `ensureArticleAccount(db, article, options)` returns `{ accountId, created, collectedAtUpdated }`.
- `buildAccountUpsertPayload(row)` returns `{ account, profile }` with null-preserving fields.

- [ ] Add failing tests for duplicate rank/search rows, blank-vs-nonblank merge, numeric zero preservation, timestamp conversion, and the duplicate count not being failure count.
- [ ] Add failing tests proving existing account profile values survive incoming `null`, existing accounts refresh sync `collected_at`, and article discovery only refreshes `collected_at` for a newly created account.
- [ ] Run both focused test files and observe the expected failures.
- [ ] Implement deterministic `acct_<sha256(wx_biz)>` identities, account/profile field separation, change logging, `last_pub_time` conversion, `updated_at` fallback policy, and article-created minimal accounts.
- [ ] Do not execute a Postgres migration; map the already-present `public.accounts.updated_at` field in the final sink.
- [ ] Run both focused test files and confirm all account rules pass.

### Task 3: Hotword extraction and database-ready aggregation

**Files:**
- Create: `src/hotwords.mjs`
- Create: `test/hotwords.test.mjs`

**Interfaces:**
- `tokenizeHotwords(text, options)` returns overlapping 2/3/4-character Chinese n-grams and normalized English words.
- `aggregateHotwords(articles, options)` returns rows with `word`, `token_type`, `gram`, `stat_date`, `article_count`, `account_count`, `read_sum`, `weighted_count`, `score`, and `examples`.
- `persistHotwords(db, rows)` upserts the returned rows without deleting prior dates.

- [ ] Add failing tests for overlapping Chinese n-grams, English normalization, punctuation boundaries, per-article deduplication, distinct account counts, and title weighting.
- [ ] Run `node --test test/hotwords.test.mjs` and observe the expected failures.
- [ ] Implement tokenization, stopword filtering, per-article aggregation, transparent scoring, and idempotent persistence.
- [ ] Run the focused tests and verify the output shape is directly insertable into the `hotwords` table.

### Task 4: Account rules and article coarse screening

**Files:**
- Create: `src/article-filter.mjs`
- Create: `test/article-filter.test.mjs`

**Interfaces:**
- `evaluateAccountRules(account, config)` returns `{ filtered, ruleId, reasons }`.
- `coarseFilterArticle(article, account, config)` returns `{ status, filterRuleId, reason, accountMatched }`.
- `DEFAULT_FILTER_CONFIG` contains rule 105 for non-null `read_median < 50000`, rule 82 for configured academic/institution name terms, and field-scoped identity rules.

- [ ] Add failing tests that `read_median: null` does not trigger 105, `read_median: 49999` does, and a name rule can filter even when median is null.
- [ ] Add failing tests that missing accounts remain `ACCOUNT_UNMATCHED`/manual-review rather than being treated as personal or as median zero.
- [ ] Add failing tests proving verify terms do not inspect article body/description and that a filtered account prevents article selection while preserving the article record.
- [ ] Run the focused tests and observe the expected failures.
- [ ] Implement ordered, auditable rules and stable statuses: `SELECTED`, `ACCOUNT_FILTERED`, `ACCOUNT_UNMATCHED`, and `REVIEW`.
- [ ] Run the focused tests and confirm the seven-row-style review behavior is representable without hard-coding sample accounts.

### Task 5: WxRank collection adapter and end-to-end pipeline

**Files:**
- Create: `src/wxrank-client.mjs`
- Create: `src/pipeline.mjs`
- Create: `scripts/run-pipeline.mjs`
- Create: `test/pipeline.test.mjs`
- Create: `src/supabase-sink.mjs`
- Create: `scripts/run-wxrank-snapshot.mjs`
- Create: `test/supabase-sink.test.mjs`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- `fetchAccountSources({ fetchImpl, baseUrl, headers })` reads `/api/rank/account?range=30d&page=1` and `/api/search/account` with `{ range: '30d' }`, requiring HTTP 200 and `code=0`.
- `runPipeline({ db, accountRows, articleRows, runDate, now })` performs account sync, article account creation, hotword aggregation, coarse filtering, and returns a reviewable report.
- CLI command: `pnpm run pipeline -- --input <json> --db <sqlite> --output <json>`.

- [ ] Add a failing end-to-end fixture test that contains duplicate accounts, a null-median account, a filtered account, and two articles sharing one hotword.
- [ ] Run the fixture test and observe the expected failure.
- [ ] Implement HTTP response validation without logging cookies, keys, or full sensitive payloads; keep collection adapter separate from local pipeline.
- [ ] Implement idempotent run handling, raw article persistence, account-first screening, all-article hotword aggregation, and JSON report writing.
- [ ] Implement the existing-schema Supabase sink: account/profile upsert, server-resolved `account_id`, selected article upsert, repeated-hotword upsert, and `jobs/job_steps` audit without migrations.
- [ ] Run the end-to-end test and CLI against the fixture, then inspect SQLite counts and the JSON report.

### Task 6: Full verification and handoff

**Files:**
- Modify: `README.md` if command/output documentation needs correction.

- [ ] Run `pnpm test`.
- [ ] Run the focused account, hotword, filter, and pipeline tests again as a fresh regression.
- [ ] Run the CLI fixture end to end and verify duplicate accounts are not failures, null median is not rule 105, filtered articles remain in Raw, and hotwords include filtered-article traffic.
- [ ] Review `git diff --check` and `git status --short`.
- [ ] Write the current task's final payload to Supabase without migrating old data, then verify the inserted/upserted rows with read-only queries.
- [ ] Report exact files, commands, remote project, row counts, and migration status.
