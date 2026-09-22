import http from 'node:http'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSupabaseClient } from './services/supabase.mjs'
import { createAccountsArticlesService } from './services/accounts-articles.mjs'
import { createRulesHotwordsStrategiesService } from './services/rules-hotwords-strategies.mjs'

const MAX_BODY_BYTES = 1024 * 1024
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(MODULE_DIR, 'public')
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u

function responsePayload(error, fallbackCode = 'INTERNAL_ERROR') {
  const rawStatus = Number(error?.status)
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 503
  const rawCode = typeof error?.code === 'string' ? error.code : fallbackCode
  const code = SAFE_ERROR_CODE.test(rawCode) ? rawCode : fallbackCode
  const clientError = status >= 400 && status < 500
  return { status, body: { error: clientError ? 'Invalid request' : 'Service unavailable', code, details: null } }
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(JSON.stringify(body))
}

function allowedHost(request, host) {
  const localPort = request.socket.localPort
  return request.headers.host === `${host}:${localPort}`
}

async function readJsonBody(request) {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    const error = new Error()
    error.status = 413
    error.code = 'BODY_TOO_LARGE'
    throw error
  }
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error()
      error.status = 413
      error.code = 'BODY_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch {
    const error = new Error()
    error.status = 400
    error.code = 'INVALID_JSON'
    throw error
  }
}

function unavailableService() {
  const unavailable = async () => {
    const error = new Error()
    error.status = 503
    error.code = 'NOT_CONFIGURED'
    throw error
  }
  return Object.freeze({
    ping: async () => ({ ready: false, status: 'not_configured' }),
    summary: unavailable,
    listAccounts: unavailable,
    listStrategyAccounts: unavailable,
    getAccount: unavailable,
    patchAccountDecision: unavailable,
    bulkAccountDecision: unavailable,
    patchAccountTags: unavailable,
    listArticles: unavailable,
    getArticle: unavailable,
    deleteArticle: unavailable,
    bulkDeleteArticles: unavailable,
    listRules: unavailable,
    listRuleGroups: unavailable,
    saveRuleGroup: unavailable,
    createRule: unavailable,
    updateRule: unavailable,
    deleteRule: unavailable,
    listHotwords: unavailable,
    listStrategyKeywords: unavailable,
    getHotword: unavailable,
    updateHotword: unavailable,
    deleteHotword: unavailable,
    mergePreview: unavailable,
    previewHotwordMerge: unavailable,
    merge: unavailable,
    mergeHotwords: unavailable,
    listStrategies: unavailable,
    getStrategy: unavailable,
    createStrategy: unavailable,
    updateStrategy: unavailable,
    deleteStrategy: unavailable,
    executionCapability: unavailable,
    executeStrategy: unavailable
  })
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    const error = new Error()
    error.status = 400
    error.code = 'INVALID_ID'
    throw error
  }
}

function defaultService() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return unavailableService()
  const client = createSupabaseClient({ url, key })
  return Object.freeze({
    ...createAccountsArticlesService({ client }),
    ...createRulesHotwordsStrategiesService({ client }),
    ping: client.ping,
    summary: client.summary
  })
}

