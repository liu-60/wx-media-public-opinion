import { mergeAccountRows, normalizeAccountRow, timestampToIso } from './account-sync.mjs'
import { articleIdentity } from './article-filter.mjs'

const ACCOUNT_FIELDS = Object.freeze(['wx_name', 'verify', 'description', 'read_median', 'read_max'])
const PROFILE_FIELD_MAP = Object.freeze({
  wx_user: 'wx_user',
  avatar: 'avatar',
  wx_type: 'wx_type',
  region: 'region',
  tags_json: 'tags',
  last_pub_time: 'last_pub_time',
  pub_count: 'pub_count',
  active_days: 'active_days',
  read_avg: 'read_avg',
  read_median: 'read_median',
  read_max: 'read_max',
  burst_count: 'burst_count',
  burst_rate: 'burst_rate',
  look_avg: 'look_avg',
  look_median: 'look_median',
  look_max: 'look_max',
  like_avg: 'like_avg',
  like_median: 'like_median',
  like_max: 'like_max',
  share_avg: 'share_avg',
  share_median: 'share_median',
  share_max: 'share_max',
  comment_avg: 'comment_avg',
  comment_median: 'comment_median',
  comment_max: 'comment_max',
  ori_count: 'ori_count',
  collected_at: 'collected_at'
})
const ARTICLE_FIELDS = Object.freeze([
  'article_sn', 'idx', 'title', 'article_url', 'published_at', 'read_num', 'read_num_capped',
  'like_num', 'look_num', 'share_num', 'comment_num', 'is_original', 'source_code'
])

function text(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function hasValue(value) {
  return value !== undefined && value !== null
}

function integerOrUndefined(value) {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(String(value).replaceAll(',', '').trim())
  return Number.isFinite(number) ? Math.trunc(number) : undefined
}

function decimalOrUndefined(value) {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(String(value).replaceAll(',', '').trim())
  return Number.isFinite(number) ? number : undefined
}

function dateTime(value) {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const numeric = Number(value)
  if (Number.isFinite(numeric) && /^\d{10,13}$/u.test(String(value).trim())) {
    const parsed = timestampToIso(value)
    return parsed || null
  }
  let raw = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}$/u.test(raw)) raw += 'T00:00:00+08:00'
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/u.test(raw)) raw = raw.replace(' ', 'T') + '+08:00'
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function dateOnly(value, fallback = '') {
  const raw = text(value || fallback).replaceAll('-', '')
  if (/^20\d{6}$/u.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  const parsed = dateTime(value || fallback)
  return parsed ? parsed.slice(0, 10) : null
}

function parseJson(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function first(row, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined && row[key] !== null) return row[key]
  }
  return undefined
}

function articleId(row) {
  return articleIdentity(row).articleId
}

function articleSn(row) {
  return articleIdentity(row).articleSn
}

function articleIndex(row, url) {
  const direct = integerOrUndefined(first(row, 'idx', 'index'))
  if (direct && direct > 0) return direct
  try {
    const value = integerOrUndefined(new URL(url).searchParams.get('idx'))
    return value && value > 0 ? value : 1
  } catch {
    return 1
  }
}

function accountPayload(row, now) {
  const payload = { wx_biz: row.wx_biz, updated_at: dateTime(row.collected_at) || dateTime(now) || now }
  for (const field of ACCOUNT_FIELDS) {
    if (hasValue(row[field])) payload[field] = row[field]
  }
  return payload
}

function profilePayload(row, now) {
  const payload = { wx_biz: row.wx_biz, collected_at: dateTime(row.collected_at) || dateTime(now) || now }
  for (const [sourceField, targetField] of Object.entries(PROFILE_FIELD_MAP)) {
    if (sourceField === 'collected_at') continue
    const value = row[sourceField]
    if (!hasValue(value)) continue
    payload[targetField] = sourceField === 'tags_json' ? parseJson(value) : value
  }
  return payload
}

