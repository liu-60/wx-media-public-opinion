import configFile from '../config/default.json' with { type: 'json' }
import crypto from 'node:crypto'

const configured = configFile.account || configFile

export const DEFAULT_FILTER_CONFIG = Object.freeze({
  ...configured,
  verifyRuleId: configured.verifyRuleId || 'verify_institution',
  nameRuleId: configured.nameRuleId || '81',
  nameAcademicRuleId: configured.nameAcademicRuleId || '82',
  readMedianFilterRuleId: configured.readMedianFilterRuleId || '105'
})

function text(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function findTerm(value, terms = []) {
  const source = text(value)
  return terms.find(term => source.includes(text(term))) || ''
}

function firstValue(row, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row || {}, key) && row[key] !== undefined && row[key] !== null && text(row[key])) return row[key]
  }
  return ''
}

function articleSnFromUrl(value) {
  try { return text(new URL(text(value)).searchParams.get('sn')) } catch { return '' }
}

export function articleIdentity(row = {}) {
  const explicit = text(firstValue(row, 'article_id', 'articleId', 'art_id', 'id', 'article_sn', 'articleSn'))
  if (explicit) return { articleId: explicit, articleSn: explicit, source: 'explicit' }
  const url = text(firstValue(row, 'article_url', 'articleUrl', 'art_url', 'url', 'link'))
  const urlSn = articleSnFromUrl(url)
  if (urlSn) return { articleId: urlSn, articleSn: urlSn, source: 'url_sn' }
  const seed = [
    url,
    text(firstValue(row, 'title', 'article_title', 'art_title', 'name')),
    text(firstValue(row, 'publish_time', 'publishTime', 'pub_time', 'publish_date', 'published_at', 'created_at', 'date')),
    text(firstValue(row, 'wx_biz', 'wxBiz', '__biz', 'biz'))
  ].join('\n')
  const fallback = `article_${crypto.createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 24)}`
  return { articleId: fallback, articleSn: fallback, source: 'fallback' }
}

const RULE_FIELDS = Object.freeze({
  account: new Set(['name', 'verification', 'description', 'read_median']),
  article: new Set(['title', 'read_count', 'like_count', 'comment_count']),
  hotword: new Set(['hotword'])
})
const RULE_OPERATORS = Object.freeze({
  account: new Set(['eq', 'contains', 'not_contains', 'gt', 'gte', 'lt', 'lte']),
  article: new Set(['eq', 'contains', 'not_contains', 'gt', 'gte', 'lt', 'lte']),
  hotword: new Set(['exact', 'contains'])
})

function fieldValue(row, scope, field) {
  if (scope === 'account') return {
    name: firstValue(row, 'wx_name', 'name'),
    verification: firstValue(row, 'verify', 'verification'),
    description: firstValue(row, 'description'),
    read_median: firstValue(row, 'read_median')
  }[field]
  return {
    title: firstValue(row, 'title'),
    read_count: firstValue(row, 'read_num', 'readNum', 'read_count'),
    like_count: firstValue(row, 'like_num', 'likeNum', 'like_count'),
    comment_count: firstValue(row, 'comment_num', 'commentNum', 'comment', 'comment_count')
  }[field]
}

function numeric(value) {
  const source = text(value)
  if (!source) return null
  const parsed = Number(source.replaceAll(',', ''))
  return Number.isFinite(parsed) ? parsed : null
}

function ruleMatch(value, rule) {
  const operator = text(rule.operator)
  const source = text(value)
  if (!source) return false
  if (operator === 'contains' || operator === 'not_contains') {
    const matched = source.includes(text(rule.value_text))
    return operator === 'not_contains' ? !matched : matched
  }
  if ((operator === 'eq' || operator === 'exact') && rule.value_text !== null && rule.value_text !== undefined) return source === text(rule.value_text)
  const left = numeric(value)
  const right = numeric(rule.value_number)
  if (left === null || right === null) return false
  return ({ eq: left === right, gt: left > right, gte: left >= right, lt: left < right, lte: left <= right })[operator] || false
}

export function normalizePersistedRules(rows = []) {
  if (!Array.isArray(rows)) throw new TypeError('persisted rules must be an array')
  return rows.map(row => {
    const id = row?.id ?? row?.rule_id
    const scope = text(row?.scope)
    const field_name = text(row?.field_name)
    const operator = text(row?.operator)
    if (id === undefined || id === null || text(id) === '') throw new TypeError('persisted rule id is required')
    if (!RULE_FIELDS[scope]?.has(field_name)) throw new TypeError(`unsupported persisted rule field: ${scope}.${field_name}`)
    if (!RULE_OPERATORS[scope]?.has(operator)) throw new TypeError(`unsupported persisted rule operator: ${operator}`)
    const value_text = row.value_text ?? null
    const value_number = row.value_number ?? null
    if ((operator === 'contains' || operator === 'not_contains') && !text(value_text)) throw new TypeError(`persisted rule ${id} requires value_text`)
    if (scope === 'hotword' && (value_number !== null || !text(value_text))) throw new TypeError(`persisted hotword rule ${id} requires value_text`)
    if (!['contains', 'not_contains', 'exact'].includes(operator) && value_text === null && numeric(value_number) === null) throw new TypeError(`persisted rule ${id} requires a value`)
    return { id, scope, field_name, operator, value_text, value_number, enabled: row.enabled !== false }
  }).sort((left, right) => String(left.id).localeCompare(String(right.id), 'en', { numeric: true }))
}

