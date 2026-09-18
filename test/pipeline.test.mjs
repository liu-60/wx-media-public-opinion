import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../src/db.mjs'
import { runPipeline, runPipelineFromWxRank } from '../src/pipeline.mjs'

test('pipeline syncs by wx_biz, screens articles, and keeps filtered traffic in hotwords', () => {
  const db = openDatabase(':memory:')
  try {
    const report = runPipeline({
      db,
      accountRows: [
        { wx_biz: 'biz-filter', wx_name: '普通账号', read_median: 49999 },
        { wx_biz: 'biz-filter', description: '重复的详情行' },
        { wx_biz: 'biz-null', wx_name: '待审核账号', read_median: null }
      ],
      articleRows: [
        { article_id: 'article-filtered', wx_biz: 'biz-filter', title: '苹果发布会', content: '苹果', read_num: 10 },
        { article_id: 'article-null', wx_biz: 'biz-null', title: '苹果新闻', content: '苹果', read_num: 20 },
        { article_id: 'article-new', wx_biz: 'biz-new', wx_name: '新账号', title: '苹果新账号', content: '苹果', read_num: 30 },
        { article_id: 'article-unmatched', title: '无账号文章', content: '苹果', read_num: 40 }
      ],
      runDate: '2026-09-18',
      now: '2026-09-18T04:30:00.000Z'
    })

    assert.equal(report.accounts.duplicateCount, 1)
    assert.equal(report.accounts.invalidCount, 0)
    assert.equal(report.articles.statusCounts.ACCOUNT_FILTERED, 1)
    assert.equal(report.articles.statusCounts.SELECTED, 2)
    assert.equal(report.articles.statusCounts.ACCOUNT_UNMATCHED, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, 3)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM articles').get().count, 4)
    assert.equal(db.prepare("SELECT status FROM articles WHERE article_id='article-filtered'").get().status, 'ACCOUNT_FILTERED')
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM article_filter_audit WHERE article_id='article-filtered'").get().count, 1)
    const apple = report.hotwords.rows.find(row => row.word === '苹果')
    assert.ok(apple)
    assert.equal(apple.article_count, 4)
    assert.equal(apple.read_sum, 100)
    assert.equal(db.prepare("SELECT collected_at FROM account_profiles WHERE account_id=(SELECT account_id FROM accounts WHERE wx_biz='biz-new')").get().collected_at, '2026-09-18T04:30:00.000Z')
  } finally {
    db.close()
  }
})

test('pipeline can collect account rows through the WxRank adapter before processing articles', async () => {
  const db = openDatabase(':memory:')
  try {
    const result = await runPipelineFromWxRank({
      db,
      fetchOptions: {
        baseUrl: 'https://example.test',
        fetchImpl: async (url) => ({
          status: 200,
          json: async () => ({ code: 0, data: { list: [{ wx_biz: url.includes('rank/account') ? 'biz-rank' : 'biz-search', wx_name: '来源账号' }] } })
        })
      },
      articleRows: [{ article_id: 'a1', wx_biz: 'biz-rank', title: '来源文章', content: '正文' }],
      runDate: '2026-09-18',
      now: '2026-09-18T04:30:00.000Z'
    })
    assert.equal(result.accounts.uniqueCount, 2)
    assert.equal(result.articles.statusCounts.SELECTED, 1)
  } finally {
    db.close()
  }
})
