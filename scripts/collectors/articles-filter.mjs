import { readArtifact, runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'
import { aggregateHotwordsWithDiagnostics } from '../../src/hotwords.mjs'
import { runArticleFilterStage } from './article-filter-common.mjs'
import { loadHotwordFilterRules } from './hotword-filter-rules.mjs'
import { mergeCanonicalArticles } from '../../src/collection-canonical.mjs'
import { collect as runLlmFilter } from './llm-filter.mjs'
import { createSupabaseClient } from '../../management-center/services/supabase.mjs'

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

function rowsFrom(value) { return Array.isArray(value) ? value : Array.isArray(value?.rows) ? value.rows : Array.isArray(value?.articles) ? value.articles : [] }

async function collectPendingReview(input, dependencies, effectiveAccounts, accountRows, articleRows, accountDecisions, started) {
  const merged = mergeCanonicalArticles(articleRows)
  const stage = await runArticleFilterStage({ input, accountRows: effectiveAccounts, articleRows: merged.rows, source: 'collector', databaseName: input.config.database_name || 'articles-filter.sqlite', accountDecisions })
  const generatedAt = new Date().toISOString()
  const refs = Array.isArray(input.input_artifacts) ? input.input_artifacts : []
  const hotwordRef = refs.find(ref => ref.artifact_type === 'hotwords')
  const linksRef = refs.find(ref => ref.artifact_type === 'hotword_links')
  const hotwordRows = hotwordRef ? rowsFrom(await readArtifact(input.workdir, hotwordRef)) : []
  const hotwordLinks = linksRef ? rowsFrom(await readArtifact(input.workdir, linksRef)) : []
  const hotwordByKey = new Map(hotwordRows.map(row => [`${String(row.word || row.hotword || '')}\0${String(row.stat_date || '').slice(0, 10)}`, row]))
  const linksByArticle = new Map()
  for (const link of hotwordLinks) {
    const list = linksByArticle.get(link.article_key) || []
    list.push(link)
    linksByArticle.set(link.article_key, list)
  }
  const reportArtifact = await writeArtifact(input.workdir, input.config.report_output_name || 'articles-filter-report.json', stage.report)
  reportArtifact.artifact_type = 'debug_report'; reportArtifact.schema_version = '1'; reportArtifact.record_count = merged.rows.length
  reportArtifact.kind = 'debug'; reportArtifact.default_visible = false
  const articleArtifact = await writeArtifact(input.workdir, 'pending-review-source-articles.json', { rows: stage.articles, generated_at: generatedAt })
  articleArtifact.artifact_type = 'articles'; articleArtifact.schema_version = '1'; articleArtifact.record_count = stage.articles.length
  const baseWriteSetArtifact = await writeArtifact(input.workdir, 'write-set.json', stage.writeSet)
  baseWriteSetArtifact.artifact_type = 'write_set'; baseWriteSetArtifact.schema_version = '1'; baseWriteSetArtifact.record_count = (stage.writeSet.articles?.length || 0) + (stage.writeSet.accounts?.length || 0) + (stage.writeSet.hotwords?.length || 0)

  const finalDecisions = new Map((stage.report.articles?.decisions || []).map(row => [String(row.article_id), row]))
  const undecided = [...finalDecisions.values()].filter(row => ['ACCOUNT_UNDECIDED', 'ACCOUNT_UNMATCHED', 'REVIEW'].includes(row.status))
  const accountsByBiz = new Map(effectiveAccounts.filter(row => row?.wx_biz).map(row => [String(row.wx_biz), row]))
  const accountRowByBiz = new Map(accountRows.filter(row => row?.wx_biz).map(row => [String(row.wx_biz), row]))
  const env = dependencies.env || process.env
  const supabaseClient = dependencies.supabaseClient || (() => {
    const url = env.SUPABASE_URL
    const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY
    return url && key ? createSupabaseClient({ url, key, fetchImpl: dependencies.supabaseFetchImpl || globalThis.fetch }) : null
  })()
  const missingNameBiz = [...new Set(stage.articles
    .filter(row => {
      const articleName = String(row?.wx_name || row?.publisher || row?.account_name || row?.accountName || row?.public_name || row?.nickname || '').trim()
      const accountName = String(accountsByBiz.get(String(row?.wx_biz || ''))?.wx_name || accountRowByBiz.get(String(row?.wx_biz || ''))?.wx_name || '').trim()
      return row?.wx_biz && !articleName && !accountName
    })
    .map(row => String(row.wx_biz)))]
  const databaseNames = new Map()
  let accountNameLookupRequests = 0
  if (supabaseClient && missingNameBiz.length) {
    for (let offset = 0; offset < missingNameBiz.length; offset += 100) {
      const result = await supabaseClient.list('accounts', { columns: ['wx_biz', 'wx_name'], filters: [{ column: 'wx_biz', operator: 'in', value: missingNameBiz.slice(offset, offset + 100) }], limit: 100 })
      accountNameLookupRequests += 1
      for (const row of result.data || []) if (row?.wx_biz && String(row.wx_name || '').trim()) databaseNames.set(String(row.wx_biz), String(row.wx_name).trim())
    }
  }
  const llmAvailable = Boolean((env.LLM_BASE_URL || env.OPENAI_BASE_URL) && (env.LLM_API_KEY || env.OPENAI_API_KEY || env.AI_GATEWAY_API_KEY)) || env.LLM_CODEX_CLI === '1'
  const llmLimitValue = Number(input.config.max_llm_articles ?? 20)
  if (!Number.isSafeInteger(llmLimitValue) || llmLimitValue < 0 || llmLimitValue > 100) { const error = new Error('max_llm_articles 必须是 0 到 100 之间的整数'); error.code = 'INVALID_CONFIG'; throw error }
  const llmWaitingAuth = input.config.enable_llm !== false && !llmAvailable && llmLimitValue > 0 && undecided.length > 0
  let llmRequestCount = 0
  let llmFailures = 0
  let llmReviewedCount = 0
  if (input.config.enable_llm !== false && llmAvailable && llmLimitValue > 0 && undecided.length) {
    const limitedIds = new Set(undecided.slice(0, llmLimitValue).map(row => String(row.article_id)))
    const limitedReport = { ...stage.report, articles: { ...stage.report.articles, decisions: [...finalDecisions.values()].filter(row => !['ACCOUNT_UNDECIDED', 'ACCOUNT_UNMATCHED', 'REVIEW'].includes(row.status) || limitedIds.has(String(row.article_id))) } }
    const limitedReportArtifact = await writeArtifact(input.workdir, 'articles-filter-llm-input.json', limitedReport)
    limitedReportArtifact.artifact_type = 'debug_report'; limitedReportArtifact.schema_version = '1'; limitedReportArtifact.record_count = limitedReport.articles.decisions.length
    const llmResult = await runLlmFilter({ ...input, input_artifacts: [limitedReportArtifact, articleArtifact, baseWriteSetArtifact] })
    llmRequestCount = Number(llmResult.request_count) || 0
    const llmReportRef = (llmResult.debug_artifacts || []).find(ref => ref.artifact_type === 'filter_report' || ref.artifact_type === 'debug_report')
    const llmReport = llmReportRef ? await readArtifact(input.workdir, llmReportRef) : { decisions: [], errors: [] }
    llmFailures = (llmReport.errors || []).length
    llmReviewedCount = (llmReport.decisions || []).length
    for (const row of llmReport.decisions || []) finalDecisions.set(String(row.article_id), row)
  }

  const articleByIdentity = new Map(stage.articles.map(row => [String(row.article_id), row]))
  const pendingStatuses = new Set(['SELECTED', 'ACCOUNT_UNDECIDED', 'ACCOUNT_UNMATCHED', 'REVIEW'])
  const pending = []
  let autoFilteredCount = 0
  let accountNamesFromDatabase = 0
  let pendingWithoutAccountName = 0
  for (const decision of finalDecisions.values()) {
    if (decision.status === 'ACCOUNT_FILTERED') { autoFilteredCount += 1; continue }
    if (!pendingStatuses.has(decision.status)) continue
    const article = articleByIdentity.get(String(decision.article_id))
    if (!article) continue
    const articleKey = String(article.article_key || article.article_id || article.article_url || '')
    const account = accountsByBiz.get(String(article.wx_biz || '')) || accountRowByBiz.get(String(article.wx_biz || '')) || {}
    const sourceAccountName = String(article.wx_name || article.publisher || article.account_name || article.accountName || article.public_name || article.nickname || account.wx_name || '').trim()
    const databaseAccountName = databaseNames.get(String(article.wx_biz || '')) || ''
    const wxName = sourceAccountName || databaseAccountName
    if (!sourceAccountName && databaseAccountName) accountNamesFromDatabase += 1
    if (!wxName) pendingWithoutAccountName += 1
    const relationRows = linksByArticle.get(articleKey) || []
    const matchedHotwords = [...new Set(relationRows.map(row => String(row.hotword || '').trim()).filter(Boolean))].sort()
    const risingHotwords = relationRows.filter(row => hotwordByKey.get(`${String(row.hotword || '')}\0${String(row.stat_date || '').slice(0, 10)}`)?.is_rising === true).map(row => String(row.hotword || '').trim())
    const platforms = [...new Set([...(article.source_refs || []).map(row => row.platform), article.source_platform].filter(Boolean))].sort()
    const sourceSteps = [...new Set([...(article.source_steps || []), ...(article.collect_reasons || []).map(value => String(value).split(':')[0]).filter(value => ['wxrank-free-articles', 'wxrank-strategy', 'redfox-articles', 'hotword-expand'].includes(value))])].sort()
    const llmPass = decision.decision_source === 'llm' && decision.status === 'SELECTED'
    const pendingReason = llmPass ? `LLM 建议保留：${decision.reason || '模型判断适合进入文章库'}；仍需人工审核` : decision.status === 'SELECTED' ? '已通过确定性规则，待人工审核' : decision.reason || '信息不足，待人工审核'
    pending.push({ title: article.title, pub_time: article.publish_time || article.published_at || article.pub_time || null, wx_name: wxName, wx_biz: article.wx_biz || null, article_key: articleKey, read_num: article.read_num ?? null, like_num: article.like_num ?? null, source_platforms: platforms, source_steps: sourceSteps, matched_hotwords: matchedHotwords, rising_hotwords: [...new Set(risingHotwords)], is_rising: risingHotwords.length > 0, filter_stages: ['database_rules', 'account_context', 'hotword_context', ...(decision.decision_source === 'llm' ? ['llm'] : [])], filter_rule_id: decision.filterRuleId || '', decision_source: decision.decision_source || 'rules', decision_status: 0, account_decision_status: account.decision_status ?? null, filter_status: decision.status, pending_reason: wxName ? pendingReason : `${pendingReason}；现有账号数据中无公众号名称`, llm_confidence: decision.llm_confidence ?? null })
  }
  const uniquePending = [...new Map(pending.map(row => [row.article_key, row])).values()]
  const pendingArtifact = await writeArtifact(input.workdir, 'pending-review-articles.json', { rows: uniquePending, generated_at: generatedAt, decision_status: 0 })
  pendingArtifact.artifact_type = 'pending_review_articles'; pendingArtifact.schema_version = '1'; pendingArtifact.record_count = uniquePending.length
  const hotwordSummary = await writeArtifact(input.workdir, 'pending-review-hotword-summary.json', { matched_hotwords: [...new Set(uniquePending.flatMap(row => row.matched_hotwords))], articles_with_hotwords: uniquePending.filter(row => row.matched_hotwords.length).length, articles_with_rising_hotwords: uniquePending.filter(row => row.is_rising).length, generated_at: generatedAt })
  hotwordSummary.artifact_type = 'debug_report'; hotwordSummary.schema_version = '1'; hotwordSummary.record_count = uniquePending.length
  const filteredCount = Math.max(0, merged.rows.length - uniquePending.length)
  const status = merged.invalid.length || llmFailures || llmWaitingAuth ? 'partial' : 'success'
  return { status, input_count: articleRows.length, output_count: uniquePending.length, created_count: 0, updated_count: 0, filtered_count: filteredCount, request_count: stage.filter_rule_request_count + llmRequestCount + accountNameLookupRequests, duration_ms: Date.now() - started, artifact: [pendingArtifact], debug_artifacts: [reportArtifact, hotwordSummary, ...(merged.invalid.length ? [{ ...await writeArtifact(input.workdir, 'pending-review-invalid-articles.json', { rows: merged.invalid }), artifact_type: 'exceptions', schema_version: '1', kind: 'debug', default_visible: false }] : [])], error_code: merged.invalid.length ? 'ARTICLE_IDENTITY_INCOMPLETE' : llmWaitingAuth ? 'LLM_AUTH_MISSING' : undefined, message: llmWaitingAuth ? '待审核清单已生成；缺少 LLM 认证，未决文章保持待人工审核' : '文章确定性过滤与待人工审核集合已生成；候选均未自动通过审核', business_summary: { input_articles: articleRows.length, deduplicated_articles: merged.rows.length, duplicate_articles: merged.duplicate_report.duplicate_count, invalid_articles: merged.invalid.length, deterministic_auto_filtered: autoFilteredCount, llm_input_count: Math.min(undecided.length, llmLimitValue), llm_reviewed: llmReviewedCount, llm_failures: llmFailures, llm_waiting_auth: llmWaitingAuth, account_names_from_database: accountNamesFromDatabase, pending_without_account_name: pendingWithoutAccountName, account_name_lookup_requests: accountNameLookupRequests, pending_review_articles: uniquePending.length, articles_with_hotwords: uniquePending.filter(row => row.matched_hotwords.length).length, articles_with_rising_hotwords: uniquePending.filter(row => row.is_rising).length, next_step: '人工审核 pending_review_articles 产物' } }
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
  if (input.config.final_pending_review === true) return collectPendingReview(input, dependencies, effectiveAccounts, accountRows, articleRows, accountDecisions, started)
  const stage = await runArticleFilterStage({ input, accountRows: effectiveAccounts, articleRows, source: 'collector', databaseName: input.config.database_name || 'articles-filter.sqlite', accountDecisions })
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

  const reportArtifact = await writeArtifact(input.workdir, input.config.report_output_name || 'articles-filter-report.json', stage.report)
  reportArtifact.artifact_type = 'debug_report'; reportArtifact.schema_version = '1'; reportArtifact.record_count = articleRows.length
  reportArtifact.kind = 'debug'; reportArtifact.default_visible = false
  const filteredArtifact = await writeArtifact(input.workdir, input.config.filtered_output_name || 'filtered-articles.json', { run_date: stage.report.runDate, rows: stage.filteredArticles, generated_at: generatedAt })
  filteredArtifact.artifact_type = 'filtered_articles'; filteredArtifact.schema_version = '1'; filteredArtifact.record_count = stage.filteredArticles.length
  const hotwordsArtifact = await writeArtifact(input.workdir, input.config.hotwords_output_name || 'articles-filter-hotwords.json', {
    rows: hotwordStage.rows,
    publish_date_groups: hotwordStage.publishDateGroups,
    without_publish_date: datedArticles.withoutPublishDate,
    filter_summary: hotwordStage.filterSummary,
    generated_at: generatedAt
  })
  hotwordsArtifact.artifact_type = 'hotwords'; hotwordsArtifact.schema_version = '1'; hotwordsArtifact.record_count = hotwordStage.rows.length
  const writeSetArtifact = await writeArtifact(input.workdir, input.config.write_set_output_name || 'write-set.json', stage.writeSet)
  writeSetArtifact.artifact_type = 'write_set'; writeSetArtifact.schema_version = '1'; writeSetArtifact.record_count = (stage.writeSet.articles?.length || 0) + (stage.writeSet.accounts?.length || 0) + (stage.writeSet.hotwords?.length || 0)
  const selected = stage.filteredArticles.length
  const filtered = articleRows.length - selected
  return { status: 'success', input_count: articleRows.length, output_count: selected, created_count: stage.report.accounts.created, updated_count: stage.report.accounts.updated, filtered_count: filtered, request_count: stage.filter_rule_request_count + loadedHotwordRules.request_count, duration_ms: Date.now() - started, artifact: [filteredArtifact, hotwordsArtifact, writeSetArtifact], debug_artifacts: [reportArtifact], business_summary: { input_articles: articleRows.length, selected, filtered, updated_accounts: stage.accounts.length, write_set_records: writeSetArtifact.record_count, hotwords: hotwordStage.rows.length, publish_date_groups: hotwordStage.publishDateGroups.length, articles_without_publish_date: datedArticles.withoutPublishDate, hotword_filter_rules: loadedHotwordRules.rules.length, filter_rules: stage.report.filterRules }, message: 'article filter and publish-date hotword extraction completed' }
}

if (import.meta.main) runCollectorMain(collect)

export { collect }
