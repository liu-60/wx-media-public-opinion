import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../src/db.mjs'

test('database schema creates the durable account, article, and hotword tables', () => {
  const db = openDatabase(':memory:')
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name))
    for (const name of ['sync_runs', 'accounts', 'account_profiles', 'articles', 'article_filter_audit', 'hotwords']) {
      assert.ok(tables.has(name), `missing table ${name}`)
    }
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name)
    assert.ok(indexes.includes('accounts_wx_biz_unique'))
  } finally {
    db.close()
  }
})