function normalizeArticle(row = {}) {
  const url = text(first(row, 'article_url', 'articleUrl', 'art_url', 'url', 'link'))
  const title = text(first(row, 'title', 'article_title', 'art_title', 'name'))
  const publishValue = first(row, 'publish_time', 'publishTime', 'pub_time', 'publish_date', 'published_at', 'created_at', 'date')
  const readNum = integerOrUndefined(first(row, 'read_num', 'readNum', 'read'))
  const original = first(row, 'is_original', 'isOriginal', 'original')
  const normalized = {
    article_id: articleId(row),
    article_sn: articleSn(row),
    wx_biz: text(first(row, 'wx_biz', 'wxBiz', '__biz', 'biz')) || null,
    idx: articleIndex(row, url),
    title,
    article_url: url || null,
    published_at: dateTime(publishValue),
    read_num: readNum,
    read_num_capped: readNum === undefined ? undefined : Boolean(first(row, 'read_num_capped', 'readNumCapped') ?? readNum >= 100001),
    like_num: integerOrUndefined(first(row, 'like_num', 'likeNum', 'like')),
    look_num: integerOrUndefined(first(row, 'look_num', 'lookNum', 'look')),
    share_num: integerOrUndefined(first(row, 'share_num', 'shareNum', 'share')),
    comment_num: integerOrUndefined(first(row, 'comment_num', 'commentNum', 'comment')),
    is_original: original === undefined || original === null || original === '' ? undefined : Boolean(original),
    source_code: integerOrUndefined(first(row, 'source_code', 'sourceCode')),
    publisher: text(first(row, 'publisher', 'wx_name', 'wxName', 'account_name', 'name'))
  }
  return normalized
}

function accountNameForArticle(row) {
  return text(first(row, 'publisher', 'wx_name', 'wxName', 'account_name', 'name'))
}

function cleanArticleForSupabase(article, accountId) {
  const result = { wx_biz: article.wx_biz || null, account_id: accountId ?? null }
  for (const field of ARTICLE_FIELDS) {
    if (hasValue(article[field])) result[field] = article[field]
  }
  if (!hasValue(result.title)) result.title = ''
  if (!hasValue(result.article_sn)) result.article_sn = article.article_id
  return result
}

function decisionMap(report) {
  return new Map((report?.articles?.decisions || []).map(item => [text(item.article_id), item]))
}

export function buildSupabaseWriteSet({
  accountRows = [],
  articleRows = [],
  report = {},
  runDate = report.runDate || '',
  now = new Date().toISOString(),
  source = 'wxrank'
} = {}) {
  const collectedAt = dateTime(now) || now
  const merged = mergeAccountRows(accountRows, { source, collectedAt })
  const accountsByBiz = new Map(merged.rows.map(row => [row.wx_biz, { row, discoveredFromArticle: false }]))

  const normalizedArticles = articleRows.map(normalizeArticle)
  for (const article of normalizedArticles) {
    if (!article.wx_biz || accountsByBiz.has(article.wx_biz)) continue
    const row = normalizeAccountRow({ wx_biz: article.wx_biz, wx_name: article.publisher }, {
      source: 'article',
      collectedAt
    })
    accountsByBiz.set(article.wx_biz, { row, discoveredFromArticle: true })
  }

  const accounts = [...accountsByBiz.values()].map(({ row, discoveredFromArticle }) => ({
    wx_biz: row.wx_biz,
    discoveredFromArticle,
    account: accountPayload(row, collectedAt),
    profile: profilePayload(row, collectedAt)
  }))

  const decisions = decisionMap(report)
  const articles = normalizedArticles
    .filter(article => decisions.get(article.article_id)?.status === 'SELECTED')
    .map(article => cleanArticleForSupabase(article, null))

  const hotwords = (report?.hotwords?.rows || [])
    .filter(row => Number(row.article_count) >= 2)
    .map(row => ({
      hotword: text(row.word || row.hotword),
      aliases: Array.isArray(row.aliases) ? row.aliases : [],
      stat_date: dateOnly(row.stat_date, runDate),
      article_count: Math.trunc(Number(row.article_count)),
      article_keys: (row.article_keys || row.article_ids || []).map(item => text(item)).filter(Boolean),
      article_url: text(row.article_url || row.examples?.[0]) || null
    }))
    .filter(row => row.hotword && row.stat_date && row.article_count >= 2)

  return {
    migrationApplied: false,
    accounts,
    articles,
    hotwords,
    metadata: { source, runDate: dateOnly(runDate, now), now: collectedAt }
  }
}

function chunks(values, size = 200) {
  const result = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function inFilter(values) {
  return `in.(${values.map(value => encodeURIComponent(value)).join(',')})`
}

function responseRows(value) {
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.data)) return value.data
  return []
}

