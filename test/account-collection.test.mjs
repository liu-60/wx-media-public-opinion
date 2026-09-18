import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../src/db.mjs'
import { ensureArticleAccount } from '../src/account-collection.mjs'

test('article discovery creates a new wx_biz account and profile timestamp once', () => {
  const db = openDatabase(':memory:')
  try {
    const first = ensureArticleAccount(db, { wx_biz: 'biz-new', wx_name: '新账号' }, { now: '2026-09-18T04:30:00.000Z' })
    const second = ensureArticleAccount(db, { wx_biz: 'biz-new', wx_name: '新账号' }, { now: '2026-09-18T05:30:00.000Z' })
    assert.equal(first.created, true)
    assert.equal(first.collectedAtUpdated, true)
    assert.equal(second.created, false)
    assert.equal(second.collectedAtUpdated, false)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, 1)
    assert.equal(db.prepare('SELECT collected_at FROM account_profiles').get().collected_at, '2026-09-18T04:30:00.000Z')
  } finally {
    db.close()
  }
})

test('same name with different wx_biz values remains two accounts', () => {
  const db = openDatabase(':memory:')
  try {
    ensureArticleAccount(db, { wx_biz: 'biz-a', wx_name: '同名账号' }, { now: '2026-09-18T04:30:00.000Z' })
    ensureArticleAccount(db, { wx_biz: 'biz-b', wx_name: '同名账号' }, { now: '2026-09-18T04:30:00.000Z' })
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, 2)
  } finally {
    db.close()
  }
})
