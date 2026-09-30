import { ConfigValidationError, createConfigValidation } from './config-validation.mjs'

const TABLES = Object.freeze({
  accounts: Object.freeze({ primaryKey: 'account_id', columns: new Set(['account_id', 'wx_biz', 'wx_name', 'verify', 'description', 'decision_status', 'decision_source', 'read_median', 'read_max', 'filter_rule_id', 'updated_at']) }),
  account_profiles: Object.freeze({ primaryKey: 'account_id', columns: new Set(['account_id', 'wx_user', 'avatar', 'wx_type', 'region', 'tags', 'last_pub_time', 'pub_count', 'active_days', 'read_avg', 'read_median', 'read_max', 'burst_count', 'burst_rate', 'look_avg', 'look_median', 'look_max', 'like_avg', 'like_median', 'like_max', 'share_avg', 'share_median', 'share_max', 'comment_avg', 'comment_median', 'comment_max', 'ori_count', 'manual_tags', 'collected_at']) }),
  articles: Object.freeze({ primaryKey: 'id', columns: new Set(['id', 'account_id', 'article_key', 'article_sn', 'idx', 'title', 'article_url', 'published_at', 'read_num', 'read_num_capped', 'like_num', 'look_num', 'share_num', 'comment_num', 'is_original', 'source_code', 'updated_at']) }),
  filter_rules: Object.freeze({ primaryKey: 'id', columns: new Set(['id', 'scope', 'field_name', 'operator', 'value_text', 'value_number', 'enabled', 'hit_count', 'remark', 'created_at', 'updated_at']) }),
  hotwords: Object.freeze({ primaryKey: 'id', columns: new Set(['id', 'hotword', 'aliases', 'stat_date', 'article_count', 'article_keys', 'article_url', 'platform_count', 'source_platforms', 'is_rising', 'growth_rate', 'trend_state', 'trend_score', 'consecutive_days', 'daily_growth', 'quality_valid', 'quality_type', 'quality_confidence', 'quality_reason', 'quality_checked_at', 'updated_at']) }),
  hotword_articles: Object.freeze({ primaryKey: 'id', columns: new Set(['id', 'hotword_id', 'article_id', 'article_key', 'stat_date', 'source_platforms', 'matched_terms', 'created_at', 'updated_at']) }),
  collection_strategy_groups: Object.freeze({ primaryKey: 'id', columns: new Set(['id', 'request_type', 'source_targets', 'active_targets', 'completed_items', 'date', 'month', 'cursor', 'min_read', 'max_read', 'cycle_no', 'updated_at']) })
})
const RELATIONS = Object.freeze({
  accounts: Object.freeze({ account_profiles: 'account_profiles', articles: 'articles' }),
  articles: Object.freeze({ accounts: 'accounts' })
})
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'DELETE'])

export class SupabaseClientError extends Error {
  constructor({ code, status, message = 'Upstream request failed' }) {
    super(message)
    this.name = 'SupabaseClientError'
    this.code = code
    this.status = status
  }
}

function validateTable(table) {
  if (!Object.hasOwn(TABLES, table)) throw new ConfigValidationError('INVALID_TABLE')
  return TABLES[table]
}

function validateColumns(tableInfo, columns) {
  const result = columns === undefined ? [...tableInfo.columns] : columns
  if (!Array.isArray(result) || !result.length || result.some(column => typeof column !== 'string' || !tableInfo.columns.has(column))) {
    throw new ConfigValidationError('INVALID_COLUMN')
  }
  return result
}

function parseTotal(contentRange) {
  if (!contentRange) return null
  const match = /\/(\d+|\*)$/u.exec(contentRange.trim())
  return match && match[1] !== '*' ? Number(match[1]) : null
}

function mapUpstreamStatus(status) {
  if (status === 401 || status === 403) return { status: 502, code: 'UPSTREAM_UNAUTHORIZED' }
  if (status === 409) return { status: 409, code: 'UPSTREAM_CONFLICT' }
  if (status === 408 || status === 429 || status >= 500) return { status: 503, code: 'UPSTREAM_UNAVAILABLE' }
  return { status: 502, code: 'UPSTREAM_REJECTED' }
}

