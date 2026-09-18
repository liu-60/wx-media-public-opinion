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

export { DEFAULT_BASE_URL }
