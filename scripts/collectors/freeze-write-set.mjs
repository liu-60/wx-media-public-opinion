import { readArtifact, runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'
import { createRuleSnapshot } from '../../src/article-filter.mjs'
import { createSupabaseClient } from '../../management-center/services/supabase.mjs'

function unique(values) { return [...new Set(values.filter(Boolean).map(String))] }
function chunks(values, size = 200) { const result = []; for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size)); return result }

async function listByIn(client, table, column, values, columns) {
  const rows = []
  for (const part of chunks(unique(values))) {
    const result = await client.list(table, { columns, filters: [{ column, operator: 'in', value: part }], limit: 5000 })
    rows.push(...(Array.isArray(result.data) ? result.data : []))
  }
  return rows
}

function hotwordRows(value, runDate) {
  const rows = value.rows || []
  return rows.filter(row => Number(row.article_count) >= 2).map(row => ({
    hotword: String(row.word || row.hotword || '').trim(), aliases: Array.isArray(row.aliases) ? row.aliases : [], stat_date: String(row.stat_date || runDate).replaceAll('-', '').replace(/^(\d{4})(\d{2})(\d{2})$/u, '$1-$2-$3'), article_count: Math.trunc(Number(row.article_count)), article_keys: unique(row.article_keys || row.article_ids), article_url: row.article_url || row.examples?.[0] || null
  })).filter(row => row.hotword && row.stat_date && row.article_count >= 2)
}

async function collect(input) {
  const started = Date.now()
  const writeSetRef = input.input_artifacts?.find(ref => ref.artifact_type === 'write_set') || input.input_artifacts?.[0]
  const articleRef = input.input_artifacts?.find(ref => ref.artifact_type === 'articles')
  const hotwordRef = input.input_artifacts?.find(ref => ref.artifact_type === 'hotwords')
  if (!writeSetRef || !articleRef || !hotwordRef) { const error = new Error('frozen write set inputs are missing'); error.code = 'INPUT_MISSING'; throw error }
  const original = await readArtifact(input.workdir, writeSetRef)
  const articleValue = await readArtifact(input.workdir, articleRef)
  const hotwordValue = await readArtifact(input.workdir, hotwordRef)
  const strategy = input.strategy_snapshot_ref ? await readArtifact(input.workdir, input.strategy_snapshot_ref) : {}
  const rulesSnapshot = input.rule_snapshot_ref ? await readArtifact(input.workdir, input.rule_snapshot_ref) : null
  const client = createSupabaseClient({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY })
  const accountItems = Array.isArray(original.accounts) ? original.accounts : []
  const accountRows = await listByIn(client, 'accounts', 'wx_biz', accountItems.map(item => item.wx_biz), ['account_id', 'wx_biz', 'decision_status', 'decision_source', 'updated_at'])
  const accountByBiz = new Map(accountRows.map(row => [row.wx_biz, row]))
  const currentRules = await client.list('filter_rules', { columns: ['id', 'scope', 'field_name', 'operator', 'value_text', 'value_number', 'enabled'], filters: [{ column: 'enabled', operator: 'eq', value: true }], limit: 5000 })
  const currentRuleSnapshot = createRuleSnapshot(currentRules.data || [], { source: 'supabase', loadedAt: new Date().toISOString() })
  const exceptions = []
  if (rulesSnapshot?.hash && currentRuleSnapshot.hash !== rulesSnapshot.hash) exceptions.push({ code: 'PUBLISH_CONFLICT', field: 'filter_rules', expected: rulesSnapshot.hash, actual: currentRuleSnapshot.hash })
  for (const item of accountItems) {
    const current = accountByBiz.get(item.wx_biz)
    const expected = (strategy.account_decisions || strategy.approved_accounts || []).find(row => row.wx_biz === item.wx_biz)
    if (expected && current && Number(current.decision_status) !== Number(expected.decision_status ?? 1)) exceptions.push({ code: 'PUBLISH_CONFLICT', field: 'decision_status', wx_biz: item.wx_biz, expected: expected.decision_status, actual: current.decision_status })
  }
  const articleRows = original.articles || []
  const currentArticles = await listByIn(client, 'articles', 'account_id', [...accountByBiz.values()].map(row => row.account_id), ['id', 'account_id', 'article_sn', 'idx', 'title'])
  const currentArticleKeys = new Set(currentArticles.map(row => `${row.account_id}:${row.article_sn}:${row.idx || 1}`))
  const accountsCreate = accountItems.filter(item => !accountByBiz.has(item.wx_biz))
  const accountsUpdate = accountItems.filter(item => accountByBiz.has(item.wx_biz))
  const articlesCreate = []
  const articlesUpdate = []
  let duplicateSkip = 0
  for (const article of articleRows) {
    const account = accountByBiz.get(article.wx_biz)
    const key = account ? `${account.account_id}:${article.article_sn}:${article.idx || 1}` : ''
    if (key && currentArticleKeys.has(key)) { duplicateSkip += 1; continue }
    if (article.decision_source === 'UPDATE') articlesUpdate.push(article)
    else articlesCreate.push(article)
  }
  const hotwords = hotwordRows(hotwordValue, input.config.run_date || new Date().toISOString().slice(0, 10))
  const frozen = {
    schema_version: 'frozen-write-set-v1',
    generated_at: new Date().toISOString(),
    accounts: accountItems,
    articles: [...articlesCreate, ...articlesUpdate],
    hotwords,
    accounts_create: accountsCreate,
    accounts_update: accountsUpdate,
    articles_create: articlesCreate,
    articles_update: articlesUpdate,
    hotwords_upsert: hotwords,
    exceptions,
    preflight: { existing_accounts: accountRows.length, existing_articles: currentArticles.length, duplicate_skip: duplicateSkip, current_rule_hash: currentRuleSnapshot.hash, expected_rule_hash: rulesSnapshot?.hash || null, filter_rule_count: currentRuleSnapshot.count }
  }
  const artifact = await writeArtifact(input.workdir, 'frozen-write-set.json', frozen)
  artifact.artifact_type = 'write_set'; artifact.schema_version = '1'; artifact.record_count = frozen.articles.length + frozen.accounts.length + frozen.hotwords.length
  const status = exceptions.length ? 'failed' : 'success'
  return { status, input_count: (articleValue.rows || []).length, output_count: frozen.articles.length, created_count: articlesCreate.length, updated_count: articlesUpdate.length, filtered_count: duplicateSkip, request_count: 0, duration_ms: Date.now() - started, artifact, error_code: exceptions.length ? 'PUBLISH_CONFLICT' : undefined, message: exceptions.length ? `${exceptions.length} publish preflight conflict(s)` : 'frozen write set created', business_summary: { accounts_create: accountsCreate.length, accounts_update: accountsUpdate.length, articles_create: articlesCreate.length, articles_update: articlesUpdate.length, hotwords_upsert: hotwords.length, duplicate_skip: duplicateSkip, exceptions: exceptions.length } }
}

if (import.meta.main) runCollectorMain(collect)

export { collect }
