import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../src/db.mjs'
import { aggregateHotwords, aggregateHotwordsWithDiagnostics, applyHotwordFilterRules, canonicalizeHotwordRows, mergeSimilarHotwordRows, persistHotwords, tokenizeHotwords } from '../src/hotwords.mjs'

test('hotword tokenizer emits overlapping Chinese ngrams and normalized English words', () => {
  const tokens = tokenizeHotwords('苹果发布会，Apple-Event！我们 AI')
  const words = tokens.map(token => token.word)
  assert.ok(words.includes('苹果'))
  assert.ok(words.includes('果发'))
  assert.ok(words.includes('苹果发'))
  assert.ok(words.includes('apple'))
  assert.ok(words.includes('event'))
  assert.ok(words.includes('ai'))
  assert.ok(!words.includes('我们'))
  assert.ok(!words.includes('苹果发会'))
})

test('hotword aggregation merges a contained bigram into the longer phrase at the configured evidence threshold', () => {
  const articles = [
    ...Array.from({ length: 8 }, (_, index) => ({ article_id: `asian-game-${index}`, title: '亚运会', content: '', account_id: `platform-${index}` })),
    { article_id: 'asian-only-1', title: '关注「亚运」', content: '', account_id: 'platform-asian-1' },
    { article_id: 'asian-only-2', title: '关注「亚运」', content: '', account_id: 'platform-asian-2' },
  ]

  const rows = aggregateHotwords(articles, { statDate: '20260923', minArticleCount: 1, mergeConsistencyThreshold: 0.8 })
  const asianGames = rows.find(row => row.word === '亚运会')
  const asianOnly = rows.find(row => row.word === '亚运')

  assert.equal(asianGames?.article_count, 10)
  assert.equal(asianOnly, undefined)
  assert.ok(asianGames.aliases.includes('亚运'))
  assert.deepEqual(new Set(asianGames.article_ids), new Set(articles.slice(0, 10).map(article => article.article_id)))
})

test('hotword merge does not expose internal contained-evidence fields', () => {
  const rows = aggregateHotwords([
    ...Array.from({ length: 2 }, (_, index) => ({ article_id: `asian-game-${index}`, title: '亚运会', content: '', account_id: `long-${index}` })),
    ...Array.from({ length: 5 }, (_, index) => ({ article_id: `asian-short-${index}`, title: '亚运', content: '', account_id: `short-${index}` })),
  ], { statDate: '20260923', minArticleCount: 1, mergeConsistencyThreshold: 0.8 })

  const merged = rows.find(row => row.word === '亚运')
  assert.ok(merged)
  assert.equal(Object.hasOwn(merged, 'merge_article_ids'), false)
  assert.equal(Object.hasOwn(merged, 'merge_account_ids'), false)
})

test('hotword overlap suppression keeps standalone bigram evidence outside a longer phrase', () => {
  const rows = aggregateHotwords([
    { article_id: 'apple-news', title: '苹果新闻', content: '', account_id: 'p1' },
    { article_id: 'apple-new-account', title: '苹果新账号', content: '', account_id: 'p2' },
    { article_id: 'apple-standalone-1', title: '苹果', content: '', account_id: 'p3' },
    { article_id: 'apple-standalone-2', title: '苹果', content: '', account_id: 'p4' }
  ], { statDate: '20260923', minArticleCount: 1 })

  const apple = rows.find(row => row.word === '苹果')
  assert.equal(apple?.article_count, 2)
  assert.deepEqual(apple.article_ids, ['apple-standalone-1', 'apple-standalone-2'])
})

test('hotword overlap suppression preserves a bigram that also occurs independently in article content', () => {
  const rows = aggregateHotwords([
    { article_id: 'apple-news', title: '苹果新闻', content: '苹果', account_id: 'p1' },
    { article_id: 'apple-new-account', title: '苹果新账号', content: '苹果', account_id: 'p2' }
  ], { statDate: '20260923', minArticleCount: 1 })

  assert.equal(rows.find(row => row.word === '苹果')?.article_count, 2)
})