function normalizeFilters(table, tableInfo, filters) {
  if (filters === undefined) return []
  if (!Array.isArray(filters)) throw new ConfigValidationError('INVALID_FILTER')
  return filters.map(filter => {
    if (!filter || typeof filter !== 'object' || !tableInfo.columns.has(filter.column) || !['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'not.is', 'ilike', 'in'].includes(filter.operator)) {
      throw new ConfigValidationError('INVALID_FILTER')
    }
    if (filter.value === undefined || (filter.value === null && !['is', 'not.is'].includes(filter.operator))) throw new ConfigValidationError('INVALID_FILTER')
    if (filter.operator === 'in') {
      if (!Array.isArray(filter.value) || !filter.value.length || filter.value.some(value => value === null || value === undefined || /[\r\n(),]/u.test(String(value)))) throw new ConfigValidationError('INVALID_FILTER')
      return { ...filter, value: `(${filter.value.map(value => String(value)).join(',')})` }
    }
    if (/[\r\n]/u.test(String(filter.value))) throw new ConfigValidationError('INVALID_FILTER')
    return { ...filter, value: serializeSupabaseValue(table, filter.column, filter.value) }
  })
}

function normalizeRelation(table, relation) {
  if (!relation || typeof relation !== 'object' || !RELATIONS[table]?.[relation.table]) throw new ConfigValidationError('INVALID_RELATION')
  const relationInfo = TABLES[relation.table]
  const columns = validateColumns(relationInfo, relation.columns)
  const filters = normalizeFilters(relation.table, relationInfo, relation.filters)
  const order = normalizeOrder(relation.table, relationInfo, relation.order)
  const limit = relation.limit === undefined ? undefined : createConfigValidation().integer(relation.limit, { min: 1, max: 5_000, required: true })
  const presence = relation.presence === undefined ? undefined : relation.presence === 'exists' || relation.presence === 'missing' ? relation.presence : (() => { throw new ConfigValidationError('INVALID_RELATION') })()
  return {
    table: relation.table,
    columns,
    filters,
    ...(order.length ? { order } : {}),
    ...(limit === undefined ? {} : { limit }),
    presence,
    join: relation.join === 'inner' ? 'inner' : 'left'
  }
}

function normalizeRelations(table, relations) {
  if (relations === undefined) return []
  if (!Array.isArray(relations)) throw new ConfigValidationError('INVALID_RELATION')
  return relations.map(relation => normalizeRelation(table, relation))
}

function normalizeSearch(tableInfo, search) {
  if (search === undefined) return undefined
  if (!search || typeof search !== 'object' || !Array.isArray(search.columns) || !search.columns.length || search.columns.some(column => !tableInfo.columns.has(column)) || typeof search.value !== 'string' || !search.value.trim()) {
    throw new ConfigValidationError('INVALID_SEARCH')
  }
  if (/[\r\n]/u.test(search.value)) throw new ConfigValidationError('INVALID_SEARCH')
  const mode = search.mode === undefined ? 'contains' : search.mode
  if (!['contains', 'exact'].includes(mode)) throw new ConfigValidationError('INVALID_SEARCH')
  return { columns: search.columns, value: search.value.trim(), mode }
}

function normalizeOrder(table, tableInfo, order) {
  if (order === undefined) return []
  if (!Array.isArray(order)) throw new ConfigValidationError('INVALID_ORDER')
  return order.map(item => {
    if (!item || typeof item !== 'object' || !['asc', 'desc'].includes(item.direction) || (item.nulls !== undefined && !['first', 'last'].includes(item.nulls))) throw new ConfigValidationError('INVALID_ORDER')
    if (item.relation !== undefined) {
      const relationInfo = TABLES[item.relation]
      if (!RELATIONS[table]?.[item.relation] || !relationInfo?.columns.has(item.column)) throw new ConfigValidationError('INVALID_ORDER')
      return item
    }
    if (!tableInfo.columns.has(item.column)) throw new ConfigValidationError('INVALID_ORDER')
    return item
  })
}

function escapeSearchValue(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('*', '\\*').replaceAll(',', '\\,').replaceAll('(', '\\(').replaceAll(')', '\\)').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function normalizeRow(tableInfo, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ConfigValidationError('INVALID_PAYLOAD')
  const keys = Object.keys(payload)
  if (!keys.length || keys.some(key => !tableInfo.columns.has(key))) throw new ConfigValidationError('INVALID_COLUMN')
  return payload
}

function normalizePayload(tableInfo, payload, { allowRows = false } = {}) {
  if (!Array.isArray(payload)) return normalizeRow(tableInfo, payload)
  if (!allowRows || !payload.length) throw new ConfigValidationError('INVALID_PAYLOAD')
  return payload.map(row => normalizeRow(tableInfo, row))
}

function quotePostgresArrayItem(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}` + '"'
}

export function serializeSupabaseValue(table, column, value) {
  if (value === null) return null
  if ((table === 'hotwords' && ['aliases', 'article_keys', 'source_platforms'].includes(column)) || (table === 'hotword_articles' && ['source_platforms', 'matched_terms'].includes(column))) {
    if (!Array.isArray(value)) throw new ConfigValidationError('INVALID_FILTER')
    return `{${value.map(quotePostgresArrayItem).join(',')}}`
  }
  if (['account_profiles', 'collection_strategy_groups'].includes(table) && ['manual_tags', 'source_targets', 'active_targets', 'completed_items'].includes(column)) {
    return JSON.stringify(value)
  }
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function createSupabaseClient({ url, key, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  if (!url || typeof url !== 'string') throw new TypeError('Supabase URL is required')
  if (!key || typeof key !== 'string') throw new TypeError('Supabase server key is required')
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  const timeout = createConfigValidation().integer(timeoutMs, { min: 1, max: 120_000, required: true })
  const baseUrl = `${url.replace(/\/+$/u, '')}/rest/v1`

  async function request(table, { method = 'GET', columns, filters, relations, search, order, payload, limit, offset, count = false, onConflict } = {}) {
    const tableInfo = validateTable(table)
    const normalizedMethod = String(method).toUpperCase()
    if (!['GET', ...MUTATING_METHODS].includes(normalizedMethod)) throw new ConfigValidationError('INVALID_METHOD')
    if (onConflict && String(onConflict).split(',').some(column => !tableInfo.columns.has(column.trim()))) throw new ConfigValidationError('INVALID_COLUMN')
    const selectedColumns = normalizedMethod === 'GET' ? validateColumns(tableInfo, columns) : undefined
    const normalizedFilters = normalizeFilters(table, tableInfo, filters)
    const normalizedRelations = normalizedMethod === 'GET' ? normalizeRelations(table, relations) : []
    const normalizedSearch = normalizedMethod === 'GET' ? normalizeSearch(tableInfo, search) : undefined
    const normalizedOrder = normalizedMethod === 'GET' ? normalizeOrder(table, tableInfo, order) : []
    const normalizedPayload = normalizedMethod === 'POST' ? normalizePayload(tableInfo, payload, { allowRows: true }) : normalizedMethod === 'PATCH' ? normalizePayload(tableInfo, payload) : undefined
    if ((normalizedMethod === 'PATCH' || normalizedMethod === 'DELETE') && !normalizedFilters.length) throw new ConfigValidationError('INVALID_FILTER')
    const query = new URLSearchParams()
    if (onConflict) query.set('on_conflict', String(onConflict))
    if (selectedColumns) {
      const relationSelections = normalizedRelations.map(relation => `${relation.table}${relation.join === 'inner' ? '!inner' : ''}(${relation.columns.join(',')})`)
      query.set('select', [...selectedColumns, ...relationSelections].join(','))
    }
    for (const filter of normalizedFilters) query.append(filter.column, `${filter.operator}.${filter.value}`)
    if (normalizedSearch) {
      const escaped = escapeSearchValue(normalizedSearch.value)
      const operator = normalizedSearch.mode === 'exact' ? 'eq' : 'ilike'
      const operand = normalizedSearch.mode === 'exact' ? escaped : `*${escaped}*`
      query.set('or', `(${normalizedSearch.columns.map(column => `${column}.${operator}.${operand}`).join(',')})`)
    }
    for (const relation of normalizedRelations) {
      if (relation.presence) query.append(relation.table, `${relation.presence === 'exists' ? 'not.is' : 'is'}.null`)
      if (!relation.filters.length) continue
      if (relation.filters.length === 1) {
        const filter = relation.filters[0]
        query.append(`${relation.table}.${filter.column}`, `${filter.operator}.${filter.value}`)
      } else {
        query.set(`${relation.table}.and`, `(${relation.filters.map(filter => `${filter.column}.${filter.operator}.${filter.value}`).join(',')})`)
      }
    }
    for (const relation of normalizedRelations) {
      if (relation.order?.length) query.set(`${relation.table}.order`, relation.order.map(item => `${item.relation ? `${item.relation}(${item.column})` : item.column}.${item.direction}${item.nulls ? `.nulls${item.nulls}` : ''}`).join(','))
      if (relation.limit !== undefined) query.set(`${relation.table}.limit`, String(relation.limit))
    }
    if (normalizedOrder.length) query.set('order', normalizedOrder.map(item => `${item.relation ? `${item.relation}(${item.column})` : item.column}.${item.direction}${item.nulls ? `.nulls${item.nulls}` : ''}`).join(','))
    if (limit !== undefined) query.set('limit', String(createConfigValidation().integer(limit, { min: 1, max: 5_000, required: true })))
    if (offset !== undefined) query.set('offset', String(createConfigValidation().integer(offset, { min: 0, max: Number.MAX_SAFE_INTEGER, required: true })))
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)
    const preferences = []
    if (count === 'exact') preferences.push('count=exact')
    if (normalizedMethod === 'POST' && onConflict) preferences.push('resolution=merge-duplicates')
    if (normalizedPayload !== undefined || normalizedMethod === 'DELETE') preferences.push('return=representation')
    try {
      const response = await fetchImpl(`${baseUrl}/${table}?${query.toString()}`, {
        method: normalizedMethod,
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          ...(preferences.length ? { Prefer: preferences.join(',') } : {}),
          ...(normalizedPayload === undefined && normalizedMethod !== 'DELETE' ? {} : { 'Content-Type': 'application/json' })
        },
        ...(normalizedPayload === undefined ? {} : { body: JSON.stringify(normalizedPayload) }),
        signal: controller.signal
      })
      if (!response?.ok) {
        const mapped = mapUpstreamStatus(Number(response?.status) || 0)
        throw new SupabaseClientError(mapped)
      }
      let data = null
      if (typeof response.json === 'function') {
        try { data = await response.json() } catch {}
      }
      return { data, total: parseTotal(response.headers?.get?.('content-range')), status: response.status }
    } catch (error) {
      if (error instanceof ConfigValidationError || error instanceof SupabaseClientError) throw error
      if (controller.signal.aborted) throw new SupabaseClientError({ status: 503, code: 'UPSTREAM_TIMEOUT' })
      throw new SupabaseClientError({ status: 503, code: 'UPSTREAM_UNAVAILABLE' })
    } finally {
      clearTimeout(timeoutId)
    }
  }

  return Object.freeze({
    ping: async () => {
      await request('accounts', { columns: ['account_id'], limit: 1, count: false })
      return { ready: true }
    },
    list: async (table, options = {}) => request(table, { ...options, method: 'GET' }),
    get: async (table, id, options = {}) => {
      const tableInfo = validateTable(table)
      const normalizedId = createConfigValidation().id(String(id))
      const result = await request(table, { ...options, method: 'GET', filters: [{ column: tableInfo.primaryKey, operator: 'eq', value: normalizedId }], limit: 1 })
      const row = Array.isArray(result.data) ? result.data[0] : null
      if (!row) throw new SupabaseClientError({ status: 404, code: 'NOT_FOUND', message: 'Not found' })
      return { ...result, data: row }
    },
    insert: async (table, rows) => request(table, { method: 'POST', payload: rows }),
    upsert: async (table, rows, { onConflict } = {}) => request(table, { method: 'POST', payload: rows, onConflict }),
    patch: async (table, filters, payload) => request(table, { method: 'PATCH', filters, payload }),
    remove: async (table, filters) => request(table, { method: 'DELETE', filters }),
    summary: async () => Object.fromEntries(await Promise.all(Object.entries(TABLES).map(async ([table, info]) => {
      const result = await request(table, { columns: [info.primaryKey], limit: 1, count: 'exact' })
      return [table, result.total]
    }))),
    tables: Object.keys(TABLES)
  })
}

export { TABLES }
