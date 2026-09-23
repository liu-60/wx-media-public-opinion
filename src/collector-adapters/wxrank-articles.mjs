const DEFAULT_ENDPOINT = 'https://data.wxrank.com/weixin/artlist'

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
  apiKey = process.env.WXRANK_API_KEY,
  endpoint = DEFAULT_ENDPOINT,
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
    response = await fetchImpl(endpoint, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal })
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

export { DEFAULT_ENDPOINT }
