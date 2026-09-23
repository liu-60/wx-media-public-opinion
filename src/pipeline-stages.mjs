import configFile from '../config/default.json' with { type: 'json' }
import { nowIso } from './db.mjs'
import { syncAccounts, timestampToIso } from './account-sync.mjs'
import { ensureArticleAccount } from './account-collection.mjs'
import { articleIdentity, coarseFilterArticle, persistFilterAudit, DEFAULT_FILTER_CONFIG } from './article-filter.mjs'
import { aggregateHotwords, persistHotwords } from './hotwords.mjs'

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

function articleId(article, normalized) {
  return articleIdentity({ ...article, ...normalized }).articleId
}

export function normalizeArticle(article = {}) {
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
    share_num: integer(first(article, 'share_num', 'shareNum', 'share')),
    comment_num: integer(first(article, 'comment_num', 'commentNum', 'comment', 'comment_count'))
  }
}

function decisionForAccount(account, accountDecisions) {
  if (!account || accountDecisions === undefined) return account
  const keys = [account.account_id, account.wx_biz].filter(Boolean)
  let value
  if (accountDecisions instanceof Map) value = keys.map(key => accountDecisions.get(key)).find(item => item !== undefined)
  else value = keys.map(key => accountDecisions[key]).find(item => item !== undefined)
  return {
    ...account,
    decision_status: value && typeof value === 'object' ? value.decision_status : value,
    decision_required: true
  }
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

export function createPipelineStages({ db, now = nowIso(), source = 'wxrank', ruleConfig = DEFAULT_FILTER_CONFIG, activeRules = undefined, accountDecisions = undefined, hotwordConfig = configFile.hotword || {}, statDate = '' } = {}) {
  if (!db) throw new TypeError('db is required')
  return Object.freeze({
    syncAccounts: rows => syncAccounts(db, rows, { source, collectedAt: now, now, runId: `pipeline-${statDate}` }),
    normalizeArticle,
    readAccount: wxBiz => wxBiz ? db.prepare('SELECT * FROM accounts WHERE wx_biz=? LIMIT 1').get(wxBiz) || null : null,
    ensureArticleAccount: article => ensureArticleAccount(db, article, { now, source: 'article' }),
    accountWithDecision: account => decisionForAccount(account, accountDecisions),
    filterArticle: (article, account) => coarseFilterArticle(article, account, ruleConfig, activeRules),
    persistArticle: (article, account, decision) => persistArticle(db, article, account, decision, source, now),
    collectHotwords: articles => aggregateHotwords(articles, {
      ...hotwordConfig,
      mergeConsistencyThreshold: hotwordConfig.mergeConsistencyThreshold ?? hotwordConfig.merge_consistency_threshold ?? 0.8,
      mergeMinArticleCount: hotwordConfig.mergeMinArticleCount ?? hotwordConfig.merge_min_article_count ?? 3,
      statDate,
      now,
      filterRules: (activeRules || []).filter(rule => rule.scope === 'hotword' && rule.field_name === 'hotword')
    }),
    persistHotwords: rows => persistHotwords(db, rows, { now })
  })
}

export { decisionForAccount, persistArticle }
