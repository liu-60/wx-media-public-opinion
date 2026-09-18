import assert from 'node:assert/strict'
import test from 'node:test'
import { coarseFilterArticle, DEFAULT_FILTER_CONFIG, evaluateAccountRules } from '../src/article-filter.mjs'

test('null read_median skips rule 105 but an explicit value below 50000 matches it', () => {
  const base = { wx_name: '普通账号', verify: '个人' }
  assert.equal(evaluateAccountRules({ ...base, read_median: null }, DEFAULT_FILTER_CONFIG).filtered, false)
  assert.equal(evaluateAccountRules({ ...base, read_median: 49999 }, DEFAULT_FILTER_CONFIG).ruleId, '105')
  assert.equal(evaluateAccountRules({ ...base, read_median: 0 }, DEFAULT_FILTER_CONFIG).ruleId, '105')
})

test('name rule 82 can filter an account even when read_median is null', () => {
  const result = evaluateAccountRules({ wx_name: '广东财经大学', verify: '个人', read_median: null }, DEFAULT_FILTER_CONFIG)
  assert.equal(result.filtered, true)
  assert.equal(result.ruleId, '82')
  assert.ok(result.reasons.some(reason => reason.field === 'wx_name' && reason.ruleId === '82'))
})

test('identity rules stay field-scoped and missing accounts remain manual review', () => {
  const descriptionOnly = evaluateAccountRules({ wx_name: '普通账号', verify: '个人', description: '市政府宣传内容' }, DEFAULT_FILTER_CONFIG)
  assert.equal(descriptionOnly.filtered, false)
  const verifyMatch = evaluateAccountRules({ wx_name: '普通账号', verify: '某市融媒体中心', description: '普通简介' }, DEFAULT_FILTER_CONFIG)
  assert.equal(verifyMatch.filtered, true)
  assert.equal(verifyMatch.reasons[0].field, 'verify')

  const missing = coarseFilterArticle({ article_id: 'a1', title: '待核验文章' }, null, DEFAULT_FILTER_CONFIG)
  assert.equal(missing.status, 'ACCOUNT_UNMATCHED')
  assert.equal(missing.accountMatched, false)
  assert.equal(missing.filterRuleId, '')
})

test('filtered account blocks selection but returns an auditable status', () => {
  const result = coarseFilterArticle(
    { article_id: 'a2', title: '文章', content: '正文不参与账号身份规则' },
    { wx_name: '普通账号', verify: '个人', read_median: 49999 },
    DEFAULT_FILTER_CONFIG
  )
  assert.equal(result.status, 'ACCOUNT_FILTERED')
  assert.equal(result.filterRuleId, '105')
  assert.equal(result.accountMatched, true)
})
