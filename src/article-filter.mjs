import configFile from '../config/default.json' with { type: 'json' }

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
  if (median !== null && median !== undefined && median !== '') {
    const numericMedian = Number(median)
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

export function coarseFilterArticle(article = {}, account, config = DEFAULT_FILTER_CONFIG) {
  if (!account) {
    return {
      status: 'ACCOUNT_UNMATCHED',
      filterRuleId: '',
      reason: 'wx_biz has no matching account; manual review required',
      accountMatched: false,
      reasons: []
    }
  }
  const evaluated = evaluateAccountRules(account, config)
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
  return { status: 'SELECTED', filterRuleId: '', reason: '', accountMatched: true, reasons: [] }
}

export function persistFilterAudit(db, articleId, accountId, result, now) {
  if (!result || result.status === 'SELECTED') return 0
  const reasons = result.reasons?.length ? result.reasons : [{ ruleId: result.filterRuleId, field: '', matchedValue: '', reason: result.reason }]
  const statement = db.prepare(`INSERT INTO article_filter_audit(article_id,account_id,rule_id,field,matched_value,reason,created_at)
    VALUES(?,?,?,?,?,?,?)`)
  for (const item of reasons) statement.run(articleId, accountId || '', item.ruleId || '', item.field || '', String(item.matchedValue ?? ''), item.reason || result.reason || '', now)
  return reasons.length
}

