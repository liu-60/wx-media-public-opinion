import { loadCollectorEnvironment } from '../collector-config.mjs'

const DEFAULT_ENDPOINT = loadCollectorEnvironment().WXRANK_API_URL || 'https://data.wxrank.com/weixin/artlist'
export const DEFAULT_SEARCH_ENDPOINT = loadCollectorEnvironment().WXRANK_SEARCH_API_URL || 'https://data.wxrank.com/weixin/getso'

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim()
}

function safeRequest(payload) {
  const key = text(payload?.key)
  return { ...payload, key: key ? `已加载 ****${key.slice(-4)}` : '未加载' }
}

export function classifyWxRankArticleResponse({ httpStatus = 0, body = null, responseParseError = false } = {}) {
  if (responseParseError || typeof body === 'string') return { code: 'OUTPUT_SCHEMA_INVALID', status: 'failed', message: 'WxRank artlist response is not JSON' }
  if (httpStatus === 401 || httpStatus === 403) return { code: 'AUTH_ERROR', status: 'failed', message: `WxRank HTTP ${httpStatus}` }
  if (httpStatus === 429) return { code: 'RATE_LIMIT', status: 'failed', message: 'WxRank rate limit' }
  if (httpStatus < 200 || httpStatus >= 300) return { code: 'HTTP_ERROR', status: 'failed', message: `WxRank HTTP ${httpStatus}` }
  if (Number(body?.code) !== 0) {
    const message = text(body?.msg || body?.message || `business code ${body?.code ?? 'missing'}`)
    if (/积分|余额|balance|quota|credit/iu.test(message)) return { code: 'BALANCE_INSUFFICIENT', status: 'failed', message }
    return { code: 'API_BUSINESS_ERROR', status: 'failed', message }
  }
  const data = body?.data
  if (!data || !Array.isArray(data.list)) return { code: 'OUTPUT_SCHEMA_INVALID', status: 'failed', message: 'WxRank artlist data.list is missing' }
  if (!data.list.length) return { code: 'EMPTY_RESULT', status: 'failed', message: 'WxRank artlist returned no rows' }
  return { code: 'OK', status: 'success', message: 'ok' }
}

export async function fetchWxRankArticleList({
  apiKey = loadCollectorEnvironment().WXRANK_API_KEY,
  endpoint = loadCollectorEnvironment().WXRANK_API_URL || DEFAULT_ENDPOINT,
  date,
  month,
  wxBiz,
  minReadNum,
  maxReadNum,
  keyword,
  wxType,
  cursor,
  timeoutMs = 15_000,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!apiKey) return { status: 'waiting_auth', error_code: 'AUTH_ERROR', message: 'WXRANK_API_KEY is required', request_count: 0, data: { cursor: null, total: 0, list: [] } }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  const payload = { key: apiKey }
  for (const [key, value] of Object.entries({ date, month, wx_biz: wxBiz, min_read_num: minReadNum, max_read_num: maxReadNum, keyword, wx_type: wxType, cursor })) {
    if (value !== undefined && value !== null && value !== '') payload[key] = value
  }
  let response
  let body = null
  let parseError = false
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || 15_000))
  try {
    response = await fetchImpl(endpoint, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: controller.signal })
    try { body = await response.json() } catch { parseError = true }
  } catch (error) {
    return { status: 'failed', error_code: controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'HTTP_ERROR', message: controller.signal.aborted ? `WxRank artlist timed out after ${timeoutMs}ms` : (error?.message || 'WxRank artlist request failed'), request_count: 1, request: safeRequest(payload), data: { cursor: null, total: 0, list: [] } }
  } finally {
    clearTimeout(timeoutId)
  }
  const classification = classifyWxRankArticleResponse({ httpStatus: Number(response?.status || 0), body, responseParseError: parseError })
  if (classification.status !== 'success') {
    if (classification.code === 'EMPTY_RESULT') return { status: 'success', error_code: 'EMPTY_RESULT', message: classification.message, request_count: 1, request: safeRequest(payload), response: body, data: body.data }
    return { status: classification.code === 'AUTH_ERROR' ? 'waiting_auth' : 'failed', error_code: classification.code, message: classification.message, request_count: 1, request: safeRequest(payload), response: body, data: { cursor: null, total: 0, list: [] } }
  }
  return { status: 'success', error_code: null, message: 'ok', request_count: 1, request: safeRequest(payload), response: body, data: body.data }
}

function cleanHighlight(value) { return text(value).replace(/<\/?em\b[^>]*>/giu, '') }

