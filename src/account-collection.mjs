import { nowIso } from './db.mjs'
import { accountIdForWxBiz } from './account-sync.mjs'

function text(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function first(article, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(article, key) && article[key] !== undefined && article[key] !== null) return article[key]
  }
  return undefined
}

function json(value) {
  try { return JSON.stringify(value) } catch { return '{}'
  }
}

function accountInput(article = {}) {
  const nested = article.account && typeof article.account === 'object' ? article.account : {}
  return {
    wx_biz: text(first(article, 'wx_biz', 'wxBiz', 'biz') ?? first(nested, 'wx_biz', 'wxBiz', 'biz')),
    wx_name: text(first(article, 'wx_name', 'wxName', 'publisher', 'account_name', 'name') ?? first(nested, 'wx_name', 'wxName', 'name')),
    verify: text(first(article, 'verify', 'certification_subject') ?? first(nested, 'verify', 'certification_subject')),
    description: text(first(article, 'description', 'introduction') ?? first(nested, 'description', 'introduction'))
  }
}

export function ensureArticleAccount(db, article = {}, { now = nowIso(), source = 'article' } = {}) {
  const input = accountInput(article)
  if (!input.wx_biz) return { accountId: null, created: false, collectedAtUpdated: false, reason: 'wx_biz_missing' }

  const existing = db.prepare('SELECT * FROM accounts WHERE wx_biz=? LIMIT 1').get(input.wx_biz)
  if (existing) {
    const profile = db.prepare('SELECT * FROM account_profiles WHERE account_id=? LIMIT 1').get(existing.account_id)
    if (!profile) {
      db.prepare(`INSERT INTO account_profiles(account_id,collected_at,raw_json,created_at,updated_at)
        VALUES(?,?,?,?,?)`).run(existing.account_id, now, json(article), now, now)
    }
    return {
      accountId: existing.account_id,
      created: false,
      collectedAtUpdated: false,
      account: existing
    }
  }

  const accountId = accountIdForWxBiz(input.wx_biz)
  db.prepare(`INSERT INTO accounts(account_id,wx_biz,wx_name,verify,description,status,source,created_at,updated_at,last_sync_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    accountId, input.wx_biz, input.wx_name, input.verify, input.description, 'ACTIVE', source, now, now, ''
  )
  db.prepare(`INSERT INTO account_profiles(account_id,collected_at,raw_json,created_at,updated_at)
    VALUES(?,?,?,?,?)`).run(accountId, now, json(article), now, now)
  return {
    accountId,
    created: true,
    collectedAtUpdated: true,
    account: db.prepare('SELECT * FROM accounts WHERE account_id=?').get(accountId)
  }
}
