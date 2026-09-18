import crypto from 'node:crypto'
import { nowIso } from './db.mjs'

const ACCOUNT_FIELDS = Object.freeze(['wx_name', 'verify', 'description', 'read_median', 'read_max'])
const PROFILE_FIELDS = Object.freeze([
  'wx_user', 'avatar', 'wx_type', 'region', 'tags_json', 'last_pub_time', 'stat_date',
  'pub_count', 'active_days', 'read_avg', 'read_median', 'read_max', 'burst_count', 'burst_rate',
  'ori_count', 'ori_rate', 'look_avg', 'look_median', 'look_max', 'like_avg', 'like_median',
  'like_max', 'share_avg', 'share_median', 'share_max', 'comment_avg', 'comment_median',
  'comment_max', 'wci_index'
])
const TEXT_FIELDS = new Set(['wx_name', 'verify', 'description', 'wx_user', 'avatar', 'wx_type', 'region'])
const INTEGER_FIELDS = new Set(['pub_count', 'active_days', 'burst_count', 'ori_count'])

const aliases = Object.freeze({
  wx_biz: ['wx_biz', 'wxBiz', 'biz'],
  wx_name: ['wx_name', 'wxName', 'name', '公众号名'],
  verify: ['verify', 'certification_subject', 'verify主体', '核实'],
  description: ['description', 'introduction', '描述'],
  wx_user: ['wx_user', 'wxUser'],
  avatar: ['avatar'],
  wx_type: ['wx_type', 'wxType'],
  region: ['region'],
  tags: ['tags', 'tags_json'],
  last_pub_time: ['last_pub_time', 'lastPubTime'],
  stat_date: ['stat_date', 'statDate'],
  pub_count: ['pub_count', 'pubCount'],
  active_days: ['active_days', 'activeDays'],
  read_avg: ['read_avg', 'readAvg'],
  read_median: ['read_median', 'readMedian'],
  read_max: ['read_max', 'readMax'],
  burst_count: ['burst_count', 'burstCount'],
  burst_rate: ['burst_rate', 'burstRate'],
  ori_count: ['ori_count', 'oriCount'],
  ori_rate: ['ori_rate', 'oriRate'],
  look_avg: ['look_avg', 'lookAvg'],
  look_median: ['look_median', 'lookMedian'],
  look_max: ['look_max', 'lookMax'],
  like_avg: ['like_avg', 'likeAvg'],
  like_median: ['like_median', 'likeMedian'],
  like_max: ['like_max', 'likeMax'],
  share_avg: ['share_avg', 'shareAvg'],
  share_median: ['share_median', 'shareMedian'],
  share_max: ['share_max', 'shareMax'],
  comment_avg: ['comment_avg', 'commentAvg'],
  comment_median: ['comment_median', 'commentMedian'],
  comment_max: ['comment_max', 'commentMax'],
  wci_index: ['wci_index', 'wciIndex']
})

function firstValue(row, field) {
  for (const key of aliases[field] || [field]) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key]
  }
  return undefined
}

