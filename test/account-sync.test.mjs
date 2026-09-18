import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../src/db.mjs'
import { mergeAccountRows, normalizeAccountRow, syncAccounts } from '../src/account-sync.mjs'

test('account rows merge by exact wx_biz and duplicate rows are not failures', () => {
  const result = mergeAccountRows([
    { wx_biz: 'biz-1', wx_name: '账号一', read_median: 0, read_max: 100001 },
    { wx_biz: 'biz-1', description: '来自详情', read_median: null },
    { wx_biz: 'biz-2', wx_name: '账号二' },
    { wx_name: '没有身份' }
  ])

  assert.equal(result.rawCount, 4)
  assert.equal(result.uniqueCount, 2)
  assert.equal(result.duplicateCount, 1)
  assert.equal(result.invalidCount, 1)
  assert.equal(result.rows.find(row => row.wx_biz === 'biz-1').description, '来自详情')
  assert.equal(result.rows.find(row => row.wx_biz === 'biz-1').read_median, 0)
})

test('normalization converts WxRank seconds and preserves zero metrics', () => {
  const row = normalizeAccountRow({
    wx_biz: 'biz-time',
    last_pub_time: 1789216200,
    read_median: 0,
    burst_rate: 0
  }, { source: 'rank', collectedAt: '2026-09-18T04:30:00.000Z' })

  assert.equal(row.last_pub_time, new Date(1789216200 * 1000).toISOString())
  assert.equal(row.read_median, 0)
  assert.equal(row.burst_rate, 0)
  assert.equal(row.source, 'rank')
})

test('sync preserves existing values for missing fields and writes change evidence', () => {
  const db = openDatabase(':memory:')
  try {
    const old = '2026-09-17T00:00:00.000Z'
    db.prepare(`INSERT INTO accounts(account_id,wx_biz,wx_name,verify,description,status,source,created_at,updated_at,last_sync_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run('acct_existing', 'biz-existing', '旧名称', '个人', '旧简介', 'ACTIVE', 'seed', old, old, old)
    db.prepare(`INSERT INTO account_profiles(account_id,read_median,read_max,collected_at,raw_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run('acct_existing', 60000, 80000, old, '{}', old, old)

    const result = syncAccounts(db, [{
      wx_biz: 'biz-existing',
      wx_name: '新名称',
      verify: '',
      read_median: null,
      read_max: 0,
      last_pub_time: 1789216200
    }], { source: 'rank+search', collectedAt: '2026-09-18T04:30:00.000Z', runId: 'run-1' })

    const account = db.prepare('SELECT * FROM accounts WHERE wx_biz=?').get('biz-existing')
    const profile = db.prepare('SELECT * FROM account_profiles WHERE account_id=?').get('acct_existing')
    assert.equal(result.created, 0)
    assert.equal(result.updated, 1)
    assert.equal(account.wx_name, '新名称')
    assert.equal(account.verify, '')
    assert.equal(account.updated_at, '2026-09-18T04:30:00.000Z')
    assert.equal(profile.read_median, 60000)
    assert.equal(profile.read_max, 0)
    assert.equal(profile.collected_at, '2026-09-18T04:30:00.000Z')
    assert.equal(profile.last_pub_time, new Date(1789216200 * 1000).toISOString())
    assert.ok(result.changes.some(change => change.field === 'wx_name'))
  } finally {
    db.close()
  }
})

test('sync prefers a row detail collection timestamp when present', () => {
  const db = openDatabase(':memory:')
  try {
    const result = syncAccounts(db, [{
      wx_biz: 'biz-detail-time',
      wx_name: '详情时间账号',
      collected_at: '2026-09-18T04:45:00.000Z'
    }], { source: 'rank', collectedAt: '2026-09-18T04:30:00.000Z', now: '2026-09-18T05:00:00.000Z', runId: 'run-detail-time' })
    const account = db.prepare('SELECT updated_at,last_sync_at FROM accounts WHERE wx_biz=?').get('biz-detail-time')
    const profile = db.prepare('SELECT collected_at FROM account_profiles WHERE account_id=?').get(result.changes.find(change => change.wx_biz === 'biz-detail-time').account_id)
    assert.equal(account.updated_at, '2026-09-18T04:45:00.000Z')
    assert.equal(account.last_sync_at, '2026-09-18T04:45:00.000Z')
    assert.equal(profile.collected_at, '2026-09-18T04:45:00.000Z')
  } finally {
    db.close()
  }
})
