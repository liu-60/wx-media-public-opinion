import configFile from '../config/default.json' with { type: 'json' }
import { nowIso } from './db.mjs'
import { createRuleSnapshot, DEFAULT_FILTER_CONFIG } from './article-filter.mjs'
import { fetchAccountSources } from './wxrank-client.mjs'
import { createPipelineStages, normalizeArticle } from './pipeline-stages.mjs'

function text(value) { return value === undefined || value === null ? '' : String(value).trim() }

function dateKey(value, fallback) {
  const source = text(value || fallback).replaceAll('-', '')
  if (/^20\d{6}/u.test(source)) return source.slice(0, 8)
  const date = new Date(value || fallback)
  return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10).replaceAll('-', '') : date.toISOString().slice(0, 10).replaceAll('-', '')
}

export function runPipeline({
  db,
  accountRows = [],
  articleRows = [],
  runDate = '',
  now = nowIso(),
  source = 'wxrank',
  ruleConfig = DEFAULT_FILTER_CONFIG,
  ruleSnapshot = undefined,
  accountDecisions = undefined,
  persistedRules = undefined,
  ruleSource = 'default',
  ruleLoadedAt = now,
  hotwordConfig = configFile.hotword || {},
  persistHotwordsStage = true,
  includeHotwordRows = true
} = {}) {
  if (!db) throw new TypeError('db is required')
  if (ruleSnapshot !== undefined && (!ruleSnapshot || !Array.isArray(ruleSnapshot.rules))) throw new TypeError('ruleSnapshot.rules must be an array')
  const suppliedRules = ruleSnapshot?.rules ?? persistedRules
  const snapshot = createRuleSnapshot(suppliedRules ?? [], {
    source: ruleSnapshot?.source || (suppliedRules === undefined ? 'default' : ruleSource),
    loadedAt: ruleSnapshot?.loadedAt || ruleLoadedAt
  })
  const activeRules = suppliedRules === undefined ? undefined : snapshot.rules
  const statDate = dateKey(runDate, now)
  const stages = createPipelineStages({ db, now, source, ruleConfig, activeRules, accountDecisions, hotwordConfig, statDate })
  const accountSummary = stages.syncAccounts(accountRows)
  const decisions = []
  const normalizedArticles = []
  let newAccountsFromArticles = 0
  db.exec('BEGIN')
  try {
    for (const sourceArticle of articleRows) {
      const article = stages.normalizeArticle(sourceArticle)
      let account = stages.readAccount(article.wx_biz)
      if (!account && article.wx_biz) {
        const result = stages.ensureArticleAccount({ ...article, wx_name: article.publisher })
        newAccountsFromArticles += result.created ? 1 : 0
        account = stages.readAccount(article.wx_biz)
      }
      const accountWithDecision = stages.accountWithDecision(account)
      const decision = stages.filterArticle(article, accountWithDecision)
      stages.persistArticle(article, account, decision)
      const record = {
        article_id: article.article_id,
        title: article.title,
        wx_biz: article.wx_biz,
        account_id: accountWithDecision?.account_id || null,
        status: decision.status,
        filterRuleId: decision.filterRuleId,
        reason: decision.reason,
        decision_source: decision.decisionSource || (decision.status === 'SELECTED' ? 'rules' : 'rules'),
        accountMatched: decision.accountMatched
      }
      decisions.push(record)
      normalizedArticles.push({ ...article, account_id: accountWithDecision?.account_id || null })
    }
    // Article-only filter runs explicitly disable both hotword persistence and
    // hotword output. Avoid building the expensive n-gram aggregation in that
    // mode; regular pipeline runs retain the existing hotword behavior.
    const hotwordRows = persistHotwordsStage || includeHotwordRows
      ? stages.collectHotwords(normalizedArticles)
      : []
    if (persistHotwordsStage) stages.persistHotwords(hotwordRows)
    db.exec('COMMIT')
    const statusCounts = Object.fromEntries([...new Set(decisions.map(item => item.status))].map(status => [status, decisions.filter(item => item.status === status).length]))
    return {
      runDate: statDate,
      filterRules: {
        source: snapshot.source,
        loadedAt: snapshot.loadedAt,
        count: snapshot.count,
        hash: snapshot.hash
      },
      accounts: accountSummary,
      articles: {
        rawCount: decisions.length,
        newAccountsFromArticles,
        statusCounts,
        decisions
      },
      hotwords: { count: hotwordRows.length, rows: includeHotwordRows ? hotwordRows : [] }
    }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export async function runPipelineFromWxRank({ db, articleRows = [], fetchOptions = {}, ...options } = {}) {
  const accountSources = await fetchAccountSources(fetchOptions)
  return runPipeline({ ...options, db, accountRows: accountSources.rows, articleRows, source: options.source || 'wxrank' })
}

export { normalizeArticle }
