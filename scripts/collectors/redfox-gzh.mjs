import { fetchRedfoxSources } from '../../src/collector-adapters/redfox.mjs'
import { runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'

async function collect(input) {
  const started = Date.now()
  const targetDate = input.config.target_date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date())
  const sourceNos = Array.isArray(input.config.source_nos) && input.config.source_nos.length ? input.config.source_nos : ['OFFSPQ0U', 'ZIGAGYYT']
  const result = await fetchRedfoxSources({ targetDate, lookbackDays: Number(input.config.lookback_days ?? 2), sourceNos })
  if (result.status === 'waiting_auth') return { status: 'waiting_auth', input_count: null, output_count: null, created_count: null, updated_count: null, filtered_count: null, request_count: 0, duration_ms: Date.now() - started, artifact: null, error_code: result.error_code, message: result.message }
  const generatedAt = new Date().toISOString()
  const raw = await writeArtifact(input.workdir, 'redfox-gzh-raw.json', { source: 'redfox', target_date: targetDate, sources: result.raw_sources || result.sources, generated_at: generatedAt })
  raw.artifact_type = 'raw_response'; raw.schema_version = '1'; raw.record_count = result.raw_sources?.length ?? result.sources.length
  const redfoxRows = result.rows.map(row => ({ ...row, source_platform: 'redfox', collect_reasons: [row.source_no === 'OFFSPQ0U' ? 'original_rank' : row.source_no === 'ZIGAGYYT' ? '10w_rank' : 'redfox'] }))
  const normalized = await writeArtifact(input.workdir, 'redfox-gzh-articles.json', { source: 'redfox', target_date: targetDate, requested_date: targetDate, effective_data_dates: (result.sources || []).filter(source => source?.status === 'success').map(source => ({ source_no: source.no, effective_data_date: source.date })), rows: redfoxRows, generated_at: generatedAt })
  normalized.artifact_type = 'articles'; normalized.schema_version = '1'; normalized.record_count = redfoxRows.length
  const errors = await writeArtifact(input.workdir, 'redfox-gzh-errors.json', { source: 'redfox', target_date: targetDate, rows: result.errors || [], generated_at: generatedAt })
  errors.artifact_type = 'exceptions'; errors.schema_version = '1'; errors.record_count = result.errors?.length || 0
  const debugArtifacts = [raw, errors].map(artifact => ({ ...artifact, kind: 'debug', default_visible: false }))
  const bySource = Object.fromEntries((result.sources || []).map(source => [source.no, { status: source.status, requested_date: targetDate, effective_data_date: source.date, rows: source.row_count || 0 }]))
  return { status: result.status, input_count: result.sources?.length || 0, output_count: redfoxRows.length, created_count: null, updated_count: null, filtered_count: result.errors?.length || null, request_count: result.request_count, duration_ms: Date.now() - started, artifact: normalized, debug_artifacts: debugArtifacts, error_code: result.status === 'success' ? undefined : 'SOURCE_PARTIAL', message: result.message, business_summary: { valid_articles: redfoxRows.length, exceptions: result.errors?.length || 0, requests: result.request_count, by_source: bySource } }
}

if (import.meta.main) runCollectorMain(collect)

export { collect }