test('protected canonical prefix keeps all candidate evidence and exposes matched terms', () => {
  const result = aggregateHotwordsWithDiagnostics([
    { article_id: 'fish-1', title: '闲鱼暗号', content: '', account_id: 'platform-wechat' },
    { article_id: 'fish-2', title: '闲鱼暗号', content: '', account_id: 'platform-wechat' },
    { article_id: 'fish-3', title: '闲鱼公示', content: '', account_id: 'platform-news' },
    { article_id: 'fish-4', title: '闲鱼公示', content: '', account_id: 'platform-news' },
    { article_id: 'fish-5', title: '闲鱼', content: '', account_id: 'platform-news' }
  ], {
    statDate: '20260923',
    maxChineseGram: 3,
    minArticleCount: 1,
    mergeConsistencyThreshold: 0.8,
    canonicalRules: [{ canonical: '闲鱼', match_type: 'prefix', protected: true }]
  })

  const fish = result.rows.find(row => row.word === '闲鱼')
  assert.ok(fish)
  assert.equal(fish.article_count, 5)
  assert.equal(fish.account_count, 2)
  assert.deepEqual(fish.matched_terms, { 闲鱼: 5, 闲鱼暗: 2, 闲鱼公: 2 })
  assert.deepEqual(new Set(fish.aliases), new Set(['闲鱼暗', '闲鱼公']))
  assert.deepEqual(new Set(fish.article_ids), new Set(['fish-1', 'fish-2', 'fish-3', 'fish-4', 'fish-5']))
  assert.equal(result.filtered_count, 0)
})

test('canonical rules support exact, alias, batches, and explicit no-rule compatibility', () => {
  const result = canonicalizeHotwordRows([
    { word: '闲鱼暗', token_type: 'zh', stat_date: '20260923', article_ids: ['a1', 'a2'], account_ids: ['p1'] },
    { word: '二手平台', token_type: 'zh', stat_date: '20260923', article_ids: ['a2', 'a3'], account_ids: ['p2'] },
    { word: '转转', token_type: 'zh', stat_date: '20260923', article_ids: ['a4'], account_ids: ['p3'] }
  ], [
    { canonical: '闲鱼', match_type: 'prefix', protected: true },
    { canonical: '二手交易', match_type: 'alias', aliases: ['二手平台'] },
    { canonical: '转转', match_type: 'exact' }
  ])

  assert.deepEqual(result.rows.map(row => row.word), ['闲鱼', '二手交易', '转转'])
  assert.deepEqual(result.rows.find(row => row.word === '闲鱼').matched_terms, { 闲鱼暗: 2 })
  assert.deepEqual(result.rows.find(row => row.word === '二手交易').aliases, ['二手平台'])
  assert.equal(canonicalizeHotwordRows([{ word: '闲鱼暗', article_ids: ['a1'] }], []).rows[0].word, '闲鱼暗')
})

test('hotword filters also inspect retained candidate aliases', () => {
  const result = applyHotwordFilterRules([
    { word: '闲鱼', aliases: ['委书记'], matched_terms: { 闲鱼: 4, 委书记: 2 } },
    { word: '闲鱼暗号', aliases: ['闲鱼'] }
  ], [{ id: 9, scope: 'hotword', field_name: 'hotword', operator: 'contains', value_text: '书记', enabled: true }])

  assert.deepEqual(result.filtered_rows.map(row => row.word), ['闲鱼'])
  assert.deepEqual(result.rows.map(row => row.word), ['闲鱼暗号'])
})

test('hotword exact filter removes only the exactly matching aggregated word', () => {
  const result = applyHotwordFilterRules([
    { word: '中国', article_count: 4 },
    { word: '中国新闻', article_count: 3 },
    { word: '书记', article_count: 2 }
  ], [{ id: 1, scope: 'hotword', field_name: 'hotword', operator: 'exact', value_text: '中国', enabled: true }])

  assert.deepEqual(result.rows.map(row => row.word), ['中国新闻', '书记'])
  assert.deepEqual(result.filtered_rows.map(row => row.word), ['中国'])
  assert.deepEqual(result.rule_hit_counts, { '1': 1 })
})

