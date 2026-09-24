import { readArtifact, runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'
import { aggregateHotwordsWithDiagnostics } from '../../src/hotwords.mjs'
import { runArticleFilterStage } from './article-filter-common.mjs'
import { loadHotwordFilterRules } from './hotword-filter-rules.mjs'

const PUBLISH_DATE_FIELDS = Object.freeze(['publish_time', 'publishTime', 'published_at', 'pub_time', 'publish_date', 'created_at', 'date'])

function dateKeyFromParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return ''
  return `${String(year).padStart(4, '0')}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`
}

function articlePublishDate(row) {
  for (const field of PUBLISH_DATE_FIELDS) {
    const raw = String(row?.[field] ?? '').trim()
    if (!raw) continue
    if (/^\d{10,13}$/u.test(raw)) {
      const value = Number(raw)
      const date = new Date(raw.length === 10 ? value * 1000 : value)
      if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10).replaceAll('-', '')
      continue
    }
    const parts = /^(20\d{2})[-/.年]?(\d{1,2})[-/.月]?(\d{1,2})(?:日)?/u.exec(raw)
    if (parts) {
      const key = dateKeyFromParts(Number(parts[1]), Number(parts[2]), Number(parts[3]))
      if (key) return key
      continue
    }
    const date = new Date(raw)
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10).replaceAll('-', '')
  }
  return ''
}

function articlesByPublishDate(rows) {
  const groups = new Map()
  let withoutPublishDate = 0
  for (const row of rows) {
    const statDate = articlePublishDate(row)
    if (!statDate) {
      withoutPublishDate += 1
      continue
    }
    const group = groups.get(statDate) || []
    group.push(row)
    groups.set(statDate, group)
  }
  return { groups, withoutPublishDate }
}

function publicationDateLabel(statDate) {
  return `${statDate.slice(0, 4)}-${statDate.slice(4, 6)}-${statDate.slice(6, 8)}`
}

function hotwordWriteRows(rows) {
  return rows
    .filter(row => String(row.word || row.hotword || '').trim() && Number(row.article_count) >= 2)
    .map(row => ({
      hotword: String(row.word || row.hotword).trim(),
      aliases: Array.isArray(row.aliases) ? row.aliases : [],
      stat_date: publicationDateLabel(String(row.stat_date || '')),
      article_count: Math.trunc(Number(row.article_count)),
      article_keys: (row.article_keys || row.article_ids || []).map(item => String(item).trim()).filter(Boolean),
      article_url: String(row.article_url || row.examples?.[0] || '').trim() || null
    }))
}

function aggregateHotwordsByPublishDate(groups, { filterRules = [], now } = {}) {
  const rows = []
  const publishDateGroups = []
  const filterSummary = { loaded_rule_count: filterRules.length, filtered_count: 0, rule_hit_counts: {}, merged_count: 0, merge_group_count: 0 }
  for (const [statDate, articles] of [...groups.entries()].sort(([left], [right]) => right.localeCompare(left))) {
    const result = aggregateHotwordsWithDiagnostics(articles, {
      statDate,
      now,
      minArticleCount: 2,
      filterRules,
      mergeConsistencyThreshold: 0.8,
      mergeMinArticleCount: 3
    })
    rows.push(...result.rows)
    filterSummary.filtered_count += result.filtered_count
    filterSummary.merged_count += result.merged_count
    filterSummary.merge_group_count += result.merge_group_count
    for (const [ruleId, count] of Object.entries(result.rule_hit_counts)) {
      filterSummary.rule_hit_counts[ruleId] = (filterSummary.rule_hit_counts[ruleId] || 0) + count
    }
    publishDateGroups.push({
      publish_date: publicationDateLabel(statDate),
      article_count: articles.length,
      hotword_count: result.rows.length,
      hotwords: result.rows.map(row => ({ word: row.word, article_count: row.article_count, score: row.score }))
    })
  }
  return { rows, publishDateGroups, filterSummary }
}

async function readJson(input, index) {
  const reference = input.input_artifacts[index]
  if (!reference) { const error = new Error(`article input artifact ${index} is missing`); error.code = 'INPUT_MISSING'; throw error }
  return readArtifact(input.workdir, reference)
}

