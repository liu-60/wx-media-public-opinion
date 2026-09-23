const JSON_COLUMNS = new Set(['default_config', 'input_schema', 'output_schema', 'capabilities', 'required_artifacts', 'retention_config', 'config_override', 'condition', 'workflow_snapshot', 'config_snapshot', 'rule_snapshot', 'strategy_snapshot', 'summary', 'artifact_manifest', 'script_snapshot', 'checkpoint'])
const TABLES = Object.freeze({
  collector_scripts: Object.freeze({ primaryKey: 'id', columns: new Set(['id', 'name', 'script_key', 'platform', 'description', 'execution_type', 'entrypoint', 'enabled', 'version', 'timeout_seconds', 'retry_count', 'default_config', 'input_schema', 'output_schema', 'code_hash', 'capabilities', 'run_mode', 'required_artifacts', 'credential_ref', 'created_at', 'updated_at']) }),
  collection_workflows: Object.freeze({ primaryKey: 'id', columns: new Set(['id', 'name', 'enabled', 'system_generated', 'validation_only', 'revision', 'default_config', 'retention_config', 'created_at', 'updated_at']) }),
  collection_workflow_steps: Object.freeze({ primaryKey: 'id', columns: new Set(['id', 'workflow_id', 'script_id', 'step_key', 'seq', 'enabled', 'config_override', 'condition', 'continue_on_error', 'retry_count', 'timeout_seconds', 'created_at', 'updated_at']) }),
  collection_runs: Object.freeze({ primaryKey: 'id', columns: new Set(['id', 'workflow_id', 'run_kind', 'script_id', 'workflow_snapshot', 'status', 'config_snapshot', 'rule_snapshot', 'strategy_snapshot', 'started_at', 'finished_at', 'summary', 'parent_run_id', 'worker_id', 'lease_until', 'heartbeat_at', 'publish_status', 'artifact_manifest', 'retention_until', 'pinned', 'created_at', 'updated_at']) }),
  collection_step_runs: Object.freeze({ primaryKey: 'id', columns: new Set(['id', 'run_id', 'step_key', 'script_snapshot', 'attempt', 'status', 'started_at', 'finished_at', 'duration_ms', 'input_count', 'output_count', 'created_count', 'updated_count', 'filtered_count', 'request_count', 'error_code', 'error_message', 'checkpoint', 'artifact_manifest', 'log_ref', 'input_hash', 'created_at', 'updated_at']) })
})
const RPC_NAMES = new Set(['create_collection_run', 'create_collection_script_run', 'claim_collection_run', 'claim_collection_run_by_id', 'heartbeat_collection_run', 'reorder_collection_workflow_steps'])
const OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'not.is', 'in'])

export class CollectionDbError extends Error {
  constructor(code, status = 503, message = code) { super(`${code}: ${message}`); this.name = 'CollectionDbError'; this.code = code; this.status = status }
}

function tableInfo(table) {
  if (!Object.hasOwn(TABLES, table)) throw new CollectionDbError('INVALID_TABLE', 400)
  return TABLES[table]
}

function columns(table, selected) {
  const info = tableInfo(table)
  const result = selected === undefined ? [...info.columns] : selected
  if (!Array.isArray(result) || !result.length || result.some(column => typeof column !== 'string' || !info.columns.has(column))) throw new CollectionDbError('INVALID_COLUMN', 400)
  return result
}

function serialize(value, column) {
  if (JSON_COLUMNS.has(column)) {
    if (value === null) return null
    if (typeof value === 'string') {
      try { return JSON.parse(value) } catch { return value }
    }
    return value ?? {}
  }
  return value
}

function payload(table, value, { allowRows = false } = {}) {
  const info = tableInfo(table)
  if (Array.isArray(value)) {
    if (!allowRows || !value.length) throw new CollectionDbError('INVALID_PAYLOAD', 400)
    return value.map(item => payload(table, item))
  }
  if (!value || typeof value !== 'object') throw new CollectionDbError('INVALID_PAYLOAD', 400)
  const keys = Object.keys(value)
  if (!keys.length || keys.some(key => !info.columns.has(key))) throw new CollectionDbError('INVALID_COLUMN', 400)
  return Object.fromEntries(keys.map(key => [key, serialize(value[key], key)]))
}

function normalizeFilters(table, filters = [], { require = false } = {}) {
  const info = tableInfo(table)
  if (!Array.isArray(filters) || (require && !filters.length)) throw new CollectionDbError('INVALID_FILTER', 400)
  return filters.map(filter => {
    if (!filter || !info.columns.has(filter.column) || !OPERATORS.has(filter.operator) || filter.value === undefined) throw new CollectionDbError('INVALID_FILTER', 400)
    if (filter.operator === 'in') {
      if (!Array.isArray(filter.value) || !filter.value.length || filter.value.some(item => item === null || item === undefined || /[\r\n(),]/u.test(String(item)))) throw new CollectionDbError('INVALID_FILTER', 400)
      return { column: filter.column, value: `(${filter.value.map(item => String(item)).join(',')})`, operator: filter.operator }
    }
    if (/[\r\n]/u.test(String(filter.value))) throw new CollectionDbError('INVALID_FILTER', 400)
    return { column: filter.column, value: filter.value === null ? 'null' : String(filter.value), operator: filter.operator }
  })
}