function wxRankSearchDate(value) {
  const raw = text(value)
  if (!raw) return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/u.test(raw) ? `${raw.replace(' ', 'T')}+08:00` : raw
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export async function fetchWxRankSearchArticles({
  apiKey = loadCollectorEnvironment().WXRANK_API_KEY,
  endpoint = loadCollectorEnvironment().WXRANK_SEARCH_API_URL || DEFAULT_SEARCH_ENDPOINT,
  keyword,
  sortType = 2,
  page = 1,
  timeoutMs = 15_000,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!apiKey) return { status: 'waiting_auth', error_code: 'AUTH_ERROR', message: 'WXRANK_API_KEY is required', request_count: 0, rows: [] }
  const normalizedKeyword = text(keyword)
  if (!normalizedKeyword) return { status: 'failed', error_code: 'INVALID_ARGUMENT', message: 'WxRank 搜索关键词不能为空', request_count: 0, rows: [] }
  if (!Number.isSafeInteger(Number(page)) || Number(page) < 1) return { status: 'failed', error_code: 'INVALID_ARGUMENT', message: 'WxRank 搜索页码必须是正整数', request_count: 0, rows: [] }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || 15_000))
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ key: apiKey, keyword: normalizedKeyword, sort_type: String(sortType), page: Number(page) }),
      signal: controller.signal
    })
    let body
    try { body = await response.json() } catch {
      return { status: 'failed', error_code: 'OUTPUT_SCHEMA_INVALID', message: 'WxRank 搜一搜响应不是 JSON', request_count: 1, rows: [], raw: null }
    }
    if (!response.ok) return { status: response.status === 401 || response.status === 403 ? 'waiting_auth' : 'failed', error_code: response.status === 429 ? 'RATE_LIMIT' : 'HTTP_ERROR', message: `WxRank 搜一搜 HTTP ${response.status}`, request_count: 1, rows: [], raw: body }
    if (Number(body?.code) !== 0) {
      const message = text(body?.msg || body?.message || `code=${body?.code ?? 'missing'}`)
      return { status: 'failed', error_code: 'API_BUSINESS_ERROR', message, request_count: 1, rows: [], raw: body }
    }
    if (!Array.isArray(body?.data)) return { status: 'failed', error_code: 'OUTPUT_SCHEMA_INVALID', message: 'WxRank 搜一搜 data 必须是数组', request_count: 1, rows: [], raw: body }
    const rows = body.data.map(row => {
      const url = text(row?.art_url || row?.article_url || row?.url)
      let wxBiz = text(row?.wx_biz || row?.wxBiz)
      let articleSn = text(row?.article_sn || row?.articleSn || row?.sn)
      let idx = Number(row?.idx || 1)
      try {
        const parsed = new URL(url)
        wxBiz ||= text(parsed.searchParams.get('__biz'))
        articleSn ||= text(parsed.searchParams.get('sn'))
        idx = Number(parsed.searchParams.get('idx')) || idx
      } catch {}
      return {
        ...row,
        title: cleanHighlight(row?.title),
        content: cleanHighlight(row?.desc || row?.summary),
        wx_name: text(row?.wx_name),
        wx_biz: wxBiz || null,
        article_sn: articleSn || null,
        idx,
        article_url: url || null,
        published_at: wxRankSearchDate(row?.pub_time || row?.publish_time),
        source_platform: 'wxrank',
        collect_reasons: [`hotword:${normalizedKeyword}`]
      }
    })
    return { status: 'success', error_code: null, message: 'ok', request_count: 1, rows, has_more: rows.length > 0, raw: body }
  } catch (error) {
    return { status: 'failed', error_code: controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'HTTP_ERROR', message: controller.signal.aborted ? `WxRank 搜一搜超时 ${timeoutMs}ms` : (error?.message || 'WxRank 搜一搜请求失败'), request_count: 1, rows: [], raw: null }
  } finally { clearTimeout(timer) }
}

export { DEFAULT_ENDPOINT }

function searchNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const raw = text(value).replaceAll(',', '')
  const match = /^(\d+(?:\.\d+)?)\s*(万|w)?\+?$/iu.exec(raw)
  return match ? Math.trunc(Number(match[1]) * (match[2] ? 10_000 : 1)) + (raw.endsWith('+') ? 1 : 0) : null
}

export async function fetchWxRankKeywordArticles({ apiKey = loadCollectorEnvironment().WXRANK_API_KEY, keyword, month, fetchImpl = globalThis.fetch } = {}) {
  const word = text(keyword)
  if (!word) return { status: 'failed', error_code: 'INVALID_ARGUMENT', message: 'WxRank 搜索关键词不能为空', request_count: 0, rows: [] }
  if (!/^20\d{4}$/u.test(text(month)) || Number(text(month).slice(4)) < 1 || Number(text(month).slice(4)) > 12) {
    return { status: 'failed', error_code: 'INVALID_ARGUMENT', message: 'WxRank 搜索月份必须是 YYYYMM', request_count: 0, rows: [] }
  }
  const result = await fetchWxRankArticleList({ apiKey, month, keyword: word, fetchImpl })
  if (result.status !== 'success') return { ...result, rows: [], raw: result.response || null }
  const rows = (result.data?.list || []).map(row => {
    const articleUrl = text(row.art_url || row.article_url || row.url)
    let url
    try { url = new URL(articleUrl) } catch {}
    return {
      title: cleanHighlight(row.title),
      content: cleanHighlight(row.desc || row.summary || row.content),
      wx_name: text(row.wx_name || row.wxName || row.userName) || null,
      wx_biz: text(row.wx_biz || row.wxBiz || url?.searchParams.get('__biz')) || null,
      article_sn: text(row.article_sn || row.sn || url?.searchParams.get('sn')) || null,
      mid: text(row.mid || url?.searchParams.get('mid')) || null,
      idx: Number(row.idx || url?.searchParams.get('idx')) || 1,
      article_url: articleUrl || null,
      published_at: wxRankSearchDate(row.pub_time || row.publish_time || row.published_at),
      read_num: searchNumber(row.read_num ?? row.readNum),
      read_num_capped: /\+$/u.test(text(row.read_num ?? row.readNum)),
      like_num: searchNumber(row.like_num ?? row.likeNum),
      look_num: searchNumber(row.look_num ?? row.lookNum),
      share_num: searchNumber(row.share_num ?? row.shareNum),
      comment_num: searchNumber(row.comment_num ?? row.commentNum),
      is_original: row.is_original === undefined ? null : Boolean(row.is_original),
      source_platform: 'wxrank'
    }
  })
  return { status: 'success', error_code: result.error_code, message: result.message, request_count: result.request_count, rows, total: result.data?.total ?? null, has_more: Boolean(result.data?.cursor), raw: result.response || null }
}