function text(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function optionalText(value) {
  return value === undefined ? undefined : value === null ? null : text(value)
}

function numberOrNull(value) {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const parsed = Number(String(value).replaceAll(',', '').trim())
  return Number.isFinite(parsed) ? parsed : null
}

function numericField(value, field) {
  const parsed = numberOrNull(value)
  if (parsed === undefined || parsed === null) return parsed
  return INTEGER_FIELDS.has(field) ? Math.trunc(parsed) : parsed
}

export function timestampToIso(value) {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const numeric = Number(value)
  const date = Number.isFinite(numeric)
    ? new Date(Math.abs(numeric) < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function statDate(value) {
  if (value === null) return null
  if (value === undefined) return undefined
  const raw = text(value).replaceAll('-', '')
  if (/^20\d{6}$/u.test(raw)) return raw
  const iso = timestampToIso(value)
  return iso ? iso.slice(0, 10).replaceAll('-', '') : null
}

function json(value) {
  try { return JSON.stringify(value) } catch { return 'null' }
}

function normalizeTags(value) {
  if (value === undefined) return undefined
  if (value === null) return null
  if (Array.isArray(value)) return json(value)
  if (typeof value === 'string') {
    try { return json(JSON.parse(value)) } catch { return value }
  }
  return json(value)
}

export function normalizeAccountRow(row = {}, { source = '', collectedAt = '' } = {}) {
  const normalized = {
    wx_biz: optionalText(firstValue(row, 'wx_biz')) || null,
    wx_name: optionalText(firstValue(row, 'wx_name')),
    verify: optionalText(firstValue(row, 'verify')),
    description: optionalText(firstValue(row, 'description')),
    wx_user: optionalText(firstValue(row, 'wx_user')),
    avatar: optionalText(firstValue(row, 'avatar')),
    wx_type: optionalText(firstValue(row, 'wx_type')),
    region: optionalText(firstValue(row, 'region')),
    tags_json: normalizeTags(firstValue(row, 'tags')),
    last_pub_time: timestampToIso(firstValue(row, 'last_pub_time')),
    stat_date: statDate(firstValue(row, 'stat_date')),
    source: optionalText(row.source) ?? text(source),
    collected_at: timestampToIso(row.collected_at ?? collectedAt),
    raw: row.raw ?? row
  }
  for (const field of [
    'pub_count', 'active_days', 'read_avg', 'read_median', 'read_max', 'burst_count', 'burst_rate',
    'ori_count', 'ori_rate', 'look_avg', 'look_median', 'look_max', 'like_avg', 'like_median',
    'like_max', 'share_avg', 'share_median', 'share_max', 'comment_avg', 'comment_median',
    'comment_max', 'wci_index'
  ]) normalized[field] = numericField(firstValue(row, field), field)
  return normalized
}

function isProvided(value) {
  return value !== undefined && value !== null
}

export function accountIdForWxBiz(wxBiz) {
  const value = text(wxBiz)
  if (!value) throw new TypeError('wx_biz is required')
  return `acct_${crypto.createHash('sha256').update(`wx_biz:${value}`, 'utf8').digest('hex').slice(0, 24)}`
}

export function mergeAccountRows(rows = [], options = {}) {
  const byBiz = new Map()
  let invalidCount = 0
  let duplicateCount = 0
  for (const raw of rows) {
    const row = normalizeAccountRow(raw, options)
    if (!row.wx_biz) {
      invalidCount += 1
      continue
    }
    const previous = byBiz.get(row.wx_biz)
    if (previous) duplicateCount += 1
    const merged = previous ? { ...previous } : row
    if (previous) {
      for (const [key, value] of Object.entries(row)) {
        if (key === 'raw') continue
        if (isProvided(value) && (value !== '' || !isProvided(merged[key]) || merged[key] === '')) merged[key] = value
      }
      merged.raw = { ...(previous.raw && typeof previous.raw === 'object' ? previous.raw : {}), ...(row.raw && typeof row.raw === 'object' ? row.raw : {}) }
    }
    byBiz.set(row.wx_biz, merged)
  }
  return {
    rows: [...byBiz.values()],
    rawCount: Array.isArray(rows) ? rows.length : 0,
    uniqueCount: byBiz.size,
    duplicateCount,
    invalidCount
  }
}

function equalValue(left, right) {
  if (left === right) return true
  if (left === null || left === undefined || right === null || right === undefined) return false
  return json(left) === json(right)
}

function valueFromRow(row, field, fallback) {
  return isProvided(row[field]) ? row[field] : fallback
}

function change(changes, scope, field, wxBiz, accountId, oldValue, newValue) {
  if (oldValue === undefined && (newValue === undefined || newValue === null || newValue === '')) return
  if (!equalValue(oldValue, newValue)) changes.push({ scope, field, wx_biz: wxBiz, account_id: accountId, old: oldValue ?? null, new: newValue ?? null })
}

function profileDbValue(row, field) {
  return field === 'tags_json' ? row[field] : row[field]
}

export function buildAccountUpsertPayload(input = {}) {
  const row = input.wx_biz !== undefined && Object.prototype.hasOwnProperty.call(input, 'raw')
    ? input
    : normalizeAccountRow(input)
  return {
    account: {
      wx_biz: row.wx_biz,
      wx_name: row.wx_name,
      verify: row.verify,
      description: row.description,
      read_median: row.read_median,
      read_max: row.read_max
    },
    profile: Object.fromEntries(PROFILE_FIELDS.map(field => [field, profileDbValue(row, field)]))
  }
}

function readAccountRow(db, wxBiz) {
  return db.prepare('SELECT * FROM accounts WHERE wx_biz=? LIMIT 1').get(wxBiz)
}

function readProfileRow(db, accountId) {
  return db.prepare('SELECT * FROM account_profiles WHERE account_id=? LIMIT 1').get(accountId)
}

export function syncAccounts(db, rows = [], { source = 'wxrank', collectedAt = '', now = nowIso(), runId = '' } = {}) {
  const collected = timestampToIso(collectedAt) || now
  const merged = mergeAccountRows(rows, { source, collectedAt: collected })
  const effectiveRunId = runId || `account-sync-${collected.replace(/\D/gu, '').slice(0, 14)}`
  db.prepare(`INSERT INTO sync_runs(run_id,run_date,source,status,raw_account_count,unique_account_count,duplicate_account_count,invalid_account_count,created_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET raw_account_count=excluded.raw_account_count,unique_account_count=excluded.unique_account_count,duplicate_account_count=excluded.duplicate_account_count,invalid_account_count=excluded.invalid_account_count`).run(
    effectiveRunId, collected.slice(0, 10), source, 'RUNNING', merged.rawCount, merged.uniqueCount, merged.duplicateCount, merged.invalidCount, now
  )

  const changes = []
  let created = 0
  let updated = 0
  let unchanged = 0
  let profileTimeRefreshed = 0
  for (const row of merged.rows) {
    const rowCollectedAt = timestampToIso(row.collected_at) || collected
    const existing = readAccountRow(db, row.wx_biz)
    const accountId = existing?.account_id || accountIdForWxBiz(row.wx_biz)
    const accountValues = {
      wx_name: valueFromRow(row, 'wx_name', existing?.wx_name || ''),
      verify: valueFromRow(row, 'verify', existing?.verify || ''),
      description: valueFromRow(row, 'description', existing?.description || ''),
      read_median: valueFromRow(row, 'read_median', existing?.read_median ?? null),
      read_max: valueFromRow(row, 'read_max', existing?.read_max ?? null)
    }
    for (const field of ACCOUNT_FIELDS) change(changes, 'account', field, row.wx_biz, accountId, existing?.[field], accountValues[field])
    const updatedAt = rowCollectedAt
    if (existing) {
      db.prepare(`UPDATE accounts SET wx_name=?,verify=?,description=?,read_median=?,read_max=?,source=CASE WHEN ?<>'' THEN ? ELSE source END,updated_at=?,last_sync_at=? WHERE account_id=?`).run(
        accountValues.wx_name, accountValues.verify, accountValues.description, accountValues.read_median, accountValues.read_max, row.source || '', row.source || '', updatedAt, rowCollectedAt, accountId
      )
    } else {
      db.prepare(`INSERT INTO accounts(account_id,wx_biz,wx_name,verify,description,read_median,read_max,status,source,created_at,updated_at,last_sync_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(accountId, row.wx_biz, accountValues.wx_name, accountValues.verify, accountValues.description, accountValues.read_median, accountValues.read_max, 'ACTIVE', row.source || source, now, updatedAt, rowCollectedAt)
    }

    const existingProfile = readProfileRow(db, accountId)
    const profileValues = {}
    for (const field of PROFILE_FIELDS) profileValues[field] = valueFromRow(row, field, existingProfile?.[field] ?? null)
    for (const field of PROFILE_FIELDS) change(changes, 'profile', field, row.wx_biz, accountId, existingProfile?.[field], profileValues[field])
    if (!equalValue(existingProfile?.collected_at, rowCollectedAt)) profileTimeRefreshed += 1
    const rawJson = json(row.raw ?? row)
    if (existingProfile) {
      const assignments = PROFILE_FIELDS.map(field => `${field}=?`).join(',')
      db.prepare(`UPDATE account_profiles SET ${assignments},collected_at=?,raw_json=?,updated_at=? WHERE account_id=?`).run(
        ...PROFILE_FIELDS.map(field => profileValues[field]), rowCollectedAt, rawJson, rowCollectedAt, accountId
      )
    } else {
      const columns = ['account_id', ...PROFILE_FIELDS, 'collected_at', 'raw_json', 'created_at', 'updated_at']
      const placeholders = columns.map(() => '?').join(',')
      db.prepare(`INSERT INTO account_profiles(${columns.join(',')}) VALUES(${placeholders})`).run(
        accountId, ...PROFILE_FIELDS.map(field => profileValues[field]), rowCollectedAt, rawJson, now, rowCollectedAt
      )
    }
    const sourceChanges = changes.filter(item => item.account_id === accountId)
    if (existing) {
      if (sourceChanges.length) updated += 1
      else unchanged += 1
    } else created += 1
  }
  const summary = {
    runId: effectiveRunId,
    rawCount: merged.rawCount,
    uniqueCount: merged.uniqueCount,
    duplicateCount: merged.duplicateCount,
    invalidCount: merged.invalidCount,
    created,
    updated,
    unchanged,
    profileTimeRefreshed,
    changes
  }
  db.prepare(`UPDATE sync_runs SET status='COMPLETED',raw_account_count=?,unique_account_count=?,duplicate_account_count=?,invalid_account_count=?,completed_at=? WHERE run_id=?`).run(
    merged.rawCount, merged.uniqueCount, merged.duplicateCount, merged.invalidCount, now, effectiveRunId
  )
  return summary
}

export { ACCOUNT_FIELDS, PROFILE_FIELDS }
