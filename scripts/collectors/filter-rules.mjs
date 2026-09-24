import { createRuleSnapshot, normalizePersistedRules } from '../../src/article-filter.mjs'
import { createSupabaseClient } from '../../management-center/services/supabase.mjs'

const FILTER_RULE_COLUMNS = Object.freeze(['id', 'scope', 'field_name', 'operator', 'value_text', 'value_number', 'enabled'])
const PAGE_SIZE = 1_000
const MAX_RULES = 5_000

function ruleLoadError(code, requestCount, cause) {
  const error = new Error(code === 'SUPABASE_CONFIG_MISSING'
    ? 'Supabase server credentials are required to load article filter rules'
    : 'Enabled account and article filter rules could not be fully loaded')
  error.code = code
  error.request_count = requestCount
  if (cause) error.cause = cause
  return error
}

export async function loadFilterRuleSnapshot({ client: suppliedClient, env = process.env, fetchImpl = globalThis.fetch, pageSize = PAGE_SIZE } = {}) {
  let requestCount = 0
  try {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE) throw ruleLoadError('INVALID_RULE_PAGE_SIZE', requestCount)
    const url = env.SUPABASE_URL
    const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY
    if (!suppliedClient && (!url || !key)) throw ruleLoadError('SUPABASE_CONFIG_MISSING', requestCount)
    const client = suppliedClient || createSupabaseClient({ url, key, fetchImpl })
    const rows = []
    let offset = 0
    while (true) {
      if (offset >= MAX_RULES) throw ruleLoadError('FILTER_RULE_CAPACITY_EXCEEDED', requestCount)
      requestCount += 1
      const result = await client.list('filter_rules', {
        columns: FILTER_RULE_COLUMNS,
        filters: [{ column: 'enabled', operator: 'eq', value: true }],
        order: [{ column: 'id', direction: 'asc' }],
        limit: pageSize,
        offset,
        count: 'exact'
      })
      if (!Array.isArray(result?.data)) throw ruleLoadError('SUPABASE_RULE_DATA_INVALID', requestCount)
      if (Number.isSafeInteger(result.total) && result.total > MAX_RULES) throw ruleLoadError('FILTER_RULE_CAPACITY_EXCEEDED', requestCount)
      rows.push(...result.data.filter(row => row?.enabled === true))
      if (rows.length > MAX_RULES) throw ruleLoadError('FILTER_RULE_CAPACITY_EXCEEDED', requestCount)
      if ((Number.isSafeInteger(result.total) && rows.length >= result.total) || result.data.length < pageSize) break
      offset += result.data.length
    }
    const rules = normalizePersistedRules(rows.filter(row => ['account', 'article'].includes(String(row?.scope || ''))))
    return { snapshot: createRuleSnapshot(rules, { source: 'supabase', loadedAt: new Date().toISOString() }), request_count: requestCount }
  } catch (cause) {
    if (cause?.request_count !== undefined) throw cause
    throw ruleLoadError(cause?.code || 'SUPABASE_RULE_LOAD_FAILED', requestCount, cause)
  }
}
