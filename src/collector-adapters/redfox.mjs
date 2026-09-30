import { loadCollectorEnvironment } from '../collector-config.mjs'

const REDFOX_BASE = loadCollectorEnvironment().REDFOX_API_URL || 'https://redfox.hk'
export const REDFOX_SEARCH_ENDPOINT = REDFOX_BASE + '/story/api/gzhData/searchArticle'

const rankBodyForRange = (startDate, endDate) => ({ type: '总排名', startDate, endDate })

export const REDFOX_GZH_SOURCES = Object.freeze([
  Object.freeze({ no: 'ZIGAGYYT', name: '公众号10W+文章推荐', endpoint: REDFOX_BASE + '/story/api/cozeSkill/getTenWReadingRank', type: 'article-rank', price: 0.04, bodyForDate: date => rankBodyForRange(date, date), bodyForRange: rankBodyForRange }),
  Object.freeze({ no: 'OFFSPQ0U', name: '公众号原创爆款文章推荐', endpoint: REDFOX_BASE + '/story/api/cozeSkill/getOriginalRank', type: 'article-rank', price: 0.04, bodyForDate: date => rankBodyForRange(date, date), bodyForRange: rankBodyForRange }),
  Object.freeze({ no: 'API_1789637464311', name: '公众号头条增长榜', endpoint: REDFOX_BASE + '/story/api/gzh/heima/rankList', type: 'account-growth-rank', price: 0.04, bodyForDate: date => ({ page: 1, rank_date: date + ' 00:00:00', author_type: '人文资讯' }) })
])

