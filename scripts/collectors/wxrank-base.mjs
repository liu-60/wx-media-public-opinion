import { fetchAccountSources } from '../../src/wxrank-client.mjs'
import { readCollectorInput, runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'

async function collect(input) {
  const started = Date.now()
  const headers = {}
  if (process.env.WXRANK_AUTHORIZATION) headers.authorization = process.env.WXRANK_AUTHORIZATION
  if (process.env.WXRANK_COOKIE) headers.cookie = process.env.WXRANK_COOKIE
  const source = await fetchAccountSources({ baseUrl: input.config.base_url || 'https://wxrank.com', range: input.config.range || '30d', headers })
  const fetchedAt = new Date().toISOString()
  const raw = await writeArtifact(input.workdir, 'wxrank-base-raw.json', { source: 'wxrank', rank: source.rank, search: source.search, fetched_at: fetchedAt })
  raw.artifact_type = 'raw_response'; raw.schema_version = '1'; raw.record_count = source.rows.length
  const errors = []
  const rows = source.rows.map((row, index) => {
    const wxBiz = String(row.wx_biz || row.wxBiz || row.__biz || row.biz || '').trim()
    const normalized = {
      ...row,
      wx_biz: wxBiz || null,
      wx_name: String(row.wx_name || row.wxName || row.name || row.nickname || '').trim(),
      verify: row.verify ?? row.is_verify ?? row.certified ?? null,
      description: String(row.description || row.desc || '').trim(),
      source: row.source || 'wxrank'
    }
    if (!wxBiz) errors.push({ index, code: 'IDENTITY_MISSING', message: 'wx_biz is missing', raw: row })
    return normalized
  }).filter(row => row.wx_biz)
  const normalized = await writeArtifact(input.workdir, 'accounts.json', { source: 'wxrank', schema_version: '1', rows, fetched_at: fetchedAt })
  normalized.artifact_type = 'accounts'; normalized.schema_version = '1'; normalized.record_count = rows.length
  const errorArtifact = await writeArtifact(input.workdir, 'wxrank-base-errors.json', { source: 'wxrank', rows: errors, generated_at: fetchedAt })
  errorArtifact.artifact_type = 'exceptions'; errorArtifact.schema_version = '1'; errorArtifact.record_count = errors.length
  const debugArtifacts = [raw, errorArtifact].map(artifact => ({ ...artifact, kind: 'debug', default_visible: false }))
  if (!source.rows.length) return { status: 'failed', input_count: null, output_count: 0, created_count: null, updated_count: null, filtered_count: null, request_count: 2, duration_ms: Date.now() - started, artifact: normalized, debug_artifacts: debugArtifacts, error_code: 'EMPTY_RESULT', message: 'WxRank returned no account rows' }
  return { status: errors.length ? 'partial' : 'success', input_count: source.rows.length, output_count: rows.length, created_count: null, updated_count: null, filtered_count: errors.length, request_count: 2, duration_ms: Date.now() - started, artifact: normalized, debug_artifacts: debugArtifacts, error_code: errors.length ? 'PARTIAL_RESULT' : undefined, message: errors.length ? `${errors.length} account rows require review` : 'WxRank account sources collected', business_summary: { fetched: source.rows.length, valid: rows.length, invalid: errors.length, requests: 2 } }
}

if (import.meta.main) runCollectorMain(collect)

export { collect }
