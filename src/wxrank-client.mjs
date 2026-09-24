const DEFAULT_BASE_URL = 'https://wxrank.com'

function endpoint(baseUrl, path) {
  return `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/u, '')}${path}`
}

async function readJson(response, label) {
  const status = Number(response?.status || 0)
  if (status !== 200) throw new Error(`${label} returned HTTP ${status}`)
  const body = await response.json()
  if (!body || Number(body.code) !== 0) throw new Error(`${label} returned code ${body?.code ?? 'missing'}`)
  return body
}

function listFromBody(body) {
  const candidates = [body?.data?.list, body?.data?.rows, body?.data?.data, body?.list, body?.rows, body?.data]
  return candidates.find(candidate => Array.isArray(candidate)) || []
}

export async function fetchAccountSources({
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  headers = {},
  range = '30d',
  page = 1
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  const commonHeaders = { accept: 'application/json', ...headers }
  const rankResponse = await fetchImpl(endpoint(baseUrl, `/api/rank/account?range=${encodeURIComponent(range)}&page=${page}`), {
    method: 'GET',
    headers: commonHeaders
  })
  const rankBody = await readJson(rankResponse, 'rank account')
  const searchResponse = await fetchImpl(endpoint(baseUrl, '/api/search/account'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...commonHeaders },
    body: JSON.stringify({ range })
  })
  const searchBody = await readJson(searchResponse, 'search account')
  return {
    rank: rankBody,
    search: searchBody,
    rows: [
      ...listFromBody(rankBody).map(row => ({ ...row, source: row.source || 'rank' })),
      ...listFromBody(searchBody).map(row => ({ ...row, source: row.source || 'search' }))
    ]
  }
}

function rankedArticleList(body) {
  const candidates = [
    body?.data?.list,
    body?.data?.rows,
    body?.data?.articles,
    body?.data?.records,
    body?.data?.items,
    body?.data?.result?.list,
    body?.data?.data,
    body?.result?.list,
    body?.result?.rows,
    body?.items,
    body?.list,
    body?.rows,
    body?.articles,
    body?.records,
    body?.data
  ]
  return candidates.find(candidate => Array.isArray(candidate)) ?? null
}

async function fetchRankedArticleSource({ fetchImpl, url, headers, source, timeoutMs }) {
  let response
  let body
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || 15_000))
  try {
    response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal })
    if (Number(response?.status || 0) === 401 || Number(response?.status || 0) === 403) {
      return { source, status: 'failed', error_code: 'AUTH_ERROR', message: `${source} returned HTTP ${Number(response.status)}`, rows: [], response: null }
    }
    if (!response?.ok) {
      return { source, status: 'failed', error_code: Number(response?.status) === 429 ? 'RATE_LIMIT' : 'HTTP_ERROR', message: `${source} returned HTTP ${Number(response?.status || 0)}`, rows: [], response: null }
    }
    try { body = await response.json() } catch {
      return { source, status: 'failed', error_code: 'OUTPUT_SCHEMA_INVALID', message: `${source} response is not JSON`, rows: [], response: null }
    }
    if (body?.success === false || (body?.code !== undefined && ![0, '0', 200, '200', 'OK', 'ok', 'SUCCESS', 'success'].includes(body.code))) {
      return { source, status: 'failed', error_code: 'API_BUSINESS_ERROR', message: String(body?.msg || body?.message || `${source} returned code ${body.code}`), rows: [], response: body }
    }
    const rows = rankedArticleList(body)
    if (!rows) {
      return { source, status: 'failed', error_code: 'OUTPUT_SCHEMA_INVALID', message: `${source} response does not contain an article list`, rows: [], response: body }
    }
    if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
      return { source, status: 'failed', error_code: 'OUTPUT_SCHEMA_INVALID', message: `${source} article list contains invalid rows`, rows: [], response: body }
    }
    return { source, status: 'success', error_code: null, message: 'ok', rows, response: body }
  } catch (error) {
    const timedOut = controller.signal.aborted
    return { source, status: 'failed', error_code: timedOut ? 'UPSTREAM_TIMEOUT' : 'HTTP_ERROR', message: timedOut ? `${source} timed out after ${timeoutMs}ms` : (error?.message || `${source} request failed`), rows: [], response: null }
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function fetchRankedArticleSources({
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  headers = {},
  range = '7d',
  page = 1,
  timeoutMs = 15_000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  const parsedPage = Number(page)
  if (!Number.isSafeInteger(parsedPage) || parsedPage < 1) throw new TypeError('page must be a positive integer')
  const query = new URLSearchParams({ range: String(range || '7d'), page: String(parsedPage) })
  const commonHeaders = { accept: 'application/json', ...headers }
  const sources = await Promise.all([
    fetchRankedArticleSource({ fetchImpl, url: endpoint(baseUrl, `/api/rank/viral?${query}`), headers: commonHeaders, source: 'viral', timeoutMs }),
    fetchRankedArticleSource({ fetchImpl, url: endpoint(baseUrl, `/api/rank/article?${query}`), headers: commonHeaders, source: 'article', timeoutMs })
  ])
  const rows = sources.flatMap(result => result.status === 'success'
    ? result.rows.map(row => ({ ...row, rank_source: result.source }))
    : [])
  return {
    status: sources.every(result => result.status === 'success') ? 'success' : sources.some(result => result.status === 'success') ? 'partial' : 'failed',
    sources,
    rows,
    errors: sources.filter(result => result.status !== 'success').map(({ source, error_code, message }) => ({ source, code: error_code, message })),
    request_count: sources.length
  }
}

export { DEFAULT_BASE_URL }