function text(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function first(row, keys) {
  for (const key of keys) if (Object.hasOwn(row, key) && row[key] !== undefined && row[key] !== null) return row[key]
  return undefined
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  const raw = text(value).replaceAll(',', '')
  const capped = /^(\d+(?:\.\d+)?)(w|万)\+$/iu.exec(raw)
  if (capped) return Math.trunc(Number(capped[1]) * 10_000) + 1
  if (/^100000\+$/u.test(raw)) return 100001
  const number = Number(raw.replace(/\+$/u, ''))
  return Number.isFinite(number) ? Math.trunc(number) : null
}

function dateTime(value) {
  if (value === undefined || value === null || value === '') return null
  const raw = text(value)
  if (/^\d{10,13}$/u.test(raw)) {
    const date = new Date(Number(raw) < 10_000_000_000 ? Number(raw) * 1000 : Number(raw))
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  const withZone = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/u.test(raw) ? `${raw.replace(' ', 'T')}+08:00` : raw
  const date = new Date(withZone)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function urlFields(value) {
  try {
    const url = new URL(text(value))
    const sn = text(url.searchParams.get('sn'))
    const wxBiz = text(url.searchParams.get('__biz'))
    const mid = text(url.searchParams.get('mid'))
    const idxValue = Number(url.searchParams.get('idx'))
    return { sn, wxBiz, mid, idx: Number.isSafeInteger(idxValue) && idxValue > 0 ? idxValue : 1 }
  } catch {
    return { sn: '', wxBiz: '', mid: '', idx: 1 }
  }
}

export function normalizeRedfoxRows(rows = []) {
  if (!Array.isArray(rows)) throw new TypeError('RedFox rows must be an array')
  return normalizeRedfoxRowsDetailed(rows).rows
}

export function normalizeRedfoxRowsDetailed(rows = []) {
  if (!Array.isArray(rows)) throw new TypeError('RedFox rows must be an array')
  const errors = []
  const normalized = []
  rows.forEach((row, index) => {
    try {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('RedFox row must be an object')
    const articleUrl = text(first(row, ['oriUrl', 'ori_url', 'article_url', 'workUrl', 'work_url', 'url', 'link']))
    const url = urlFields(articleUrl)
    const articleSn = text(first(row, ['article_sn', 'articleSn', 'sn'])) || url.sn
    const readRaw = first(row, ['read_num', 'readNum', 'read', 'readCount', 'clicksCount', 'click_count'])
    const readNum = numberOrNull(readRaw)
    const originalRaw = first(row, ['is_original', 'isOriginal', 'original'])
    const original = originalRaw === undefined || originalRaw === null || originalRaw === '' ? null : !['false', '0', '否', 'no'].includes(String(originalRaw).toLowerCase())
    const result = {
      title: text(first(row, ['title', 'articleTitle', 'name'])),
      content: text(first(row, ['content', 'text', 'html', 'summary'])),
      account_id: text(first(row, ['accountId', 'account_id'])) || null,
      wx_biz: text(first(row, ['wx_biz', 'wxBiz', '__biz', 'biz'])) || url.wxBiz || null,
      article_sn: articleSn || null,
      mid: text(first(row, ['mid', 'article_mid'])) || url.mid || null,
      idx: url.idx,
      article_url: articleUrl || null,
      published_at: dateTime(first(row, ['published_at', 'publishedAt', 'publishTime', 'publish_time', 'publicTime', 'date'])),
      read_num: readNum,
      read_num_capped: /(?:\d+(?:\.\d+)?w\+|\d+(?:\.\d+)?万\+|100000\+)/iu.test(text(readRaw)),
      like_num: numberOrNull(first(row, ['like_num', 'likeNum', 'like', 'likeCount'])),
      look_num: numberOrNull(first(row, ['look_num', 'lookNum', 'look', 'lookCount'])),
      share_num: numberOrNull(first(row, ['share_num', 'shareNum', 'share', 'shareCount'])),
      comment_num: numberOrNull(first(row, ['comment_num', 'commentNum', 'comment', 'commentCount'])),
      is_original: original,
      order_num: numberOrNull(first(row, ['orderNum', 'order_num'])),
      source_type: text(first(row, ['type', 'source_type'])) || null,
      publisher: text(first(row, ['userName', 'user_name', 'publisher'])),
      source_no: text(row.source_no || row.sourceNo || '') || null,
      raw: row
    }
      if (!result.article_sn || !result.wx_biz || !result.published_at) {
        errors.push({ index, code: !result.article_sn || !result.wx_biz ? 'IDENTITY_OR_URL_MISSING' : 'PUBLISHED_AT_INVALID', message: !result.article_sn || !result.wx_biz ? 'article_sn or wx_biz is missing' : 'published_at is missing or invalid', raw: row })
        return
      }
      normalized.push(result)
    } catch (error) {
      errors.push({ index, code: 'INVALID_DATA', message: error.message, raw: row })
    }
  })
  return { rows: normalized, errors }
}

export function extractRedfoxRows(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  if (Array.isArray(payload.data)) return payload.data
  for (const key of ['list', 'rows', 'records', 'data']) if (Array.isArray(payload.data?.[key])) return payload.data[key]
  for (const value of Object.values(payload.data || {})) if (Array.isArray(value)) return value
  return []
}

export function classifyRedfoxResponse({ httpStatus = 0, body = null, responseParseError = false } = {}) {
  if (responseParseError || typeof body === 'string') return { code: 'INVALID_DATA', status: 'failed', message: 'response JSON is invalid' }
  if (httpStatus < 200 || httpStatus >= 300) return { code: 'HTTP_ERROR', status: 'failed', message: `HTTP ${httpStatus}` }
  if (Number(body?.code) !== 2000) return { code: 'BUSINESS_ERROR', status: 'failed', message: text(body?.msg || body?.message || `business code ${body?.code ?? 'missing'}`) }
  if (!extractRedfoxRows(body).length) return { code: 'EMPTY_RESULT', status: 'failed', message: 'response contains no rows' }
  return { code: 'OK', status: 'success', message: 'ok' }
}

function dateMinusDays(date, days) {
  const value = new Date(date + 'T00:00:00Z')
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

function validateDate(value, name) {
  const date = String(value ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || new Date(date + 'T00:00:00.000Z').toISOString().slice(0, 10) !== date) {
    throw new TypeError(name + ' must use a valid YYYY-MM-DD date')
  }
  return date
}

export async function fetchRedfoxSources({ apiKey = loadCollectorEnvironment().REDFOX_API_KEY, targetDate, startDate, endDate, lookbackDays = 2, sourceNos = ['ZIGAGYYT', 'OFFSPQ0U'], fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) return { status: 'waiting_auth', error_code: 'AUTH_REQUIRED', message: 'REDFOX_API_KEY is required', request_count: 0, sources: [], rows: [] }
  const hasExplicitRange = startDate !== undefined || endDate !== undefined
  let requestedDate = null
  let requestedStartDate = null
  let requestedEndDate = null
  let dateRanges
  if (hasExplicitRange) {
    requestedStartDate = validateDate(startDate, 'startDate')
    requestedEndDate = validateDate(endDate, 'endDate')
    if (requestedStartDate > requestedEndDate) throw new TypeError('startDate must be on or before endDate')
    dateRanges = [{ startDate: requestedStartDate, endDate: requestedEndDate }]
  } else {
    requestedDate = validateDate(targetDate, 'targetDate')
    if (!Number.isSafeInteger(lookbackDays) || lookbackDays < 0 || lookbackDays > 31) throw new TypeError('lookbackDays must be an integer from 0 to 31')
    requestedStartDate = requestedDate
    requestedEndDate = requestedDate
    dateRanges = Array.from({ length: lookbackDays + 1 }, (_, offset) => {
      const date = dateMinusDays(requestedDate, offset)
      return { startDate: date, endDate: date }
    })
  }
  const sources = []
  const rawSources = []
  const rows = []
  const errors = []
  let requestCount = 0
  const currentBase = (loadCollectorEnvironment().REDFOX_API_URL || REDFOX_BASE).replace(/\/+$/u, '')
  const selectedSources = REDFOX_GZH_SOURCES.filter(source => sourceNos.includes(source.no)).map(source => ({ ...source, endpoint: source.endpoint.startsWith(REDFOX_BASE) ? currentBase + source.endpoint.slice(REDFOX_BASE.length) : source.endpoint }))
  for (const source of selectedSources) {
    let selected = null
    for (const range of dateRanges) {
      const { startDate: rangeStartDate, endDate: rangeEndDate } = range
      requestCount += 1
      let body = null
      let httpStatus = 0
      let parseError = false
      try {
        const requestBody = source.bodyForRange ? source.bodyForRange(rangeStartDate, rangeEndDate) : source.bodyForDate(rangeEndDate)
        const response = await fetchImpl(source.endpoint, { method: 'POST', headers: { REDFOX_API_KEY: apiKey, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(requestBody) })
        httpStatus = Number(response?.status || 0)
        try { body = await response.json() } catch { parseError = true }
      } catch (error) {
        selected = { no: source.no, date: rangeEndDate, start_date: rangeStartDate, end_date: rangeEndDate, code: 'HTTP_ERROR', status: 'failed', message: text(error?.message || 'request failed') }
        break
      }
      const classification = classifyRedfoxResponse({ httpStatus, body, responseParseError: parseError })
      if (classification.status === 'success') {
        const detail = normalizeRedfoxRowsDetailed(extractRedfoxRows(body))
        const normalized = detail.rows.map(row => ({ ...row, source_no: source.no }))
        const sourceErrors = detail.errors.map(error => ({ ...error, source_no: source.no }))
        selected = { no: source.no, date: rangeEndDate, start_date: rangeStartDate, end_date: rangeEndDate, code: normalized.length ? 'OK' : 'INVALID_DATA', status: normalized.length ? 'success' : 'failed', row_count: normalized.length, rows: normalized, errors: sourceErrors, body }
        rows.push(...normalized)
        errors.push(...sourceErrors)
        break
      }
      selected = { no: source.no, date: rangeEndDate, start_date: rangeStartDate, end_date: rangeEndDate, code: classification.code, status: 'failed', message: classification.message, body }
      if (!['BUSINESS_ERROR', 'EMPTY_RESULT'].includes(classification.code)) break
    }
    rawSources.push(selected)
    sources.push({ ...selected, body: undefined })
  }
  const failed = sources.filter(item => item.status !== 'success')
  return { status: failed.length ? (failed.length === sources.length ? 'failed' : 'partial') : 'success', request_count: requestCount, requested_range: { start_date: requestedStartDate, end_date: requestedEndDate }, requested_date: requestedDate, sources, raw_sources: rawSources, rows, errors, message: failed.length ? String(failed.length) + ' RedFox source(s) failed' : 'ok' }
}

export async function fetchRedfoxKeywordArticles({ apiKey = loadCollectorEnvironment().REDFOX_API_KEY, endpoint = `${(loadCollectorEnvironment().REDFOX_API_URL || REDFOX_BASE).replace(/\/+$/u, '')}/story/api/gzhData/searchArticle`, keyword, offset = 0, sortType = '_4', exactMatch = true, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) return { status: 'waiting_auth', error_code: 'AUTH_REQUIRED', message: 'REDFOX_API_KEY is required', request_count: 0, rows: [] }
  const normalizedKeyword = text(keyword)
  if (!normalizedKeyword) return { status: 'failed', error_code: 'INVALID_ARGUMENT', message: 'RedFox 搜索关键词不能为空', request_count: 0, rows: [] }
  if (!Number.isSafeInteger(Number(offset)) || Number(offset) < 0) return { status: 'failed', error_code: 'INVALID_ARGUMENT', message: 'RedFox 搜索 offset 必须是非负整数', request_count: 0, rows: [] }
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { REDFOX_API_KEY: apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ keyword: normalizedKeyword, offset: Number(offset), sortType, exactMatch: exactMatch === true })
    })
    let body
    try { body = await response.json() } catch { return { status: 'failed', error_code: 'INVALID_DATA', message: 'RedFox 搜索响应不是 JSON', request_count: 1, rows: [], raw: null } }
    if (!response.ok || Number(body?.code) !== 2000) {
      return { status: 'failed', error_code: !response.ok ? 'HTTP_ERROR' : 'BUSINESS_ERROR', message: text(body?.msg || body?.message || `HTTP ${response.status} / code=${body?.code ?? 'missing'}`), request_count: 1, rows: [], raw: body }
    }
    const list = Array.isArray(body?.data?.list) ? body.data.list : []
    const detail = normalizeRedfoxRowsDetailed(list.map(row => ({ ...row, source_no: 'SEARCH', read_num: row.read_num ?? row.readCount, look_num: row.look_num ?? row.watchCount, userName: row.userName ?? row.author, oriUrl: row.oriUrl ?? row.workUrl ?? row.sourceUrl })))
    const rows = detail.rows.map(({ raw, ...row }) => ({ ...row, wx_name: text(first(raw, ['wx_name', 'wxName', 'userName', 'user_name', 'author', 'publisher'])) || row.publisher || null, source_platform: 'redfox' }))
    return { status: 'success', error_code: null, message: 'ok', request_count: 1, rows, errors: detail.errors, total: Number(body?.data?.total) || null, has_more: body?.data?.hasMore === true, raw: body }
  } catch (error) {
    return { status: 'failed', error_code: 'HTTP_ERROR', message: text(error?.message || 'RedFox 搜索请求失败'), request_count: 1, rows: [], raw: null }
  }
}
