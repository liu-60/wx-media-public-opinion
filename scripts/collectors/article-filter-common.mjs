import path from 'node:path'
import { openDatabase } from '../../src/db.mjs'
import { createRuleSnapshot } from '../../src/article-filter.mjs'
import { normalizeArticle, runPipeline } from '../../src/pipeline.mjs'
import { buildSupabaseWriteSet } from '../../src/supabase-sink.mjs'
import { readArtifact } from '../../src/runner/script-runtime.mjs'
import { loadFilterRuleSnapshot } from './filter-rules.mjs'

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim()
}

function first(row, ...keys) {
  for (const key of keys) {
    if (row && typeof row === 'object' && row[key] !== undefined && row[key] !== null && text(row[key])) return row[key]
  }
  return undefined
}

function businessId(row) {
  const explicit = first(row, 'wx_biz', 'wxBiz', '__biz', 'biz')
  if (explicit) return text(explicit)
  const url = first(row, 'article_url', 'articleUrl', 'art_url', 'url', 'link')
  try { return text(new URL(text(url)).searchParams.get('__biz')) } catch { return '' }
}

export function accountRowsFromArticles(rows = [], { source = 'collector' } = {}) {
  const accounts = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const nested = row?.account && typeof row.account === 'object' ? row.account : row?.official_account && typeof row.official_account === 'object' ? row.official_account : {}
    const wxBiz = businessId(row) || businessId(nested)
    if (!wxBiz) continue
    const value = {
      wx_biz: wxBiz,
      wx_name: text(first(row, 'wx_name', 'wxName', 'account_name', 'accountName', 'public_name', 'nickname', 'publisher') || first(nested, 'wx_name', 'wxName', 'account_name', 'name')),
      verify: text(first(row, 'verify', 'verification', 'certification', 'certification_subject') || first(nested, 'verify', 'verification', 'certification')),
      description: text(first(row, 'description', 'introduction', 'summary') || first(nested, 'description', 'introduction', 'summary')),
      read_median: first(row, 'read_median', 'readMedian') ?? first(nested, 'read_median', 'readMedian'),
      read_max: first(row, 'read_max', 'readMax') ?? first(nested, 'read_max', 'readMax'),
      wx_user: first(row, 'wx_user', 'wxUser') ?? first(nested, 'wx_user', 'wxUser'),
      avatar: first(row, 'avatar') ?? first(nested, 'avatar'),
      wx_type: first(row, 'wx_type', 'wxType', 'account_type') ?? first(nested, 'wx_type', 'wxType'),
      region: first(row, 'region') ?? first(nested, 'region'),
      source,
      raw: nested === row ? row : { ...nested, article_source: row }
    }
    const previous = accounts.get(wxBiz)
    if (!previous) accounts.set(wxBiz, value)
    else for (const [key, field] of Object.entries(value)) {
      if ((previous[key] === undefined || previous[key] === null || previous[key] === '') && field !== undefined && field !== null && field !== '') previous[key] = field
    }
  }
  return [...accounts.values()]
}

export async function resolveArticleRuleSnapshot(input, { loader = loadFilterRuleSnapshot } = {}) {
  if (input?.rule_snapshot_ref) {
    const supplied = await readArtifact(input.workdir, input.rule_snapshot_ref)
    if (Array.isArray(supplied?.rules)) {
      return {
        snapshot: createRuleSnapshot(supplied.rules, {
          source: supplied.source || 'run_snapshot',
          loadedAt: supplied.loadedAt || supplied.loaded_at || new Date().toISOString()
        }),
        request_count: 0
      }
    }
  }
  return loader()
}

export async function runArticleFilterStage({
  input,
  accountRows = [],
  articleRows = [],
  source = 'collector',
  databaseName = 'article-filter.sqlite',
  now = new Date().toISOString(),
  ruleSnapshot,
  accountDecisions,
  loadRules
} = {}) {
  if (!input?.workdir) throw new TypeError('collector workdir is required')
  if (!Array.isArray(accountRows) || !Array.isArray(articleRows)) throw new TypeError('accountRows and articleRows must be arrays')
  const resolved = ruleSnapshot
    ? { snapshot: createRuleSnapshot(ruleSnapshot.rules || [], { source: ruleSnapshot.source || 'run_snapshot', loadedAt: ruleSnapshot.loadedAt || now }), request_count: 0 }
    : await resolveArticleRuleSnapshot(input, { loader: loadRules || loadFilterRuleSnapshot })
  const db = openDatabase(path.join(input.workdir, databaseName))
  try {
    const report = runPipeline({
      db,
      accountRows,
      articleRows,
      runDate: input.config.run_date || input.config.target_date || '',
      now,
      source,
      ruleSnapshot: resolved.snapshot,
      accountDecisions,
      persistHotwordsStage: false,
      includeHotwordRows: false
    })
    const updatedAccounts = db.prepare(`SELECT a.account_id, a.wx_biz, a.wx_name, a.verify, a.description, a.read_median, a.read_max, a.status, a.source, a.created_at, a.updated_at, a.last_sync_at,
      p.wx_user, p.avatar, p.wx_type, p.region, p.tags_json, p.last_pub_time, p.stat_date, p.pub_count, p.active_days, p.read_avg, p.read_median AS profile_read_median, p.read_max AS profile_read_max, p.wci_index
      FROM accounts a LEFT JOIN account_profiles p ON p.account_id = a.account_id ORDER BY a.wx_biz`).all()
    const decisions = new Map((report.articles?.decisions || []).map(row => [row.article_id, row]))
    const normalizedArticles = articleRows.map(normalizeArticle)
    const selectedArticles = normalizedArticles.flatMap(article => {
      const decision = decisions.get(article.article_id)
      return decision?.status === 'SELECTED'
        ? [{ ...article, account_id: decision.account_id || null, filter_status: decision.status, filter_rule_id: decision.filterRuleId || '', filter_reason: decision.reason || '', decision_source: decision.decision_source || 'rules' }]
        : []
    })
    const writeSet = buildSupabaseWriteSet({ accountRows: updatedAccounts, articleRows, report, runDate: report.runDate, now, source })
    return {
      report,
      accounts: updatedAccounts,
      articles: normalizedArticles,
      filteredArticles: selectedArticles,
      writeSet,
      filter_rule_snapshot: resolved.snapshot,
      filter_rule_request_count: resolved.request_count
    }
  } finally {
    db.close()
  }
}