function parseTotal(headers) {
  const value = headers?.get?.('content-range')
  const match = /\/(\d+|\*)$/u.exec(String(value || ''))
  return match && match[1] !== '*' ? Number(match[1]) : null
}

function mapError(status) {
  if (status === 409) return ['UPSTREAM_CONFLICT', 409]
  if (status === 401 || status === 403) return ['UPSTREAM_UNAUTHORIZED', 502]
  if (status === 408 || status === 429 || status >= 500) return ['UPSTREAM_UNAVAILABLE', 503]
  return ['UPSTREAM_REJECTED', 502]
}

function parseBody(value) {
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.data)) return value.data
  return value
}

export function createCollectionDb({ url, key, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  if (!url || !key) throw new CollectionDbError('NOT_CONFIGURED', 503)
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  const baseUrl = `${String(url).replace(/\/+$/u, '')}`

  async function requestTable(table, { method = 'GET', columns: selected, filters = [], order = [], limit, offset, count = false, body } = {}) {
    const info = tableInfo(table)
    const normalizedMethod = String(method).toUpperCase()
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(normalizedMethod)) throw new CollectionDbError('INVALID_METHOD', 400)
    const query = new URLSearchParams()
    if (normalizedMethod === 'GET') query.set('select', columns(table, selected).join(','))
    for (const filter of normalizeFilters(table, filters, { require: normalizedMethod === 'PATCH' || normalizedMethod === 'DELETE' })) query.append(filter.column, `${filter.operator}.${filter.value}`)
    if (order?.length) {
      if (!Array.isArray(order) || order.some(item => !info.columns.has(item.column) || !['asc', 'desc'].includes(item.direction))) throw new CollectionDbError('INVALID_ORDER', 400)
      query.set('order', order.map(item => `${item.column}.${item.direction}`).join(','))
    }
    if (limit !== undefined) query.set('limit', String(limit))
    if (offset !== undefined) query.set('offset', String(offset))
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    const queryText = query.toString()
    const target = `${baseUrl}/rest/v1/${table}${queryText ? `?${queryText}` : ''}`
    try {
      const response = await fetchImpl(target, {
        method: normalizedMethod,
        headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json', ...(count ? { Prefer: 'count=exact' } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', Prefer: 'return=representation' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      })
      if (!response?.ok) { const [code, status] = mapError(Number(response?.status || 0)); throw new CollectionDbError(code, status) }
      let data = null
      try { data = await response.json() } catch {}
      return { data: parseBody(data), total: parseTotal(response.headers), status: response.status }
    } catch (error) {
      if (error instanceof CollectionDbError) throw error
      if (controller.signal.aborted) throw new CollectionDbError('UPSTREAM_TIMEOUT', 503)
      throw new CollectionDbError('UPSTREAM_UNAVAILABLE', 503)
    } finally { clearTimeout(timeoutId) }
  }

  async function rpc(name, args = {}) {
    if (!RPC_NAMES.has(name)) throw new CollectionDbError('INVALID_RPC', 400)
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new CollectionDbError('INVALID_PAYLOAD', 400)
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${baseUrl}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: controller.signal })
      if (!response?.ok) { const [code, status] = mapError(Number(response?.status || 0)); throw new CollectionDbError(code, status) }
      let data = null
      try { data = await response.json() } catch {}
      return { data: parseBody(data), total: null, status: response.status }
    } catch (error) {
      if (error instanceof CollectionDbError) throw error
      if (controller.signal.aborted) throw new CollectionDbError('UPSTREAM_TIMEOUT', 503)
      throw new CollectionDbError('UPSTREAM_UNAVAILABLE', 503)
    } finally { clearTimeout(timeoutId) }
  }

  return Object.freeze({
    tables: Object.keys(TABLES),
    rpcNames: [...RPC_NAMES],
    list: (table, options = {}) => requestTable(table, { ...options, method: 'GET' }),
    get: async (table, id, options = {}) => {
      const info = tableInfo(table)
      const result = await requestTable(table, { ...options, method: 'GET', filters: [{ column: info.primaryKey, operator: 'eq', value: id }], limit: 1 })
      const row = Array.isArray(result.data) ? result.data[0] : null
      if (!row) throw new CollectionDbError('NOT_FOUND', 404)
      return { ...result, data: row }
    },
    insert: (table, value) => requestTable(table, { method: 'POST', body: payload(table, value, { allowRows: true }) }),
    patch: (table, filters, value) => requestTable(table, { method: 'PATCH', filters, body: payload(table, value) }),
    remove: (table, filters) => requestTable(table, { method: 'DELETE', filters }),
    rpc
  })
}

export { TABLES, RPC_NAMES }