async function serveStatic(request, response, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1)
  const target = path.resolve(PUBLIC_DIR, relativePath)
  if (!target.startsWith(`${PUBLIC_DIR}${path.sep}`) && target !== path.join(PUBLIC_DIR, 'index.html')) {
    response.writeHead(404)
    response.end('Not found')
    return
  }
  try {
    const publicRoot = await realpath(PUBLIC_DIR)
    const resolvedTarget = await realpath(target)
    if (!resolvedTarget.startsWith(`${publicRoot}${path.sep}`)) {
      response.writeHead(404)
      response.end('Not found')
      return
    }
    const body = await readFile(resolvedTarget)
    const extension = path.extname(resolvedTarget)
    const contentType = extension === '.html' ? 'text/html; charset=utf-8' : extension === '.css' ? 'text/css; charset=utf-8' : ['.js', '.mjs', '.ts'].includes(extension) ? 'text/javascript; charset=utf-8' : 'application/octet-stream'
    response.writeHead(200, { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff' })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end('Not found')
  }
}

export function createManagementServer({ service = defaultService(), token = process.env.MANAGEMENT_TOKEN || '', host = '127.0.0.1', port = 4173 } = {}) {
  if (host !== '127.0.0.1') throw new TypeError('Management server must bind to 127.0.0.1')
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid management port')
  if (!service || typeof service.ping !== 'function' || typeof service.summary !== 'function') throw new TypeError('Management service is required')

  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', `http://${host}`)
    const isApi = requestUrl.pathname.startsWith('/api/')
    if (!isApi) return serveStatic(request, response, requestUrl.pathname)
    if (!allowedHost(request, host)) return sendJson(response, 403, { error: 'Invalid request', code: 'HOST_NOT_ALLOWED', details: null })

    const method = String(request.method || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      if (!token || request.headers['x-management-token'] !== token) return sendJson(response, 401, { error: 'Invalid request', code: 'TOKEN_REQUIRED', details: null })
      const origin = request.headers.origin
      const expectedOrigin = `http://${host}:${request.socket.localPort}`
      if (origin !== expectedOrigin) return sendJson(response, 403, { error: 'Invalid request', code: 'ORIGIN_NOT_ALLOWED', details: null })
      if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return sendJson(response, 415, { error: 'Invalid request', code: 'JSON_REQUIRED', details: null })
      let body
      try { body = await readJsonBody(request) } catch (error) {
        const result = responsePayload(error)
        return sendJson(response, result.status, { ...result.body, error: 'Invalid request' })
      }
      try {
        if (method === 'POST' && requestUrl.pathname === '/api/executions') {
          return sendJson(response, 501, { error: 'Service unavailable', code: 'CAPABILITY_UNAVAILABLE', details: null })
        }
        const accountDecision = /^\/api\/accounts\/([^/]+)\/decision$/u.exec(requestUrl.pathname)
        if (method === 'PATCH' && accountDecision && typeof service.patchAccountDecision === 'function') {
          return sendJson(response, 200, await service.patchAccountDecision(decodePathSegment(accountDecision[1]), body))
        }
        if (method === 'POST' && requestUrl.pathname === '/api/accounts/bulk-status' && typeof service.bulkAccountDecision === 'function') {
          if (!Array.isArray(body?.ids)) {
            const error = new Error()
            error.status = 400
            error.code = 'INVALID_IDS'
            throw error
          }
          return sendJson(response, 200, await service.bulkAccountDecision(body.ids, body))
        }
        const accountTags = /^\/api\/accounts\/([^/]+)\/tags$/u.exec(requestUrl.pathname)
        if (method === 'PATCH' && accountTags && typeof service.patchAccountTags === 'function') {
          return sendJson(response, 200, await service.patchAccountTags(decodePathSegment(accountTags[1]), body))
        }
        if (method === 'DELETE' && requestUrl.pathname === '/api/articles' && typeof service.bulkDeleteArticles === 'function') {
          return sendJson(response, 200, await service.bulkDeleteArticles(body?.ids, body))
        }
        if (method === 'DELETE' && /^\/api\/articles\/[^/]+$/u.test(requestUrl.pathname) && typeof service.deleteArticle === 'function') {
          const id = decodePathSegment(requestUrl.pathname.slice('/api/articles/'.length))
          return sendJson(response, 200, await service.deleteArticle(id, body))
        }
        if (method === 'POST' && requestUrl.pathname === '/api/articles/bulk-delete' && typeof service.bulkDeleteArticles === 'function') {
          return sendJson(response, 200, await service.bulkDeleteArticles(body?.ids, body))
        }
        if (method === 'POST' && requestUrl.pathname === '/api/rules/groups/save' && typeof service.saveRuleGroup === 'function') {
          return sendJson(response, 200, await service.saveRuleGroup(body))
        }
        if (method === 'POST' && requestUrl.pathname === '/api/hotwords/merge-preview') {
          const handler = service.previewHotwordMerge || service.mergePreview
          if (typeof handler === 'function') return sendJson(response, 200, await handler(body))
        }
        if (method === 'POST' && requestUrl.pathname === '/api/hotwords/merge') {
          const handler = service.mergeHotwords || service.merge
          if (typeof handler === 'function') return sendJson(response, 200, await handler(body))
        }
        if (method === 'POST' && requestUrl.pathname === '/api/rules' && typeof service.createRule === 'function') {
          return sendJson(response, 201, await service.createRule(body))
        }
        if (method === 'POST' && requestUrl.pathname === '/api/strategies' && typeof service.createStrategy === 'function') {
          return sendJson(response, 201, await service.createStrategy(body))
        }
        const ruleId = /^\/api\/rules\/([^/]+)$/u.exec(requestUrl.pathname)
        if (ruleId && method === 'PATCH' && typeof service.updateRule === 'function') {
          return sendJson(response, 200, await service.updateRule(decodePathSegment(ruleId[1]), body))
        }
        if (ruleId && method === 'DELETE' && typeof service.deleteRule === 'function') {
          return sendJson(response, 200, await service.deleteRule(decodePathSegment(ruleId[1]), body))
        }
        const hotwordId = /^\/api\/hotwords\/([^/]+)$/u.exec(requestUrl.pathname)
        if (hotwordId && method === 'PATCH' && typeof service.updateHotword === 'function') {
          return sendJson(response, 200, await service.updateHotword(decodePathSegment(hotwordId[1]), body))
        }
        if (hotwordId && method === 'DELETE' && typeof service.deleteHotword === 'function') {
          return sendJson(response, 200, await service.deleteHotword(decodePathSegment(hotwordId[1]), body))
        }
        const strategyId = /^\/api\/strategies\/([^/]+)$/u.exec(requestUrl.pathname)
        if (strategyId && method === 'PATCH' && typeof service.updateStrategy === 'function') {
          return sendJson(response, 200, await service.updateStrategy(decodePathSegment(strategyId[1]), body))
        }
        if (strategyId && method === 'DELETE' && typeof service.deleteStrategy === 'function') {
          return sendJson(response, 200, await service.deleteStrategy(decodePathSegment(strategyId[1]), body))
        }
        return sendJson(response, 404, { error: 'Invalid request', code: 'NOT_FOUND', details: null })
      } catch (error) {
        const result = responsePayload(error)
        return sendJson(response, result.status, result.body)
      }
    }

    try {
      if (requestUrl.pathname === '/api/session') return sendJson(response, 200, { host, tokenRequired: true, writable: Boolean(token) })
      if (requestUrl.pathname === '/api/health') {
        try {
          const ping = await service.ping()
          if (ping?.ready) return sendJson(response, 200, { ready: true, status: 'ready' })
          return sendJson(response, 503, { ready: false, status: 'not_configured', error: 'Service unavailable', code: 'NOT_CONFIGURED', details: null })
        } catch (error) {
          const result = responsePayload(error)
          return sendJson(response, result.status, { ready: false, status: 'error', ...result.body })
        }
      }
      if (requestUrl.pathname === '/api/summary') return sendJson(response, 200, { tables: await service.summary() })
      if (requestUrl.pathname === '/api/strategy-options/accounts' && typeof service.listStrategyAccounts === 'function') {
        return sendJson(response, 200, await service.listStrategyAccounts(Object.fromEntries(requestUrl.searchParams.entries())))
      }
      if (requestUrl.pathname === '/api/strategy-options/keywords' && typeof service.listStrategyKeywords === 'function') {
        return sendJson(response, 200, await service.listStrategyKeywords(Object.fromEntries(requestUrl.searchParams.entries())))
      }
      if (requestUrl.pathname === '/api/accounts' && typeof service.listAccounts === 'function') {
        return sendJson(response, 200, await service.listAccounts(Object.fromEntries(requestUrl.searchParams.entries())))
      }
      const accountId = /^\/api\/accounts\/([^/]+)$/u.exec(requestUrl.pathname)
      if (accountId && typeof service.getAccount === 'function') {
        return sendJson(response, 200, await service.getAccount(decodePathSegment(accountId[1])))
      }
      if (requestUrl.pathname === '/api/articles' && typeof service.listArticles === 'function') {
        return sendJson(response, 200, await service.listArticles(Object.fromEntries(requestUrl.searchParams.entries())))
      }
      if (requestUrl.pathname === '/api/rules/groups' && typeof service.listRuleGroups === 'function') {
        return sendJson(response, 200, await service.listRuleGroups())
      }
      if (requestUrl.pathname === '/api/rules' && typeof service.listRules === 'function') {
        return sendJson(response, 200, await service.listRules(Object.fromEntries(requestUrl.searchParams.entries())))
      }
      if (requestUrl.pathname === '/api/hotwords' && typeof service.listHotwords === 'function') {
        return sendJson(response, 200, await service.listHotwords(Object.fromEntries(requestUrl.searchParams.entries())))
      }
      if (requestUrl.pathname === '/api/strategies' && typeof service.listStrategies === 'function') {
        return sendJson(response, 200, await service.listStrategies(Object.fromEntries(requestUrl.searchParams.entries())))
      }
      const articleId = /^\/api\/articles\/([^/]+)$/u.exec(requestUrl.pathname)
      if (articleId && typeof service.getArticle === 'function') {
        return sendJson(response, 200, await service.getArticle(decodePathSegment(articleId[1])))
      }
      const ruleId = /^\/api\/rules\/([^/]+)$/u.exec(requestUrl.pathname)
      if (ruleId && typeof service.getRule === 'function') {
        return sendJson(response, 200, await service.getRule(decodePathSegment(ruleId[1])))
      }
      const hotwordId = /^\/api\/hotwords\/([^/]+)$/u.exec(requestUrl.pathname)
      if (hotwordId && typeof service.getHotword === 'function') {
        return sendJson(response, 200, await service.getHotword(decodePathSegment(hotwordId[1])))
      }
      const strategyId = /^\/api\/strategies\/([^/]+)$/u.exec(requestUrl.pathname)
      if (strategyId && typeof service.getStrategy === 'function') {
        return sendJson(response, 200, await service.getStrategy(decodePathSegment(strategyId[1])))
      }
      return sendJson(response, 404, { error: 'Invalid request', code: 'NOT_FOUND', details: null })
    } catch (error) {
      const result = responsePayload(error)
      return sendJson(response, result.status, result.body)
    }
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parsedPort = Number(process.env.MANAGEMENT_PORT || 4173)
  const port = Number.isSafeInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 4173
  const server = createManagementServer({ port })
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`Management center listening on http://127.0.0.1:${port}\n`)
  })
}
