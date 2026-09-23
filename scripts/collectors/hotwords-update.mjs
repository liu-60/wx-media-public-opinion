import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { aggregateHotwordsWithDiagnostics } from '../../src/hotwords.mjs'
import { runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'
import { loadHotwordFilterRules } from './hotword-filter-rules.mjs'

function dateKey(value) {
  const raw = String(value || '').replaceAll('-', '').slice(0, 8)
  return /^20\d{6}$/u.test(raw) ? raw : new Date().toISOString().slice(0, 10).replaceAll('-', '')
}

function publishedDate(row) {
  const parsed = new Date(row.published_at || row.publish_time || row.pub_time || '')
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10).replaceAll('-', '')
}

function minusOne(value) {
  const date = new Date(`${String(value).slice(0, 4)}-${String(value).slice(4, 6)}-${String(value).slice(6, 8)}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

function ratio(value, fallback, name) {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    const error = new Error(`${name}必须是0到1之间的小数`)
    error.code = 'INVALID_CONFIG'
    throw error
  }
  return parsed
}

function positiveInteger(value, fallback, name, maximum = 100) {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    const error = new Error(`${name}必须是1到${maximum}之间的整数`)
    error.code = 'INVALID_CONFIG'
    throw error
  }
  return parsed
}

async function collect(input, dependencies = {}) {
  const started = Date.now()
  let ruleRequestCount = 0
  const reference = input.input_artifacts[0]
  if (!reference) { const error = new Error('article input artifact is missing'); error.code = 'INPUT_MISSING'; throw error }
  const value = JSON.parse(await readFile(path.resolve(input.workdir, reference.artifact_id), 'utf8'))
  const rows = Array.isArray(value) ? value : value.rows || value.articles || []
  const statDate = input.config.stat_date || new Date().toISOString().slice(0, 10)
  const minArticleCount = Math.max(1, Number(input.config.min_article_count ?? 2))
  const mergeConsistencyThreshold = ratio(input.config.merge_consistency_threshold, 0.8, 'merge_consistency_threshold')
  const mergeMinArticleCount = positiveInteger(input.config.merge_min_article_count, 3, 'merge_min_article_count')
  let loadedRules
  try {
    loadedRules = await (dependencies.loadHotwordFilterRules || (() => loadHotwordFilterRules({
      client: dependencies.supabaseClient,
      env: dependencies.env,
      fetchImpl: dependencies.supabaseFetchImpl
    })))()
    ruleRequestCount = loadedRules.request_count
  } catch (error) {
    error.request_count = Math.max(Number(error.request_count) || 0, ruleRequestCount)
    throw error
  }
  const aggregation = aggregateHotwordsWithDiagnostics(rows, {
    statDate,
    now: new Date().toISOString(),
    minArticleCount,
    filterRules: loadedRules.rules,
    canonicalRules: input.config.canonical_hotwords,
    mergeConsistencyThreshold,
    mergeMinArticleCount
  })
  const hotwords = aggregation.rows
  const strategy = input.strategy_snapshot_ref ? await (await import('../../src/runner/script-runtime.mjs')).readArtifact(input.workdir, input.strategy_snapshot_ref) : {}
  const existing = new Set((strategy.existing_hotwords || []).map(row => String(row.word || row.hotword || '').trim()).filter(Boolean))
  const today = dateKey(statDate)
  const yesterday = minusOne(today)
  const newHotwordsToday = hotwords.filter(row => !existing.has(row.word) && row.article_ids?.some(id => rows.find(article => (article.article_id || article.article_url || article.title) === id && publishedDate(article) === today)))
  const newHotwordsYesterday = hotwords.filter(row => !existing.has(row.word) && row.article_ids?.some(id => rows.find(article => (article.article_id || article.article_url || article.title) === id && publishedDate(article) === yesterday)))
  const outputName = input.config.output_name || (input.config.stage === 'final' ? 'hotwords-final.json' : 'hotword-snapshot-v1.json')
  const filterSummary = {
    loaded_rule_count: loadedRules.rules.length,
    filtered_count: aggregation.filtered_count,
    rule_hit_counts: aggregation.rule_hit_counts,
    merged_count: aggregation.merged_count,
    merge_group_count: aggregation.merge_group_count,
    merge_consistency_threshold: aggregation.merge_consistency_threshold,
    merge_min_article_count: aggregation.merge_min_article_count,
    canonical_rule_count: aggregation.canonical_rule_count,
    canonical_candidate_count: aggregation.canonical_candidate_count,
    canonical_merge_count: aggregation.canonical_merge_count,
    canonical_group_count: aggregation.canonical_group_count,
    canonical_rule_hit_counts: aggregation.canonical_rule_hit_counts
  }
  const artifact = await writeArtifact(input.workdir, outputName, { stat_date: statDate, rows: hotwords, new_hotwords_today: newHotwordsToday, new_hotwords_yesterday: newHotwordsYesterday, filter_summary: filterSummary, generated_at: new Date().toISOString() })
  artifact.artifact_type = 'hotwords'; artifact.schema_version = '1'; artifact.record_count = hotwords.length
  const newArtifact = await writeArtifact(input.workdir, input.config.new_hotwords_name || 'new-hotwords.json', { stat_date: statDate, new_hotwords_today: newHotwordsToday, new_hotwords_yesterday: newHotwordsYesterday })
  newArtifact.artifact_type = 'debug_report'; newArtifact.schema_version = '1'; newArtifact.record_count = newHotwordsToday.length + newHotwordsYesterday.length
  return { status: 'success', input_count: rows.length, output_count: hotwords.length, created_count: null, updated_count: null, filtered_count: aggregation.filtered_count, request_count: ruleRequestCount, duration_ms: Date.now() - started, artifact, debug_artifacts: [{ ...newArtifact, kind: 'debug', default_visible: false }], message: 'hotwords stage completed', business_summary: { total: hotwords.length, new_today: newHotwordsToday.length, new_yesterday: newHotwordsYesterday.length, filter_rules: filterSummary, merged_count: aggregation.merged_count } }
}

if (import.meta.main) runCollectorMain(collect)

export { collect }
