import { readArtifact, runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'
import { fetchWxRankArticleList } from '../../src/collector-adapters/wxrank-articles.mjs'

function dateKey(value) {
  const raw = String(value || '').replaceAll('-', '').slice(0, 8)
  if (/^20\d{6}$/u.test(raw)) return raw
  return new Date().toISOString().slice(0, 10).replaceAll('-', '')
}

function fallbackDate(message, fallback) {
  const match = /(?:不能大于|大于)(20\d{6})/u.exec(String(message || ''))
  return match ? match[1] : fallback
}

async function collect(input) {
  const started = Date.now()
  const reference = input.input_artifacts?.[0]
  if (!reference) { const error = new Error('hotword snapshot input is missing'); error.code = 'INPUT_MISSING'; throw error }
  const snapshot = await readArtifact(input.workdir, reference)
  const candidates = [...(snapshot.new_hotwords_today || []), ...(snapshot.new_hotwords_yesterday || [])]
  const maxPerWord = Math.max(0, Number(input.config.max_requests_per_hotword ?? 2))
  const maxHotwords = Math.max(0, Number(input.config.max_hotwords ?? 20))
  const unique = [...new Map(candidates.filter(row => Number(row.article_count) >= 2).map(row => [row.word, row])).values()].slice(0, maxHotwords)
  const skippedHotwords = Math.max(0, new Set(candidates.filter(row => Number(row.article_count) >= 2).map(row => row.word)).size - unique.length)
  const maxTotalRequests = Math.max(0, Number(input.config.max_total_requests ?? maxHotwords * maxPerWord))
  const rows = []
  const raw = []
  const errors = []
  let requestCount = 0
  for (const hotword of unique) {
    if (requestCount >= maxTotalRequests) break
    let requestDate = dateKey(input.config.run_date)
    for (let attempt = 0; attempt < maxPerWord; attempt += 1) {
      if (requestCount >= maxTotalRequests) break
      const result = await fetchWxRankArticleList({ apiKey: process.env.WXRANK_API_KEY, date: requestDate, keyword: hotword.word })
      requestCount += result.request_count || 0
      raw.push({ hotword: hotword.word, attempt: attempt + 1, requested_date: requestDate, effective_data_date: requestDate, status: result.status, error_code: result.error_code, data: result.data })
      if (result.status === 'waiting_auth') { errors.push({ hotword: hotword.word, code: result.error_code, message: result.message }); break }
      if (result.status !== 'success') {
        const nextDate = fallbackDate(result.message, requestDate)
        if (result.error_code === 'API_BUSINESS_ERROR' && nextDate !== requestDate && attempt + 1 < maxPerWord) { requestDate = nextDate; continue }
        errors.push({ hotword: hotword.word, code: result.error_code, message: result.message }); break
      }
      for (const row of result.data?.list || []) rows.push({ ...row, source_platform: 'wxrank', collect_reasons: [`hotword:${hotword.word}`], hotword: hotword.word })
      break
    }
  }
  const artifact = await writeArtifact(input.workdir, 'hotword-articles.json', { source: 'wxrank', rows, generated_at: new Date().toISOString(), hotwords: unique.map(row => row.word), skipped_hotwords: skippedHotwords, request_count: requestCount })
  artifact.artifact_type = 'articles'; artifact.schema_version = '1'; artifact.record_count = rows.length
  const rawArtifact = await writeArtifact(input.workdir, 'hotword-expand-raw.json', { requests: raw, generated_at: new Date().toISOString() })
  rawArtifact.artifact_type = 'raw_response'; rawArtifact.schema_version = '1'; rawArtifact.record_count = raw.length
  const errorArtifact = await writeArtifact(input.workdir, 'hotword-expand-errors.json', { rows: errors })
  errorArtifact.artifact_type = 'exceptions'; errorArtifact.schema_version = '1'; errorArtifact.record_count = errors.length
  const waitingAuth = errors.some(error => error.code === 'AUTH_ERROR')
  const status = waitingAuth ? 'waiting_auth' : errors.length ? (rows.length ? 'partial' : 'failed') : 'success'
  return { status, input_count: unique.length, output_count: rows.length, created_count: null, updated_count: null, filtered_count: errors.length + skippedHotwords, request_count: requestCount, duration_ms: Date.now() - started, artifact, debug_artifacts: [rawArtifact, errorArtifact].map(item => ({ ...item, kind: 'debug', default_visible: false })), error_code: errors[0]?.code, message: errors.length ? `${errors.length} hotword request(s) were not usable` : 'hotword expansion completed', business_summary: { hotwords_selected: unique.length, hotwords_skipped: skippedHotwords, requests: requestCount, rows: rows.length, errors: errors.length, max_total_requests: maxTotalRequests } }
}

if (import.meta.main) runCollectorMain(collect)

export { collect }
