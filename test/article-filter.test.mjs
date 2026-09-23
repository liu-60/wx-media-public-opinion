import assert from 'node:assert/strict'
import test from 'node:test'
import { coarseFilterArticle, DEFAULT_FILTER_CONFIG, evaluateAccountRules } from '../src/article-filter.mjs'

test('missing or blank read_median skips rule 105 while numeric boundaries remain exact', () => {
  const base = { wx_name: '普通账号', verify: '个人' }
  for (const read_median of [null, undefined, '', '   ']) {
    assert.equal(evaluateAccountRules({ ...base, read_median }, DEFAULT_FILTER_CONFIG).filtered, false)
  }
  assert.equal(evaluateAccountRules({ ...base, read_median: 49999 }, DEFAULT_FILTER_CONFIG).ruleId, '105')
  assert.equal(evaluateAccountRules({ ...base, read_median: 0 }, DEFAULT_FILTER_CONFIG).ruleId, '105')
  assert.equal(evaluateAccountRules({ ...base, read_median: 50000 }, DEFAULT_FILTER_CONFIG).filtered, false)
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

test('persistent rules keep null numeric fields unmatched and decision_status=2 blocks even with no rules', async () => {
  const module = await import('../src/article-filter.mjs')
  assert.equal(typeof module.evaluatePersistedRules, 'function')
  const rule = { id: 105, scope: 'account', field_name: 'read_median', operator: 'lt', value_number: 50000, value_text: null, enabled: true }
  assert.equal(module.evaluatePersistedRules({ read_median: null }, {}, [rule]).filtered, false)
  assert.equal(module.evaluatePersistedRules({ read_median: 49999 }, {}, [rule]).ruleId, 105)
  const decision = coarseFilterArticle(
    { title: '文章' },
    { wx_name: '普通账号', verify: '个人', read_median: 90000, decision_status: 2 },
    DEFAULT_FILTER_CONFIG,
    []
  )
  assert.equal(decision.status, 'ACCOUNT_FILTERED')
})

test('persistent article comment rule accepts comment_num, commentNum, and comment aliases', async () => {
  const module = await import('../src/article-filter.mjs')
  assert.equal(typeof module.evaluatePersistedRules, 'function')
  const rules = [{ id: 103, scope: 'article', field_name: 'comment_count', operator: 'lt', value_number: 10, value_text: null, enabled: true }]
  for (const article of [{ comment_num: 2 }, { commentNum: 2 }, { comment: 2 }]) {
    assert.equal(module.evaluatePersistedRules({}, article, rules).ruleId, 103)
  }
})

test('hotword exact rules are valid in shared snapshots but never affect article filtering', async () => {
  const { createRuleSnapshot, evaluatePersistedRules } = await import('../src/article-filter.mjs')
  const rules = [
    { id: 201, scope: 'hotword', field_name: 'hotword', operator: 'exact', value_text: '中国', value_number: null, enabled: true },
    { id: 202, scope: 'article', field_name: 'title', operator: 'contains', value_text: '风险词', value_number: null, enabled: true }
  ]
  const snapshot = createRuleSnapshot(rules)

  assert.equal(snapshot.count, 2)
  assert.deepEqual(evaluatePersistedRules({}, { title: '中国的普通文章' }, snapshot.rules), { filtered: false, ruleId: '', reasons: [] })
  assert.equal(evaluatePersistedRules({}, { title: '风险词标题' }, snapshot.rules).ruleId, 202)
})