export function evaluatePersistedRules(account = {}, article = {}, rules = []) {
  const reasons = []
  for (const rule of normalizePersistedRules(rules)) {
    if (!rule.enabled || rule.scope === 'hotword') continue
    const target = rule.scope === 'account' ? account : article
    const matchedValue = fieldValue(target, rule.scope, rule.field_name)
    if (!ruleMatch(matchedValue, rule)) continue
    reasons.push({
      ruleId: rule.id,
      field: `${rule.scope}.${rule.field_name}`,
      matchedValue,
      reason: `${rule.scope}.${rule.field_name} ${rule.operator} configured value`
    })
  }
  return { filtered: reasons.length > 0, ruleId: reasons[0]?.ruleId || '', reasons }
}

export function createRuleSnapshot(rules = [], { source = 'default', loadedAt = new Date().toISOString() } = {}) {
  const normalized = normalizePersistedRules(rules)
  const canonical = JSON.stringify(normalized)
  return {
    source,
    loadedAt,
    count: normalized.length,
    hash: crypto.createHash('sha256').update(canonical, 'utf8').digest('hex'),
    rules: normalized
  }
}

export function evaluateAccountRules(account, config = DEFAULT_FILTER_CONFIG) {
  if (!account) return { filtered: false, ruleId: '', reasons: [] }
  const reasons = []
  const verifyTerm = findTerm(account.verify, config.verifyTerms)
  if (verifyTerm) reasons.push({
    ruleId: config.verifyRuleId,
    field: 'verify',
    matchedValue: verifyTerm,
    reason: `verify contains institution term: ${verifyTerm}`
  })

  const academicTerm = findTerm(account.wx_name, config.nameAcademicTerms)
  if (academicTerm) reasons.push({
    ruleId: config.nameAcademicRuleId,
    field: 'wx_name',
    matchedValue: academicTerm,
    reason: `wx_name contains academic/institution term: ${academicTerm}`
  })
  const nameTerm = findTerm(account.wx_name, config.nameTerms)
  if (nameTerm && !academicTerm) reasons.push({
    ruleId: config.nameRuleId,
    field: 'wx_name',
    matchedValue: nameTerm,
    reason: `wx_name contains configured name term: ${nameTerm}`
  })

  const median = account.read_median
  if (text(median)) {
    const numericMedian = Number(String(median).replaceAll(',', ''))
    if (Number.isFinite(numericMedian) && numericMedian < Number(config.readMedianFilterFloor)) reasons.push({
      ruleId: config.readMedianFilterRuleId,
      field: 'read_median',
      matchedValue: numericMedian,
      reason: `read_median < ${config.readMedianFilterFloor}`
    })
  }
  return {
    filtered: reasons.length > 0,
    ruleId: reasons[0]?.ruleId || '',
    reasons
  }
}

export function coarseFilterArticle(article = {}, account, config = DEFAULT_FILTER_CONFIG, persistedRules = undefined) {
  if (!account) {
    return {
      status: 'ACCOUNT_UNMATCHED',
      filterRuleId: '',
      reason: 'wx_biz has no matching account; manual review required',
      accountMatched: false,
      reasons: []
    }
  }
  if (Number(account.decision_status) === 2) {
    return {
      status: 'ACCOUNT_FILTERED',
      filterRuleId: '',
      reason: 'decision status=2 filters this account',
      accountMatched: true,
      reasons: [{ ruleId: '', field: 'decision_status', matchedValue: 2, reason: 'decision status=2 filters this account' }]
    }
  }
  if (account.decision_required && Number(account.decision_status) !== 1) {
    return {
      status: 'ACCOUNT_UNDECIDED',
      filterRuleId: '',
      reason: 'account decision is missing or not approved',
      accountMatched: true,
      reasons: [{ ruleId: '', field: 'decision_status', matchedValue: account.decision_status ?? null, reason: 'account decision is missing or not approved' }]
    }
  }
  if (persistedRules !== undefined) {
    const persisted = evaluatePersistedRules(account, article, persistedRules)
    if (persisted.filtered) {
      return {
        status: 'ACCOUNT_FILTERED',
        filterRuleId: persisted.ruleId,
        reason: persisted.reasons.map(item => `${item.ruleId}:${item.reason}`).join('; '),
        accountMatched: true,
        reasons: persisted.reasons
      }
    }
  }
  const evaluated = persistedRules === undefined ? evaluateAccountRules(account, config) : { filtered: false, ruleId: '', reasons: [] }
  if (evaluated.filtered) {
    return {
      status: 'ACCOUNT_FILTERED',
      filterRuleId: evaluated.ruleId,
      reason: evaluated.reasons.map(item => `${item.ruleId}:${item.reason}`).join('; '),
      accountMatched: true,
      reasons: evaluated.reasons
    }
  }
  if (!text(article.title) && !text(article.article_url)) {
    return {
      status: 'REVIEW',
      filterRuleId: '',
      reason: 'article title and URL are both empty',
      accountMatched: true,
      reasons: []
    }
  }
  return {
    status: 'SELECTED',
    filterRuleId: '',
    reason: account.decision_required && Number(account.decision_status) === 1 ? 'trusted_account' : '',
    decisionSource: account.decision_required && Number(account.decision_status) === 1 ? 'trusted_account' : 'rules',
    accountMatched: true,
    reasons: []
  }
}

export function persistFilterAudit(db, articleId, accountId, result, now) {
  if (!result || result.status === 'SELECTED') return 0
  const reasons = result.reasons?.length ? result.reasons : [{ ruleId: result.filterRuleId, field: '', matchedValue: '', reason: result.reason }]
  const statement = db.prepare(`INSERT INTO article_filter_audit(article_id,account_id,rule_id,field,matched_value,reason,created_at)
    VALUES(?,?,?,?,?,?,?)`)
  for (const item of reasons) statement.run(articleId, accountId || '', item.ruleId || '', item.field || '', String(item.matchedValue ?? ''), item.reason || result.reason || '', now)
  return reasons.length
}

