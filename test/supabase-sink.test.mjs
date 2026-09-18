import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSupabaseWriteSet, createSupabaseRestSink } from '../src/supabase-sink.mjs'

test('builds an existing-schema Supabase write set without migrating old data', () => {
  const writeSet = buildSupabaseWriteSet({
    accountRows: [
      { wx_biz: 'biz-1', wx_name: '账号一', read_median: 60000, tags: ['财经'], collected_at: '2026-09-18T04:30:00.000Z' },
      { wx_biz: 'biz-1', description: '合并后的简介', read_median: null },
      { wx_biz: 'biz-2', wx_name: '账号二', read_median: null }
    ],
    articleRows: [
      { article_id: 'article-selected', wx_biz: 'biz-1', title: '苹果新闻', article_url: 'https://example.test/a', publish_time: '2026-09-18 08:00:00', read_num: 100001 },
      { article_id: 'article-filtered', wx_biz: 'biz-2', title: '机构文章', read_num: 20 },
      { article_id: 'article-new-account', wx_biz: 'biz-3', wx_name: '文章新账号', title: '新账号文章', read_num: 30 }
    ],
    report: {
      runDate: '20260918',
      accounts: { rawCount: 3, uniqueCount: 2, duplicateCount: 1, invalidCount: 0 },
      articles: {
        statusCounts: { SELECTED: 1, ACCOUNT_FILTERED: 1, ACCOUNT_UNMATCHED: 1 },
        decisions: [
          { article_id: 'article-selected', status: 'SELECTED' },
          { article_id: 'article-filtered', status: 'ACCOUNT_FILTERED' },
          { article_id: 'article-new-account', status: 'ACCOUNT_UNMATCHED' }
        ]
      },
      hotwords: {
        rows: [
          { word: '苹果', stat_date: '20260918', article_count: 2, article_ids: ['article-selected', 'article-filtered'], article_url: 'https://example.test/a' },
          { word: '单篇', stat_date: '20260918', article_count: 1, article_ids: ['article-selected'] }
        ]
      }
    },
    now: '2026-09-18T04:30:00.000Z',
    source: 'wxrank'
  })

  assert.equal(writeSet.migrationApplied, false)
  assert.deepEqual(writeSet.accounts.map(item => item.wx_biz), ['biz-1', 'biz-2', 'biz-3'])
  assert.equal(writeSet.accounts.find(item => item.wx_biz === 'biz-3').profile.collected_at, '2026-09-18T04:30:00.000Z')
  assert.equal(writeSet.accounts.find(item => item.wx_biz === 'biz-1').profile.tags[0], '财经')
  assert.deepEqual(writeSet.articles.map(item => item.article_sn), ['article-selected'])
  assert.equal(writeSet.articles[0].published_at, '2026-09-18T00:00:00.000Z')
  assert.equal(writeSet.articles[0].read_num_capped, true)
  assert.deepEqual(writeSet.hotwords.map(item => item.hotword), ['苹果'])
  assert.equal(writeSet.hotwords[0].stat_date, '2026-09-18')
  assert.deepEqual(writeSet.hotwords[0].article_keys, ['article-selected', 'article-filtered'])
  assert.equal(writeSet.job.params.no_migration, true)
  assert.equal(writeSet.job.params.filter_audit.length, 2)
  assert.equal(writeSet.steps.length, 4)
})

test('REST sink writes only the existing Supabase tables and keeps the account id join server-resolved', async () => {
  const writeSet = buildSupabaseWriteSet({
    accountRows: [{ wx_biz: 'biz-rest', wx_name: 'REST账号', read_median: 90000 }],
    articleRows: [{ article_id: 'rest-article', wx_biz: 'biz-rest', title: 'REST文章', read_num: 12 }],
    report: {
      runDate: '20260918',
      accounts: { rawCount: 1, uniqueCount: 1, duplicateCount: 0, invalidCount: 0 },
      articles: { statusCounts: { SELECTED: 1 }, decisions: [{ article_id: 'rest-article', status: 'SELECTED' }] },
      hotwords: { rows: [] }
    },
    now: '2026-09-18T04:30:00.000Z'
  })
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/accounts') && options.method === 'GET') {
      return { ok: true, status: 200, json: async () => [] }
    }
    if (parsed.pathname.endsWith('/accounts') && options.method === 'POST') {
      const body = JSON.parse(options.body)
      return { ok: true, status: 201, json: async () => body.map((row, index) => ({ ...row, account_id: index + 900 })) }
    }
    if (parsed.pathname.endsWith('/account_profiles') || parsed.pathname.endsWith('/articles') || parsed.pathname.endsWith('/hotwords')) {
      return { ok: true, status: 201, json: async () => [] }
    }
    if (parsed.pathname.endsWith('/jobs')) {
      return { ok: true, status: 201, json: async () => [{ id: 77 }] }
    }
    if (parsed.pathname.endsWith('/job_steps')) {
      return { ok: true, status: 201, json: async () => [] }
    }
    throw new Error(`unexpected request: ${url}`)
  }

  const result = await createSupabaseRestSink({
    url: 'https://project.supabase.co',
    key: 'server-only-test-key',
    fetchImpl
  }).write(writeSet)

  assert.equal(result.accountCount, 1)
  assert.equal(result.articleCount, 1)
  assert.ok(calls.some(call => call.url.includes('/rest/v1/accounts')))
  assert.ok(calls.some(call => call.url.includes('/rest/v1/account_profiles')))
  const articleCall = calls.find(call => call.url.includes('/rest/v1/articles'))
  assert.ok(articleCall)
  assert.equal(JSON.parse(articleCall.options.body)[0].account_id, 900)
  assert.ok(calls.some(call => call.url.includes('/rest/v1/jobs')))
  assert.ok(calls.every(call => !call.url.includes('migrations')))
})