test('hotword contains and multiple rules filter with OR semantics', () => {
  const result = applyHotwordFilterRules([
    { word: '中国日报' },
    { word: '书记发言' },
    { word: '国际新闻' }
  ], [
    { id: 2, scope: 'hotword', field_name: 'hotword', operator: 'contains', value_text: '中国', enabled: true },
    { id: 3, scope: 'hotword', field_name: 'hotword', operator: 'contains', value_text: '书记', enabled: true }
  ])

  assert.deepEqual(result.rows.map(row => row.word), ['国际新闻'])
  assert.deepEqual(result.filtered_rows.map(row => row.word), ['中国日报', '书记发言'])
  assert.deepEqual(result.rule_hit_counts, { '2': 1, '3': 1 })
})

test('hotword contains filter is bidirectional', () => {
  const result = applyHotwordFilterRules([
    { word: '全国' },
    { word: '全国新闻' },
    { word: '国' },
    { word: '国际新闻' }
  ], [{ id: 8, scope: 'hotword', field_name: 'hotword', operator: 'contains', value_text: '全国', enabled: true }])

  assert.deepEqual(result.rows.map(row => row.word), ['国际新闻'])
  assert.deepEqual(result.filtered_rows.map(row => row.word), ['全国', '全国新闻', '国'])
  assert.deepEqual(result.rule_hit_counts, { '8': 3 })
})

test('disabled hotword rules do not filter and no rules preserves the input rows', () => {
  const rows = [{ word: '中国' }, { word: '书记' }]
  const disabled = applyHotwordFilterRules(rows, [{ id: 4, scope: 'hotword', field_name: 'hotword', operator: 'exact', value_text: '中国', enabled: false }])

  assert.deepEqual(disabled.rows, rows)
  assert.deepEqual(disabled.filtered_rows, [])
  assert.deepEqual(applyHotwordFilterRules(rows, []).rows, rows)
})

test('aggregateHotwords applies filter rules to final aggregates and reports filtered counts', () => {
  const result = aggregateHotwordsWithDiagnostics([
    { article_id: 'a1', title: '中国', content: '', account_id: 'p1' },
    { article_id: 'a2', title: '中国', content: '', account_id: 'p2' },
    { article_id: 'a3', title: '科技', content: '', account_id: 'p3' },
    { article_id: 'a4', title: '科技', content: '', account_id: 'p4' }
  ], {
    statDate: '20260923',
    minArticleCount: 1,
    filterRules: [{ id: 5, scope: 'hotword', field_name: 'hotword', operator: 'exact', value_text: '中国', enabled: true }]
  })

  assert.equal(result.rows.some(row => row.word === '中国'), false)
  assert.ok(result.rows.some(row => row.word === '科技'))
  assert.ok(result.filtered_count >= 1)
  assert.ok(result.rule_hit_counts['5'] >= 1)
})

test('hotword aggregation deduplicates articles, counts distinct accounts, and weights titles', () => {
  const rows = aggregateHotwords([
    { article_id: 'a1', title: '苹果发布会', content: '苹果发布会', account_id: 'acct-1', read_num: 10 },
    { article_id: 'a2', title: '苹果新闻', content: '苹果', account_id: 'acct-2', read_num: 20 }
  ], { statDate: '20260918', titleWeight: 2, minArticleCount: 1 })
  const apple = rows.find(row => row.word === '苹果')
  assert.ok(apple)
  assert.equal(apple.article_count, 2)
  assert.equal(apple.account_count, 2)
  assert.equal(apple.read_sum, 30)
  assert.equal(apple.weighted_count, 6)
  assert.deepEqual(apple.examples, ['苹果发布会', '苹果新闻'])
  assert.equal(apple.stat_date, '20260918')
  assert.equal(apple.token_type, 'zh')
  assert.ok(apple.score > apple.weighted_count)
})

