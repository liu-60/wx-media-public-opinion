import { spawn } from 'node:child_process'
import { readArtifact, runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'
import { buildSupabaseWriteSet } from '../../src/supabase-sink.mjs'
import { loadCollectorEnvironment } from '../../src/collector-config.mjs'

function jsonContent(value) {
  if (value && typeof value === 'object') return value
  const raw = String(value || '').replace(/^```(?:json)?/iu, '').replace(/```$/u, '').trim()
  try { return JSON.parse(raw) } catch {}
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) { try { return JSON.parse(raw.slice(start, end + 1)) } catch {} }
  return null
}

async function judge(article, { endpoint, apiKey, model }) {
  const response = await fetch(`${endpoint.replace(/\/$/u, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' }, messages: [
      { role: 'system', content: '你是公众号文章筛选器。只返回JSON：{"decision":"pass"或"filter","reason":"简短原因","confidence":0到1}。不能输出其它字段。' },
      { role: 'user', content: JSON.stringify({ title: article.title, summary: article.content || article.digest || '', url: article.article_url, read_num: article.read_num }) }
    ] })
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) { const error = new Error(`LLM HTTP ${response.status}`); error.code = response.status === 429 ? 'RATE_LIMIT' : 'LLM_ERROR'; throw error }
  const parsed = jsonContent(body?.choices?.[0]?.message?.content)
  if (!parsed || !['pass', 'filter'].includes(parsed.decision) || typeof parsed.reason !== 'string' || !Number.isFinite(Number(parsed.confidence))) { const error = new Error('LLM output schema is invalid'); error.code = 'OUTPUT_SCHEMA_INVALID'; throw error }
  return { decision: parsed.decision, reason: parsed.reason, confidence: Math.max(0, Math.min(1, Number(parsed.confidence))) }
}

function runCodexBatch(prompt, { timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--skip-git-repo-check', '--cd', process.env.TEMP || process.env.TMP || '.', '--color', 'never', '--json', '-']
    const child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill(); const error = new Error('Codex CLI LLM timeout'); error.code = 'LLM_ERROR'; reject(error) }, timeoutMs)
    child.stdout.on('data', value => { stdout += value })
    child.stderr.on('data', value => { stderr += value })
    child.once('error', error => { clearTimeout(timer); error.code ||= 'LLM_ERROR'; reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (code !== 0) { const error = new Error(`Codex CLI exited with ${code}`); error.code = 'LLM_ERROR'; error.stderr = stderr.slice(-500); reject(error); return }
      const messages = []
      for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
        try { const event = JSON.parse(line); if (event.type === 'item.completed' && event.item?.type === 'agent_message') messages.push(event.item.text) } catch {}
      }
      const parsed = jsonContent(messages.at(-1))
      if (!parsed) { const error = new Error('Codex CLI returned invalid JSON'); error.code = 'OUTPUT_SCHEMA_INVALID'; reject(error); return }
      resolve(parsed)
    })
    child.stdin.end(prompt)
  })
}

async function judgeCodexBatch(articles) {
  const input = articles.map(article => ({
    article_id: String(article.article_id || article.article_key || article.article_url || article.title),
    title: String(article.title || '').slice(0, 300),
    summary: String(article.content || article.digest || '').slice(0, 1200),
    url: article.article_url || '',
    read_num: article.read_num ?? null
  }))
  const prompt = `你是公众号舆情文章筛选器。请逐条判断下面所有文章是否适合进入文章库。只依据标题、摘要、链接和阅读数，遵守：必须返回每个输入 article_id 恰好一条结果；decision 只能是 pass 或 filter；reason 是简短中文原因；confidence 是 0 到 1 的数字。只返回严格 JSON 对象，不要 Markdown、解释或其它文本，格式为 {"decisions":[{"article_id":"原值","decision":"pass","reason":"...","confidence":0.8}]}。文章数据：${JSON.stringify(input)}`
  const value = await runCodexBatch(prompt)
  if (!Array.isArray(value.decisions)) { const error = new Error('Codex CLI batch output has no decisions array'); error.code = 'OUTPUT_SCHEMA_INVALID'; throw error }
  const byId = new Map()
  for (const row of value.decisions) {
    const id = String(row?.article_id || '')
    const decision = String(row?.decision || '')
    if (!id || !['pass', 'filter'].includes(decision) || typeof row.reason !== 'string' || !Number.isFinite(Number(row.confidence))) continue
    byId.set(id, { decision, reason: row.reason, confidence: Math.max(0, Math.min(1, Number(row.confidence))) })
  }
  return { byId, input_count: input.length }
}

async function judgeCodexBatches(articles, batchSize = 40) {
  const byId = new Map()
  const failures = []
  let requestCount = 0
  for (let offset = 0; offset < articles.length; offset += batchSize) {
    const batch = articles.slice(offset, offset + batchSize)
    try {
      const judged = await judgeCodexBatch(batch)
      requestCount += 1
      for (const [id, value] of judged.byId) byId.set(id, value)
    } catch (error) {
      requestCount += 1
      for (const article of batch) failures.push({ article_id: article.article_id, code: error.code || 'LLM_ERROR', message: error.message })
    }
  }
  return { byId, request_count: requestCount, failures }
}

async function collect(input) {
  const started = Date.now()
  const reportRef = input.input_artifacts?.find(ref => ref.artifact_id === 'articles-filter-report.json' || ref.artifact_id?.includes('articles-filter-report')) || input.input_artifacts?.find(ref => ref.artifact_type === 'debug_report')
  const articleRef = input.input_artifacts?.find(ref => ref.artifact_id === 'all-normalized-articles.json') || input.input_artifacts?.find(ref => ref.artifact_type === 'articles')
  const baseWriteSetRef = input.input_artifacts?.find(ref => ref.artifact_id === 'write-set.json') || input.input_artifacts?.find(ref => ref.artifact_type === 'write_set')
  if (!reportRef || !articleRef || !baseWriteSetRef) { const error = new Error('LLM filter inputs are missing'); error.code = 'INPUT_MISSING'; throw error }
  const report = await readArtifact(input.workdir, reportRef)
  const articleValue = await readArtifact(input.workdir, articleRef)
  const baseWriteSet = await readArtifact(input.workdir, baseWriteSetRef)
  const articleRows = articleValue.rows || articleValue.articles || []
  const decisions = report.articles?.decisions || []
  const byId = new Map(articleRows.map(row => [String(row.article_id || row.article_key || row.article_url || row.title), row]))
  const undecided = decisions.filter(row => ['ACCOUNT_UNDECIDED', 'ACCOUNT_UNMATCHED', 'REVIEW'].includes(row.status))
  const env = loadCollectorEnvironment()
  const endpoint = String(env.LLM_BASE_URL || env.OPENAI_BASE_URL || '').trim()
  const apiKey = String(env.LLM_API_KEY || env.OPENAI_API_KEY || env.AI_GATEWAY_API_KEY || '').trim()
  const model = env.LLM_MODEL || env.OPENAI_MODEL || 'gpt-4o-mini'
  const results = []
  const errors = []
  let requestCount = 0
  const codexProvider = !endpoint && !apiKey && env.LLM_CODEX_CLI === '1' && String(env.LLM_ENABLED).toLowerCase() !== 'false'
  if (codexProvider && undecided.length) {
    try {
      const judged = await judgeCodexBatches(undecided.map(row => byId.get(String(row.article_id))).filter(Boolean), Math.max(1, Math.min(50, Number(env.LLM_CODEX_BATCH_SIZE || 40))))
      requestCount += judged.request_count
      errors.push(...judged.failures)
      const failedIds = new Set(judged.failures.map(row => String(row.article_id)))
      for (const decision of undecided) {
        const article = byId.get(String(decision.article_id))
        if (!article) { errors.push({ article_id: decision.article_id, code: 'INPUT_MISSING', message: 'article row missing' }); continue }
        const value = judged.byId.get(String(decision.article_id))
        if (!value) { if (!failedIds.has(String(decision.article_id))) errors.push({ article_id: decision.article_id, code: 'OUTPUT_SCHEMA_INVALID', message: 'Codex CLI omitted or invalidated this article decision' }); continue }
        results.push({ ...decision, status: value.decision === 'pass' ? 'SELECTED' : 'ACCOUNT_FILTERED', decision_source: 'llm', reason: value.reason, llm_confidence: value.confidence })
      }
    } catch (error) {
      requestCount += 1
      errors.push({ article_id: null, code: error.code || 'LLM_ERROR', message: error.message })
    }
  } else {
    for (const decision of undecided) {
      const article = byId.get(String(decision.article_id))
      if (!article) { errors.push({ article_id: decision.article_id, code: 'INPUT_MISSING', message: 'article row missing' }); continue }
      if (String(env.LLM_ENABLED).toLowerCase() !== 'true' || !endpoint || !apiKey) { errors.push({ article_id: decision.article_id, code: String(env.LLM_ENABLED).toLowerCase() !== 'true' ? 'LLM_DISABLED' : 'LLM_ERROR', message: String(env.LLM_ENABLED).toLowerCase() !== 'true' ? 'LLM is disabled in central configuration' : 'no LLM provider credentials are configured' }); continue }
      try {
        const judged = await judge(article, { endpoint, apiKey, model })
        requestCount += 1
        results.push({ ...decision, status: judged.decision === 'pass' ? 'SELECTED' : 'ACCOUNT_FILTERED', decision_source: 'llm', reason: judged.reason, llm_confidence: judged.confidence })
      } catch (error) {
        requestCount += 1
        errors.push({ article_id: decision.article_id, code: error.code || 'LLM_ERROR', message: error.message })
      }
    }
  }
  const updated = new Map(decisions.map(row => [String(row.article_id), row]))
  for (const row of results) updated.set(String(row.article_id), row)
  const updatedReport = { ...report, articles: { ...report.articles, decisions: [...updated.values()], statusCounts: Object.fromEntries([...new Set([...updated.values()].map(row => row.status))].map(status => [status, [...updated.values()].filter(row => row.status === status).length])) } }
  const accountValue = input.strategy_snapshot_ref ? await readArtifact(input.workdir, input.strategy_snapshot_ref) : { approved_accounts: [] }
  const writeSet = buildSupabaseWriteSet({ accountRows: accountValue.approved_accounts || [], articleRows, report: updatedReport, runDate: report.runDate, now: new Date().toISOString(), source: 'collector' })
  // Preserve the deterministic filter's complete account write candidates. The
  // LLM stage only revises article decisions and must not replace account sync
  // candidates with the usually smaller approved-account strategy snapshot.
  writeSet.accounts = Array.isArray(baseWriteSet.accounts) ? baseWriteSet.accounts : writeSet.accounts
  writeSet.hotwords = Array.isArray(baseWriteSet.hotwords) ? baseWriteSet.hotwords : writeSet.hotwords
  writeSet.metadata = { ...(baseWriteSet.metadata || {}), ...(writeSet.metadata || {}), source: 'collector' }
  const artifact = await writeArtifact(input.workdir, 'llm-write-set.json', writeSet)
  artifact.artifact_type = 'write_set'; artifact.schema_version = '1'; artifact.record_count = writeSet.articles.length + writeSet.accounts.length + writeSet.hotwords.length
  const provider = endpoint && apiKey ? 'openai-compatible' : codexProvider ? 'codex-cli' : 'unavailable'
  const reportArtifact = await writeArtifact(input.workdir, 'llm-filter-report.json', { input_count: undecided.length, decisions: results, errors, request_count: requestCount, provider, model, pass_count: results.filter(row => row.status === 'SELECTED').length, filter_count: results.filter(row => row.status === 'ACCOUNT_FILTERED').length, failed_count: errors.length })
  reportArtifact.artifact_type = 'filter_report'; reportArtifact.schema_version = '1'; reportArtifact.record_count = undecided.length
  const status = errors.length ? (results.length ? 'partial' : (undecided.length ? 'partial' : 'success')) : 'success'
  return { status, input_count: undecided.length, output_count: results.length, created_count: results.filter(row => row.status === 'SELECTED').length, updated_count: 0, filtered_count: results.filter(row => row.status === 'ACCOUNT_FILTERED').length, request_count: requestCount, duration_ms: Date.now() - started, artifact, debug_artifacts: [{ ...reportArtifact, kind: 'debug', default_visible: false }], error_code: errors[0]?.code, message: errors.length ? `${errors.length} LLM decision(s) failed without PASS fallback` : `LLM filter completed for ${undecided.length} undecided article(s)`, business_summary: { provider, model, llm_input_count: undecided.length, llm_pass_count: results.filter(row => row.status === 'SELECTED').length, llm_filter_count: results.filter(row => row.status === 'ACCOUNT_FILTERED').length, llm_failed_count: errors.length } }
}

if (import.meta.main) runCollectorMain(collect)

export { collect }
