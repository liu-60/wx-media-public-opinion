import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../src/db.mjs'
import { aggregateHotwords, persistHotwords, tokenizeHotwords } from '../src/hotwords.mjs'

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