test('hotword tolerance merges contained variants when article evidence reaches the configured threshold', () => {
  const rows = [
    { word: '体操男团', token_type: 'zh', gram: 4, stat_date: '20260923', article_ids: ['a1', 'a2', 'a3', 'a4', 'a5'], account_ids: ['p1', 'p2'], article_count: 5, account_count: 2, weighted_count: 10, score: 20, examples: ['体操男团夺冠'] },
    { word: '体操男', token_type: 'zh', gram: 3, stat_date: '20260923', article_ids: ['a1', 'a2', 'a3', 'a4'], account_ids: ['p1'], article_count: 4, account_count: 1, weighted_count: 8, score: 18, examples: ['体操男表现出色'] },
    { word: '操男团', token_type: 'zh', gram: 3, stat_date: '20260923', article_ids: ['a1', 'a2', 'a3', 'a4'], account_ids: ['p2'], article_count: 4, account_count: 1, weighted_count: 7, score: 17, examples: ['操男团晋级'] }
  ]

  const result = mergeSimilarHotwordRows(rows, { consistencyThreshold: 0.8 })
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].word, '体操男团')
  assert.deepEqual(new Set(result.rows[0].aliases), new Set(['体操男', '操男团']))
  assert.equal(result.rows[0].article_count, 5)
  assert.equal(result.rows[0].merge_consistency, 0.8)
  assert.equal(result.merged_count, 2)
})

test('hotword tolerance threshold is adjustable and does not merge below the threshold', () => {
  const rows = [
    { word: '体操男团', token_type: 'zh', gram: 4, stat_date: '20260923', article_ids: ['a1', 'a2', 'a3', 'a4', 'a5'], article_count: 5, score: 20 },
    { word: '体操男', token_type: 'zh', gram: 3, stat_date: '20260923', article_ids: ['a1', 'a2', 'a3', 'a4'], article_count: 4, score: 18 }
  ]

  assert.equal(mergeSimilarHotwordRows(rows, { consistencyThreshold: 0.8 }).rows.length, 1)
  assert.equal(mergeSimilarHotwordRows(rows, { consistencyThreshold: 0.81 }).rows.length, 2)
})

test('hotword tolerance requires the configured minimum number of cross-article evidence', () => {
  const longWord = {
    word: '亚运会', token_type: 'zh', gram: 3, stat_date: '20260923',
    article_ids: ['a1', 'a2', 'a3', 'a4'], article_count: 4, score: 20
  }
  const twoArticleVariant = {
    word: '亚运', token_type: 'zh', gram: 2, stat_date: '20260923',
    article_ids: ['a1', 'a2'], article_count: 2, score: 18
  }
  const threeArticleVariant = { ...twoArticleVariant, article_ids: ['a1', 'a2', 'a3'], article_count: 3 }

  const blocked = mergeSimilarHotwordRows([longWord, twoArticleVariant], { consistencyThreshold: 0.5, minCrossArticleCount: 3 })
  assert.equal(blocked.rows.length, 2)
  assert.equal(blocked.merge_min_article_count, 3)

  const merged = mergeSimilarHotwordRows([longWord, threeArticleVariant], { consistencyThreshold: 0.5, minCrossArticleCount: 3 })
  assert.equal(merged.rows.length, 1)
  assert.equal(merged.rows[0].word, '亚运会')
})

test('aggregateHotwords applies configurable tolerance before final filtering', () => {
  const result = aggregateHotwordsWithDiagnostics(
    Array.from({ length: 5 }, (_, index) => ({ article_id: `gym-${index}`, title: '体操男团', content: '', account_id: `p-${index}` })),
    { statDate: '20260923', minArticleCount: 1, mergeConsistencyThreshold: 0.8 }
  )
  const canonical = result.rows.find(row => row.word === '体操男团')
  assert.ok(canonical)
  assert.ok(canonical.aliases.includes('体操男'))
  assert.ok(canonical.aliases.includes('操男团'))
  assert.ok(result.merged_count >= 2)
  assert.equal(result.merge_consistency_threshold, 0.8)
})

test('hotword persistence is idempotent for one stat date', () => {
  const db = openDatabase(':memory:')
  try {
    const rows = aggregateHotwords([
      { article_id: 'a1', title: '测试热词', content: '', account_id: 'acct-1', read_num: 1 }
    ], { statDate: '20260918' })
    persistHotwords(db, rows, { now: '2026-09-18T04:30:00.000Z' })
    persistHotwords(db, rows, { now: '2026-09-18T05:30:00.000Z' })
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM hotwords').get().count, rows.length)
    assert.equal(db.prepare('SELECT updated_at FROM hotwords LIMIT 1').get().updated_at, '2026-09-18T05:30:00.000Z')
  } finally {
    db.close()
  }
})
