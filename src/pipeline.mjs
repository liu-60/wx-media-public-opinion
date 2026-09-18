import crypto from 'node:crypto'
import configFile from '../config/default.json' with { type: 'json' }
import { nowIso } from './db.mjs'
import { syncAccounts, timestampToIso } from './account-sync.mjs'
import { ensureArticleAccount } from './account-collection.mjs'
import { coarseFilterArticle, persistFilterAudit, DEFAULT_FILTER_CONFIG } from './article-filter.mjs'
import { aggregateHotwords, persistHotwords } from './hotwords.mjs'
import { fetchAccountSources } from './wxrank-client.mjs'

function text(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function first(row, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined && row[key] !== null) return row[key]
  }
  return undefined
}

function json(value) {
  try { return JSON.stringify(value) } catch { return '{}' }
}

function integer(value) {
  if (value === undefined || value === null || value === '') return 0
  const parsed = Number(String(value).replaceAll(',', ''))
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0
}

function publishTime(value) {
  if (value === undefined || value === null || value === '') return ''
  if (/^\d{10,13}$/u.test(String(value).trim())) return timestampToIso(value) || ''
  return String(value).trim()
}

function dateKey(value, fallback) {
  const source = text(value || fallback).replaceAll('-', '')
  if (/^20\d{6}/u.test(source)) return source.slice(0, 8)
  const date = new Date(value || fallback)
  return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10).replaceAll('-', '') : date.toISOString().slice(0, 10).replaceAll('-', '')
}

function articleId(article, normalized) {
  const explicit = text(first(article, 'article_id', 'articleId', 'art_id', 'id'))
  if (explicit) return explicit
  const seed = [normalized.article_url, normalized.title, normalized.publish_time, normalized.wx_biz].join('\n')
  return `article_${crypto.createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 24)}`
}

function normalizeArticle(article = {}) {
  const wxBiz = text(first(article, 'wx_biz', 'wxBiz', '__biz', 'biz'))
  const title = text(first(article, 'title', 'article_title', 'art_title', 'name'))
  const content = text(first(article, 'content', 'body', 'article_content', 'text'))
  const articleUrl = text(first(article, 'article_url', 'articleUrl', 'art_url', 'url', 'link'))
  const publish = publishTime(first(article, 'publish_time', 'publishTime', 'pub_time', 'publish_date', 'created_at', 'date'))
  return {
    ...article,
    article_id: articleId(article, { article_url: articleUrl, title, publish_time: publish, wx_biz: wxBiz }),
    article_url: articleUrl,
    title,
    content,
    publish_time: publish,
    wx_biz: wxBiz || null,
    publisher: text(first(article, 'publisher', 'wx_name', 'wxName', 'account_name', 'name')),
    read_num: integer(first(article, 'read_num', 'readNum', 'read')),
    like_num: integer(first(article, 'like_num', 'likeNum', 'like')),
    look_num: integer(first(article, 'look_num', 'lookNum', 'look')),
    share_num: integer(first(article, 'share_num', 'shareNum', 'share'))
  }
}

function readAccount(db, wxBiz) {
  if (!wxBiz) return null
  return db.prepare('SELECT * FROM accounts WHERE wx_biz=? LIMIT 1').get(wxBiz) || null
}

function persistArticle(db, article, account, decision, source, now) {
  const rawJson = json(article)
  db.prepare(`INSERT INTO articles(
    article_id,article_url,title,content,publish_time,wx_biz,account_id,publisher,read_num,like_num,look_num,share_num,
    source,status,filter_rule_id,filter_reason,raw_json,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(article_id) DO UPDATE SET
    article_url=excluded.article_url,title=excluded.title,content=excluded.content,publish_time=excluded.publish_time,
    wx_biz=excluded.wx_biz,account_id=excluded.account_id,publisher=excluded.publisher,read_num=excluded.read_num,
    like_num=excluded.like_num,look_num=excluded.look_num,share_num=excluded.share_num,source=excluded.source,
    status=excluded.status,filter_rule_id=excluded.filter_rule_id,filter_reason=excluded.filter_reason,
    raw_json=excluded.raw_json,updated_at=excluded.updated_at`).run(
    article.article_id, article.article_url, article.title, article.content, article.publish_time, article.wx_biz,
    account?.account_id || null, article.publisher || account?.wx_name || '', article.read_num, article.like_num,
    article.look_num, article.share_num, source, decision.status, decision.filterRuleId, decision.reason, rawJson, now, now
  )
  db.prepare('DELETE FROM article_filter_audit WHERE article_id=?').run(article.article_id)
  persistFilterAudit(db, article.article_id, account?.account_id || null, decision, now)
}

export function runPipeline({
  db,
  accountRows = [],
  articleRows = [],
  runDate = '',
  now = nowIso(),
  source = 'wxrank',
  ruleConfig = DEFAULT_FILTER_CONFIG,
  hotwordConfig = configFile.hotword || {}
} = {}) {
  if (!db) throw new TypeError('db is required')
  const statDate = dateKey(runDate, now)
  const accountSummary = syncAccounts(db, accountRows, {
    source,
    collectedAt: now,
    now,
    runId: `pipeline-${statDate}`
  })
  const decisions = []
  const normalizedArticles = []
  let newAccountsFromArticles = 0
  db.exec('BEGIN')
  try {
    for (const sourceArticle of articleRows) {
      const article = normalizeArticle(sourceArticle)
      let account = readAccount(db, article.wx_biz)
      if (!account && article.wx_biz) {
        const result = ensureArticleAccount(db, { ...article, wx_name: article.publisher }, { now, source: 'article' })
        newAccountsFromArticles += result.created ? 1 : 0
        account = readAccount(db, article.wx_biz)
      }
      const decision = coarseFilterArticle(article, account, ruleConfig)
      persistArticle(db, article, account, decision, source, now)
      const record = {
        article_id: article.article_id,
        title: article.title,
        wx_biz: article.wx_biz,
        account_id: account?.account_id || null,
        status: decision.status,
        filterRuleId: decision.filterRuleId,
        reason: decision.reason,
        accountMatched: decision.accountMatched
      }
      decisions.push(record)
      normalizedArticles.push({ ...article, account_id: account?.account_id || null })
    }
    const hotwordRows = aggregateHotwords(normalizedArticles, {
      ...hotwordConfig,
      statDate,
      now
    })
    persistHotwords(db, hotwordRows, { now })
    db.exec('COMMIT')
    const statusCounts = Object.fromEntries([...new Set(decisions.map(item => item.status))].map(status => [status, decisions.filter(item => item.status === status).length]))
    return {
      runDate: statDate,
      accounts: accountSummary,
      articles: {
        rawCount: decisions.length,
        newAccountsFromArticles,
        statusCounts,
        decisions
      },
      hotwords: { count: hotwordRows.length, rows: hotwordRows }
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
