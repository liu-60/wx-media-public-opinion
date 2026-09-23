import { readArtifact, runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'
import { fetchWxRankArticleList } from '../../src/collector-adapters/wxrank-articles.mjs'

function dateKey(value) {
  const raw = String(value || '').trim().replaceAll('-', '')
  if (/^20\d{6}$/u.test(raw)) return raw
  const parsed = new Date(value || Date.now())
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString().slice(0, 10).replaceAll('-', '') : parsed.toISOString().slice(0, 10).replaceAll('-', '')
}

function dateMinusDays(value, days) {
  const date = new Date(`${String(value).slice(0, 4)}-${String(value).slice(4, 6)}-${String(value).slice(6, 8)}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

function latestDateFromMessage(message, fallback) {
  const match = /(?:不能大于|大于|latest[^0-9]*)(20\d{6})/iu.exec(String(message || ''))
  return match ? match[1] : fallback
}

function numeric(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(String(value).replaceAll(',', ''))
  return Number.isFinite(number) ? Math.trunc(number) : null
}

function dateTime(value) {
  if (!value) return null
  const raw = String(value).trim()
  const withZone = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/u.test(raw) ? `${raw.replace(' ', 'T')}+08:00` : raw
  const date = new Date(withZone)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function fromWxRank(row, { reason, requestedDate, effectiveDate }) {
  const url = String(row.art_url || row.article_url || '').trim()
  let parsed = {}
  try {
    const value = new URL(url)
    parsed = { wx_biz: value.searchParams.get('__biz') || '', article_sn: value.searchParams.get('sn') || '', mid: value.searchParams.get('mid') || '', idx: Number(value.searchParams.get('idx')) || 1 }
  } catch {}
  const readRaw = row.read_num
  const capped = typeof readRaw === 'string' && /(?:\d+(?:\.\d+)?w\+|\d+(?:\.\d+)?万\+|100000\+)/iu.test(readRaw)
  return {
    title: String(row.title || '').trim(),
    wx_biz: String(row.wx_biz || parsed.wx_biz || '').trim() || null,
    article_sn: String(row.sn || parsed.article_sn || '').trim() || null,
    mid: String(parsed.mid || '').trim() || null,
    idx: parsed.idx || 1,
    article_url: url || null,
    published_at: dateTime(row.pub_time),
    read_num: capped ? 100001 : numeric(readRaw),
    read_num_capped: capped,
    like_num: numeric(row.like_num),
    look_num: numeric(row.look_num),
    share_num: numeric(row.share_num),
    comment_num: null,
    is_original: row.copyright === undefined || row.copyright === null ? null : Boolean(row.copyright),
    publisher: String(row.wx_name || '').trim() || null,
    wx_type: String(row.wx_type || '').trim() || null,
    source_platform: 'wxrank',
    collect_reasons: [reason],
    requested_date: requestedDate,
    effective_data_date: effectiveDate,
    raw: row
  }
}

async function readStrategy(input) {
  if (!input.strategy_snapshot_ref) return { approved_accounts: [], groups: [], request_budget: {} }
  return readArtifact(input.workdir, input.strategy_snapshot_ref)
}

function addRequestPlan(plan, request, reason) {
  plan.push({ ...request, reason })
}

async function collect(input) {
  const started = Date.now()
  const strategy = await readStrategy(input)
  const runDate = dateKey(input.config.run_date || new Date())
  const approved = Array.isArray(strategy.approved_accounts) ? strategy.approved_accounts.filter(row => row?.wx_biz) : []
  const groups = Array.isArray(strategy.groups) ? strategy.groups : []
  const probe = await fetchWxRankArticleList({ apiKey: process.env.WXRANK_API_KEY, date: runDate, fetchImpl: globalThis.fetch })
  let requestCount = probe.request_count || 0
  const raw = [{ plan: { date: runDate, reason: 'date_probe' }, status: probe.status, error_code: probe.error_code, response: probe.response, data: probe.data }]
  const errors = []
  const rows = []
  let waitingAuth = probe.status === 'waiting_auth'
  if (probe.status === 'waiting_auth') errors.push({ plan: { date: runDate, reason: 'date_probe' }, code: probe.error_code, message: probe.message })
  const effectiveDate = probe.status === 'failed' && probe.error_code === 'API_BUSINESS_ERROR' ? latestDateFromMessage(probe.message, dateMinusDays(runDate, 1)) : runDate
  const dateFallback = probe.status === 'failed' && probe.error_code === 'API_BUSINESS_ERROR' && effectiveDate !== runDate
  if (probe.status === 'failed' && !dateFallback && probe.error_code !== 'EMPTY_RESULT') errors.push({ plan: { date: runDate, reason: 'date_probe' }, code: probe.error_code, message: probe.message })
  if (probe.status === 'success') for (const row of probe.data?.list || []) rows.push(fromWxRank(row, { reason: 'date_today', requestedDate: runDate, effectiveDate }))
  const plans = []
  const budget = strategy.request_budget || {}
  const accountLimit = Math.min(approved.length, Number(input.config.approved_account_max_requests ?? budget.approved_account ?? approved.length))
  for (const account of approved.slice(0, Math.max(0, accountLimit))) addRequestPlan(plans, { date: effectiveDate, wxBiz: account.wx_biz }, 'approved_account')
  const groupBudget = groups.reduce((total, group) => total + Math.max(0, Number(group.cursor || 0)), 0)
  if (groupBudget > 0) {
    for (const group of groups) {
      const pages = Math.min(Math.max(0, Number(group.cursor || 0)), Number(input.config.max_strategy_pages || 10))
      for (let page = 0; page < pages; page += 1) addRequestPlan(plans, { date: group.date || runDate, month: group.month || undefined, wxType: group.request_type === 'wx_type' ? group.type || group.wx_type || group.active_targets?.[0] : undefined, cursor: page ? undefined : undefined }, `strategy_category:${group.type || group.request_type}`)
    }
  }
  if (input.config.enable_global_plans !== false) {
    if (probe.status !== 'success') addRequestPlan(plans, { date: effectiveDate }, 'date_today')
    addRequestPlan(plans, { date: dateMinusDays(effectiveDate, 1) }, 'date_yesterday')
    addRequestPlan(plans, { month: runDate.slice(0, 6) }, 'month_current')
  }
  const maxRequests = Math.max(0, Number(input.config.max_requests ?? strategy.request_budget?.max_total ?? plans.length + requestCount))
  const fatalProbe = probe.status === 'failed' && !dateFallback && probe.error_code !== 'EMPTY_RESULT'
  const selectedPlans = fatalProbe ? [] : plans.slice(0, Math.max(0, maxRequests - requestCount))
  const byReason = {}
  for (const plan of selectedPlans) {
    const result = await fetchWxRankArticleList({ apiKey: process.env.WXRANK_API_KEY, date: plan.date, month: plan.month, wxBiz: plan.wxBiz, minReadNum: plan.minReadNum, maxReadNum: plan.maxReadNum, keyword: plan.keyword, wxType: plan.wxType, fetchImpl: globalThis.fetch })
    requestCount += result.request_count || 0
    raw.push({ plan, status: result.status, error_code: result.error_code, response: result.response, data: result.data })
    if (result.status === 'waiting_auth') { waitingAuth = true; errors.push({ plan, code: result.error_code, message: result.message }); break }
    if (result.status !== 'success') { errors.push({ plan, code: result.error_code, message: result.message }); if (['AUTH_ERROR', 'BALANCE_INSUFFICIENT', 'RATE_LIMIT', 'UPSTREAM_TIMEOUT', 'HTTP_ERROR'].includes(result.error_code)) break; continue }
    const list = Array.isArray(result.data?.list) ? result.data.list : []
    byReason[plan.reason] = (byReason[plan.reason] || 0) + list.length
    const effectiveDate = plan.date || `${plan.month || ''}01`
    for (const row of list) rows.push(fromWxRank(row, { reason: plan.reason, requestedDate: plan.date || plan.month, effectiveDate }))
  }
  const generatedAt = new Date().toISOString()
  const artifact = await writeArtifact(input.workdir, 'wxrank-articles.json', { source: 'wxrank', run_date: runDate, requested_date: runDate, effective_data_date: effectiveDate, date_resolution: { requested_date: runDate, effective_data_date: effectiveDate, fallback: dateFallback, probe_code: probe.error_code || 'OK' }, rows, generated_at: generatedAt, request_summary: { by_reason: byReason, planned: plans.length + 1, executed: selectedPlans.length + 1 } })
  artifact.artifact_type = 'articles'; artifact.schema_version = '1'; artifact.record_count = rows.length
  const rawArtifact = await writeArtifact(input.workdir, 'wxrank-article-raw.json', { source: 'wxrank', requests: raw, generated_at: generatedAt })
  rawArtifact.artifact_type = 'raw_response'; rawArtifact.schema_version = '1'; rawArtifact.record_count = raw.length
  const errorArtifact = await writeArtifact(input.workdir, 'wxrank-article-errors.json', { source: 'wxrank', rows: errors, generated_at: generatedAt })
  errorArtifact.artifact_type = 'exceptions'; errorArtifact.schema_version = '1'; errorArtifact.record_count = errors.length
  if (waitingAuth) return { status: 'waiting_auth', input_count: selectedPlans.length, output_count: rows.length, created_count: null, updated_count: null, filtered_count: errors.length, request_count: requestCount, duration_ms: Date.now() - started, artifact, debug_artifacts: [rawArtifact, errorArtifact].map(item => ({ ...item, kind: 'debug', default_visible: false })), error_code: 'AUTH_ERROR', message: 'WxRank article API authentication is unavailable' }
  const status = errors.length ? (rows.length ? 'partial' : 'failed') : 'success'
  return { status, input_count: selectedPlans.length, output_count: rows.length, created_count: null, updated_count: null, filtered_count: errors.length, request_count: requestCount, duration_ms: Date.now() - started, artifact, debug_artifacts: [rawArtifact, errorArtifact].map(item => ({ ...item, kind: 'debug', default_visible: false })), error_code: errors.length ? errors[0].code : undefined, message: errors.length ? `${errors.length} WxRank request(s) were not usable` : 'WxRank article collection completed', business_summary: { by_reason: byReason, request_count: requestCount, errors: errors.length, planned: plans.length, executed: selectedPlans.length } }
}

if (import.meta.main) runCollectorMain(collect)

export { collect, fromWxRank }