async function collect(input, dependencies = {}) {
  const started = Date.now()
  const accountValue = await readJson(input, 0)
  const articleValue = await readJson(input, 1)
  const accountRows = accountValue.rows || accountValue.accounts || accountValue
  const articleRows = articleValue.rows || articleValue.articles || articleValue
  if (!Array.isArray(accountRows) || !Array.isArray(articleRows)) { const error = new Error('filter input artifacts are invalid'); error.code = 'INVALID_DATA'; throw error }
  const strategy = input.strategy_snapshot_ref ? await readArtifact(input.workdir, input.strategy_snapshot_ref) : {}
  const accountsByBiz = new Map(accountRows.filter(row => row?.wx_biz).map(row => [row.wx_biz, row]))
  for (const row of strategy.approved_accounts || []) if (row?.wx_biz && !accountsByBiz.has(row.wx_biz)) accountsByBiz.set(row.wx_biz, row)
  const accountDecisions = Object.fromEntries((strategy.account_decisions || strategy.approved_accounts || []).filter(row => row?.wx_biz).map(row => [row.wx_biz, { decision_status: row.decision_status ?? 1 }]))
  const effectiveAccounts = [...accountsByBiz.values()].map(row => ({ ...row, decision_status: accountDecisions[row.wx_biz]?.decision_status ?? row.decision_status ?? 0, decision_required: true }))
  const stage = await runArticleFilterStage({ input, accountRows: effectiveAccounts, articleRows, source: 'collector', databaseName: 'articles-filter.sqlite', accountDecisions })
  const generatedAt = new Date().toISOString()
  const datedArticles = articlesByPublishDate(stage.filteredArticles)
  let loadedHotwordRules = { rules: [], request_count: 0 }
  if ([...datedArticles.groups.values()].some(rows => rows.length >= 2)) {
    try {
      loadedHotwordRules = await (dependencies.loadHotwordFilterRules || (() => loadHotwordFilterRules({
        client: dependencies.supabaseClient,
        env: dependencies.env,
        fetchImpl: dependencies.supabaseFetchImpl
      })))()
    } catch (error) {
      error.request_count = stage.filter_rule_request_count + (Number(error.request_count) || 0)
      throw error
    }
  }
  const hotwordStage = aggregateHotwordsByPublishDate(datedArticles.groups, { filterRules: loadedHotwordRules.rules, now: generatedAt })
  const hotwordWriteSet = hotwordWriteRows(hotwordStage.rows)
  stage.writeSet.hotwords = hotwordWriteSet

  const reportArtifact = await writeArtifact(input.workdir, 'articles-filter-report.json', stage.report)
  reportArtifact.artifact_type = 'debug_report'; reportArtifact.schema_version = '1'; reportArtifact.record_count = articleRows.length
  reportArtifact.kind = 'debug'; reportArtifact.default_visible = false
  const filteredArtifact = await writeArtifact(input.workdir, 'filtered-articles.json', { run_date: stage.report.runDate, rows: stage.filteredArticles, generated_at: generatedAt })
  filteredArtifact.artifact_type = 'filtered_articles'; filteredArtifact.schema_version = '1'; filteredArtifact.record_count = stage.filteredArticles.length
  const hotwordsArtifact = await writeArtifact(input.workdir, 'articles-filter-hotwords.json', {
    rows: hotwordStage.rows,
    publish_date_groups: hotwordStage.publishDateGroups,
    without_publish_date: datedArticles.withoutPublishDate,
    filter_summary: hotwordStage.filterSummary,
    generated_at: generatedAt
  })
  hotwordsArtifact.artifact_type = 'hotwords'; hotwordsArtifact.schema_version = '1'; hotwordsArtifact.record_count = hotwordStage.rows.length
  const writeSetArtifact = await writeArtifact(input.workdir, 'write-set.json', stage.writeSet)
  writeSetArtifact.artifact_type = 'write_set'; writeSetArtifact.schema_version = '1'; writeSetArtifact.record_count = (stage.writeSet.articles?.length || 0) + (stage.writeSet.accounts?.length || 0) + (stage.writeSet.hotwords?.length || 0)
  const selected = stage.filteredArticles.length
  const filtered = articleRows.length - selected
  return { status: 'success', input_count: articleRows.length, output_count: selected, created_count: stage.report.accounts.created, updated_count: stage.report.accounts.updated, filtered_count: filtered, request_count: stage.filter_rule_request_count + loadedHotwordRules.request_count, duration_ms: Date.now() - started, artifact: [filteredArtifact, hotwordsArtifact, writeSetArtifact], debug_artifacts: [reportArtifact], business_summary: { input_articles: articleRows.length, selected, filtered, updated_accounts: stage.accounts.length, write_set_records: writeSetArtifact.record_count, hotwords: hotwordStage.rows.length, publish_date_groups: hotwordStage.publishDateGroups.length, articles_without_publish_date: datedArticles.withoutPublishDate, hotword_filter_rules: loadedHotwordRules.rules.length, filter_rules: stage.report.filterRules }, message: 'article filter and publish-date hotword extraction completed' }
}

if (import.meta.main) runCollectorMain(collect)

export { collect }