export function createSupabaseRestSink({ url, key, fetchImpl = globalThis.fetch } = {}) {
  if (!url) throw new TypeError('Supabase URL is required')
  if (!key) throw new TypeError('Supabase server key is required')
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  const baseUrl = String(url).replace(/\/+$/u, '')

  async function request(table, { method = 'GET', query = '', body, prefer = 'return=representation' } = {}) {
    const response = await fetchImpl(`${baseUrl}/rest/v1/${table}${query}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', Prefer: prefer })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    let payload = null
    if (typeof response.json === 'function') {
      try { payload = await response.json() } catch {}
    }
    if (!response.ok) {
      const detail = payload ? JSON.stringify(payload) : `${response.status || ''}`
      throw new Error(`Supabase ${method} ${table} failed: ${detail}`)
    }
    return payload
  }

  async function fetchAccounts(wxBizValues) {
    const result = []
    const fields = 'account_id,wx_biz,wx_name,verify,description,read_median,read_max,decision_status,decision_source,filter_rule_id,updated_at'
    for (const part of chunks(unique(wxBizValues))) {
      const payload = await request('accounts', { query: `?select=${fields}&wx_biz=${inFilter(part)}` })
      result.push(...responseRows(payload))
    }
    return result
  }

  async function fetchProfiles(accountIds) {
    const result = []
    for (const part of chunks(unique(accountIds.map(String)))) {
      const payload = await request('account_profiles', { query: `?select=*&account_id=${inFilter(part)}` })
      result.push(...responseRows(payload))
    }
    return result
  }

  async function postBatches(table, rows, query = '') {
    const result = []
    for (const part of chunks(rows)) {
      if (!part.length) continue
      const payload = await request(table, {
        method: 'POST',
        query,
        body: part,
        prefer: 'resolution=merge-duplicates,return=representation,missing=default'
      })
      result.push(...responseRows(payload))
    }
    return result
  }

  return {
    async write(writeSet) {
      const existingAccounts = await fetchAccounts(writeSet.accounts.map(item => item.wx_biz))
      const existingByBiz = new Map(existingAccounts.map(row => [row.wx_biz, row]))
      const accountPayloads = writeSet.accounts.map(item => {
        const existing = existingByBiz.get(item.wx_biz)
        const payload = { wx_biz: item.wx_biz }
        for (const field of ACCOUNT_FIELDS) payload[field] = hasValue(item.account[field]) ? item.account[field] : existing?.[field]
        payload.updated_at = item.account.updated_at || existing?.updated_at
        return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined))
      })
      const upsertedAccounts = await postBatches('accounts', accountPayloads, '?on_conflict=wx_biz')
      const accountByBiz = new Map([...existingAccounts, ...upsertedAccounts].map(row => [row.wx_biz, row.account_id]))
      if (accountByBiz.size < writeSet.accounts.length) {
        const refreshed = await fetchAccounts(writeSet.accounts.map(item => item.wx_biz))
        for (const row of refreshed) accountByBiz.set(row.wx_biz, row.account_id)
      }

      const existingProfiles = await fetchProfiles([...accountByBiz.values()])
      const existingProfileById = new Map(existingProfiles.map(row => [String(row.account_id), row]))
      const profiles = writeSet.accounts.map(item => {
        const accountId = accountByBiz.get(item.wx_biz)
        if (!accountId) throw new Error(`Supabase account_id not found for wx_biz ${item.wx_biz}`)
        const existing = existingProfileById.get(String(accountId)) || {}
        const payload = { account_id: accountId }
        for (const field of Object.keys(PROFILE_FIELD_MAP).map(key => PROFILE_FIELD_MAP[key])) {
          const incoming = item.profile[field]
          payload[field] = hasValue(incoming) ? incoming : existing[field]
        }
        return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined))
      })
      await postBatches('account_profiles', profiles, '?on_conflict=account_id')

      const articles = writeSet.articles.map(article => ({
        ...article,
        account_id: article.wx_biz ? accountByBiz.get(article.wx_biz) || null : null
      })).map(({ wx_biz, ...article }) => article)
      await postBatches('articles', articles, '?on_conflict=account_id,article_sn')
      await postBatches('hotwords', writeSet.hotwords, '?on_conflict=hotword,stat_date')

      return {
        accountCount: writeSet.accounts.length,
        profileCount: profiles.length,
        articleCount: articles.length,
        hotwordCount: writeSet.hotwords.length,
        jobId: null,
        jobTracking: { available: false, code: 'CAPABILITY_UNAVAILABLE', reason: 'jobs and job_steps are not part of the configured six-table schema' }
      }
    }
  }
}

export { ARTICLE_FIELDS, ACCOUNT_FIELDS, PROFILE_FIELD_MAP }
