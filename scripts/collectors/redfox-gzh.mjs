import { fetchRedfoxSources } from '../../src/collector-adapters/redfox.mjs'
import { runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'
import { accountRowsFromArticles, runArticleFilterStage } from './article-filter-common.mjs'

async function collect(input) {
  const started = Date.now()
  const startDate = input.config.start_date
  const endDate = input.config.end_date
  const targetDate = input.config.target_date || endDate || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date())
  const requestedRange = { start_date: startDate || targetDate, end_date: endDate || targetDate }
  const sourceNos = Array.isArray(input.config.source_nos) && input.config.source_nos.length ? input.config.source_nos : ['OFFSPQ0U', 'ZIGAGYYT']
  const result = await fetchRedfoxSources({ targetDate, startDate, endDate, lookbackDays: Number(input.config.lookback_days ?? 2), sourceNos })
  if (result.status === 'waiting_auth') return { status: 'waiting_auth', input_count: null, output_count: null, created_count: null, updated_count: null, filtered_count: null, request_count: 0, duration_ms: Date.now() - started, artifact: null, error_code: result.error_code, message: result.message }
  const generatedAt = new Date().toISOString()
  const raw = await writeArtifact(input.workdir, 'redfox-gzh-raw.json', { source: 'redfox', target_date: targetDate, requested_range: requestedRange, sources: result.raw_sources || result.sources, generated_at: generatedAt })
  raw.artifact_type = 'raw_response'; raw.schema_version = '1'; raw.record_count = result.raw_sources?.length ?? result.sources.length
  const redfoxRows = result.rows.map(row => ({ ...row, source_platform: 'redfox', collect_reasons: [row.source_no === 'OFFSPQ0U' ? 'original_rank' : row.source_no === 'ZIGAGYYT' ? '10w_rank' : 'redfox'] }))
  const errors = await writeArtifact(input.workdir, 'redfox-gzh-errors.json', { source: 'redfox', target_date: targetDate, requested_range: requestedRange, rows: result.errors || [], generated_at: generatedAt })
  errors.artifact_type = 'exceptions'; errors.schema_version = '1'; errors.record_count = result.errors?.length || 0
  const debugArtifacts = [raw, errors].map(artifact => ({ ...artifact, kind: 'debug', default_visible: false }))
  const accounts = accountRowsFromArticles(redfoxRows, { source: 'redfox' })
  let stage
  try {
    stage = await runArticleFilterStage({
      input,
      accountRows: accounts,
      articleRows: redfoxRows,
      source: 'redfox',
      databaseName: 'redfox-article-filter.sqlite',
      now: generatedAt
    })
  } catch (error) {
    error.request_count = result.request_count + (Number(error.request_count) || 0)
    throw error
  }
  const normalized = await writeArtifact(input.workdir, 'redfox-gzh-articles.json', { source: 'redfox', target_date: endDate || targetDate, requested_date: targetDate, requested_range: requestedRange, effective_data_dates: (result.sources || []).filter(source => source?.status === 'success').map(source => ({ source_no: source.no, effective_data_date: source.date, start_date: source.start_date, end_date: source.end_date })), rows: stage.articles, generated_at: generatedAt })
  normalized.artifact_type = 'articles'; normalized.schema_version = '1'; normalized.record_count = stage.articles.length
  const accountArtifact = await writeArtifact(input.workdir, 'redfox-gzh-accounts.json', { source: 'redfox', rows: stage.accounts, generated_at: generatedAt })
  accountArtifact.artifact_type = 'accounts'; accountArtifact.schema_version = '1'; accountArtifact.record_count = stage.accounts.length
  const filtered = await writeArtifact(input.workdir, 'redfox-gzh-filtered-articles.json', { source: 'redfox', target_date: endDate || targetDate, requested_range: requestedRange, rows: stage.filteredArticles, generated_at: generatedAt })
  filtered.artifact_type = 'filtered_articles'; filtered.schema_version = '1'; filtered.record_count = stage.filteredArticles.length
  const writeSet = await writeArtifact(input.workdir, 'redfox-gzh-write-set.json', stage.writeSet)
  writeSet.artifact_type = 'write_set'; writeSet.schema_version = '1'; writeSet.record_count = (stage.writeSet.articles?.length || 0) + (stage.writeSet.accounts?.length || 0)
  const report = await writeArtifact(input.workdir, 'redfox-gzh-filter-report.json', stage.report)
  report.artifact_type = 'debug_report'; report.schema_version = '1'; report.record_count = redfoxRows.length
  report.kind = 'debug'; report.default_visible = false
  const bySource = Object.fromEntries((result.sources || []).map(source => [source.no, { status: source.status, requested_date: targetDate, requested_range: requestedRange, effective_data_date: source.date, effective_start_date: source.start_date, effective_end_date: source.end_date, rows: source.row_count || 0 }]))
  const selected = stage.filteredArticles.length
  const filteredCount = redfoxRows.length - selected
  return {
    status: result.status,
    input_count: redfoxRows.length,
    output_count: selected,
    created_count: stage.report.accounts.created,
    updated_count: stage.report.accounts.updated,
    filtered_count: filteredCount,
    request_count: result.request_count + stage.filter_rule_request_count,
    duration_ms: Date.now() - started,
    artifact: [accountArtifact, normalized, filtered, writeSet],
    debug_artifacts: [...debugArtifacts, report],
    error_code: result.status === 'success' ? undefined : 'SOURCE_PARTIAL',
    message: result.status === 'success' ? 'RedFox article collection and shared filtering completed' : 'RedFox article collection completed with source errors',
    business_summary: { valid_articles: redfoxRows.length, selected, filtered: filteredCount, accounts: stage.accounts.length, exceptions: result.errors?.length || 0, requests: result.request_count + stage.filter_rule_request_count, by_source: bySource, filter_rules: stage.report.filterRules }
  }
}

if (import.meta.main) runCollectorMain(collect)

export { collect }
