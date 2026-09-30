import { ConfigValidationError } from './config-validation.mjs'
import { canonicalHotwordMerge, mergeHotwordRow } from '../../src/hotwords.mjs'
import { buildNextRequestPreviewModel } from '../public/strategy-ui.mjs'

const HOTWORD_COLUMNS = Object.freeze(['id', 'hotword', 'aliases', 'stat_date', 'article_count', 'article_keys', 'article_url', 'platform_count', 'source_platforms', 'is_rising', 'growth_rate', 'trend_state', 'trend_score', 'consecutive_days', 'daily_growth', 'quality_valid', 'quality_type', 'quality_confidence', 'quality_reason', 'quality_checked_at', 'updated_at'])
const HOTWORD_SORT_FIELDS = new Set(['hotword', 'article_count', 'platform_count', 'growth_rate', 'trend_score', 'stat_date', 'updated_at'])
const STRATEGY_COLUMNS = Object.freeze(['id', 'request_type', 'source_targets', 'active_targets', 'completed_items', 'date', 'month', 'cursor', 'min_read', 'max_read', 'cycle_no', 'updated_at'])
const HOTWORD_SNAPSHOT_COLUMNS = Object.freeze([...HOTWORD_COLUMNS])
const STRATEGY_CONFIG_COLUMNS = Object.freeze(['request_type', 'source_targets', 'active_targets', 'date', 'month', 'cursor', 'min_read', 'max_read'])
const REQUEST_TYPES = Object.freeze(['date', 'month', 'account', 'keyword', 'wx_type'])
const WX_TYPE_TARGETS = Object.freeze(['时事', '文化', '健康', '职场', '学术', '美食', '民生', '科技', '情感', '楼市', '汽车', '幽默', '政务', '财富', '旅行', '企业', '时尚', '美体', '教育', '体娱', '百科', '乐活', '创业', '文摘'])
const EXECUTION_CAPABILITY = Object.freeze({
  available: false,
  code: 'CAPABILITY_UNAVAILABLE',
  message: '执行器未接入/凭据未就绪'
})

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function invalid(code, message) {
  throw new ConfigValidationError(code, message)
}

function conflict(code, message) {
  const error = new Error(message)
  error.status = 409
  error.code = code
  return error
}

function rowsOf(result) {
  return Array.isArray(result?.data) ? result.data : []
}

function positiveId(value) {
  const result = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isSafeInteger(result) || result < 1) invalid('INVALID_ID', 'id必须是正安全整数')
  return result
}

function integer(value, { min = 0, max = Number.MAX_SAFE_INTEGER, required = true, code = 'INVALID_INTEGER' } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) invalid(code, '必须是整数')
    return undefined
  }
  const result = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isSafeInteger(result) || result < min || result > max) invalid(code, '整数超出允许范围')
  return result
}

function requiredText(value, max, code = 'INVALID_TEXT') {
  if (typeof value !== 'string') invalid(code, '必须是文本')
  const result = value.trim()
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) invalid(code, '文本格式无效')
  return result
}

function optionalUrl(value) {
  if (value === null) return null
  if (typeof value !== 'string' || !value.trim()) invalid('INVALID_URL', 'article_url必须是http/https URL')
  try {
    const parsed = new URL(value.trim())
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol')
    return value.trim()
  } catch {
    invalid('INVALID_URL', 'article_url必须是http/https URL')
  }
}

function validDate(value, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) invalid('DATE_REQUIRED', 'date不能为空')
    return null
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) invalid('INVALID_DATE', 'date必须是YYYY-MM-DD')
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid('INVALID_DATE', 'date不是有效日期')
  return value
}

function validMonth(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}(0[1-9]|1[0-2])$/u.test(value)) invalid('INVALID_MONTH', 'month必须是YYYYMM')
  return value
}

function normalizeTextArray(value, { maxItems = 1000, maxLength = 500, code = 'INVALID_TARGETS' } = {}) {
  if (!Array.isArray(value)) invalid(code, '目标必须是数组')
  if (value.length > maxItems) invalid('STRATEGY_TARGET_LIMIT', '单组目标不能超过1000个')
  const result = []
  const seen = new Set()
  for (const item of value) {
    const normalized = requiredText(item, maxLength, code)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      result.push(normalized)
    }
  }
  return result
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function normalizeTargets(requestType, value, field) {
  if (!Array.isArray(value)) invalid('INVALID_TARGETS', `${field}必须是数组`)
  if (value.length > 1000) invalid('STRATEGY_TARGET_LIMIT', '单组目标不能超过1000个')
  const result = []
  const seen = new Set()
  for (const raw of value) {
    let target = raw
    let identity
    if (requestType === 'account') {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('INVALID_TARGETS', 'account目标必须是对象')
      const accountId = positiveId(raw.account_id)
      const wxBiz = requiredText(raw.wx_biz, 64, 'INVALID_TARGETS')
      if (raw.wx_name !== undefined && raw.wx_name !== null) requiredText(raw.wx_name, 128, 'INVALID_TARGETS')
      if (raw.read_avg !== undefined && raw.read_avg !== null) integer(raw.read_avg, { min: 0, max: 2_147_483_647, code: 'INVALID_TARGETS' })
      target = { ...clone(raw), account_id: accountId, wx_biz: wxBiz }
      identity = `account:${accountId}`
    } else if (requestType === 'wx_type') {
      target = requiredText(raw, 64, 'INVALID_TARGETS')
      if (!WX_TYPE_TARGETS.includes(target)) invalid('INVALID_TARGETS', 'wx_type不在24个已核验分类中')
      identity = `text:${target}`
    } else if (requestType === 'keyword') {
      target = requiredText(raw, 500, 'INVALID_TARGETS')
      identity = `text:${target}`
    } else {
      try {
        stableStringify(raw)
      } catch {
        invalid('INVALID_TARGETS', '目标必须是可序列化JSON')
      }
      identity = `json:${stableStringify(raw)}`
    }
    if (!seen.has(identity)) {
      seen.add(identity)
      result.push(target)
    }
  }
  return result
}

function targetIdentity(requestType, target) {
  if (requestType === 'account') return `account:${target?.account_id ?? ''}`
  if (requestType === 'wx_type' || requestType === 'keyword') return `text:${target}`
  return `json:${stableStringify(target)}`
}

function validateTargetSubset(requestType, sourceTargets, activeTargets) {
  const source = new Set(sourceTargets.map(target => targetIdentity(requestType, target)))
  if (activeTargets.some(target => !source.has(targetIdentity(requestType, target)))) {
    invalid('STRATEGY_TARGET_SUBSET', 'active_targets必须是source_targets的子集')
  }
}

function validateStrategyConfig(input, current = null) {
  const requestType = input.request_type === undefined ? current?.request_type : input.request_type
  if (!REQUEST_TYPES.includes(requestType)) invalid('INVALID_REQUEST_TYPE', 'request_type不受支持')
  const sourceTargets = normalizeTargets(requestType, input.source_targets === undefined ? (current?.source_targets ?? []) : input.source_targets, 'source_targets')
  const activeTargets = normalizeTargets(requestType, input.active_targets === undefined ? (current?.active_targets ?? []) : input.active_targets, 'active_targets')
  validateTargetSubset(requestType, sourceTargets, activeTargets)
  const date = validDate(input.date === undefined ? current?.date : input.date)
  const month = validMonth(input.month === undefined ? current?.month : input.month)
  if (date && month) invalid('STRATEGY_DATE_MONTH_CONFLICT', 'date与month不能同时存在')
  const cursor = integer(input.cursor === undefined ? (current?.cursor ?? 0) : input.cursor, { min: 0, max: 32767, code: 'STRATEGY_CURSOR_INVALID' })
  const minRead = integer(input.min_read === undefined ? current?.min_read : input.min_read, { min: 0, max: 2_147_483_647, required: false, code: 'STRATEGY_READ_RANGE' })
  const maxRead = integer(input.max_read === undefined ? current?.max_read : input.max_read, { min: 0, max: 2_147_483_647, required: false, code: 'STRATEGY_READ_RANGE' })
  if (minRead !== undefined && maxRead !== undefined && minRead > maxRead) invalid('STRATEGY_READ_RANGE', 'min_read不能大于max_read')
  return { request_type: requestType, source_targets: sourceTargets, active_targets: activeTargets, date, month, cursor, min_read: minRead ?? null, max_read: maxRead ?? null }
}

function hotwordSnapshot(row) {
  return Object.fromEntries(HOTWORD_SNAPSHOT_COLUMNS.map(column => [column, clone(row[column])]))
}

function hotwordCasFilters(row) {
  return HOTWORD_SNAPSHOT_COLUMNS.map(column => ({
    column,
    operator: row[column] === null || row[column] === undefined ? 'is' : 'eq',
    value: row[column] === undefined ? null : clone(row[column])
  }))
}

function sameValue(left, right) {
  return stableStringify(left) === stableStringify(right)
}

function assertHotwordSnapshot(current, expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) invalid('EXPECTED_SNAPSHOT_REQUIRED', '必须提供expected_snapshot')
  for (const column of HOTWORD_SNAPSHOT_COLUMNS) {
    if (!sameValue(current[column], expected[column])) throw conflict('HOTWORD_CONFLICT', '热词已变更，请重新加载')
  }
}

function normalizeExpectedSnapshots(expected, ids) {
  if (Array.isArray(expected)) {
    if (expected.length !== ids.length) invalid('INVALID_EXPECTED_SNAPSHOTS', 'expected_snapshots必须覆盖全部选中项')
    const map = new Map()
    for (const item of expected) {
      const snapshot = item?.snapshot ?? item
      if (!snapshot || snapshot.id === undefined || map.has(String(snapshot.id))) invalid('INVALID_EXPECTED_SNAPSHOTS', 'expected_snapshots存在重复或无效ID')
      map.set(String(snapshot.id), snapshot)
    }
    if (ids.some(id => !map.has(String(id)))) invalid('INVALID_EXPECTED_SNAPSHOTS', 'expected_snapshots必须覆盖全部选中项')
    return map
  }
  if (!expected || typeof expected !== 'object') invalid('EXPECTED_SNAPSHOTS_REQUIRED', '必须提供expected_snapshots')
  const map = new Map()
  for (const id of ids) {
    const snapshot = expected[String(id)] ?? expected[id]
    if (!snapshot) invalid('INVALID_EXPECTED_SNAPSHOTS', 'expected_snapshots必须覆盖全部选中项')
    map.set(String(id), snapshot.snapshot ?? snapshot)
  }
  return map
}

function parsePage(input = {}) {
  const page = integer(input.page ?? 1, { min: 1, max: 1_000_000, code: 'INVALID_PAGE' })
  const pageSize = integer(input.pageSize ?? 50, { min: 1, max: 500, code: 'INVALID_PAGE_SIZE' })
  return { page, pageSize, offset: (page - 1) * pageSize }
}

function requireTimestamp(value) {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) invalid('EXPECTED_UPDATED_AT_REQUIRED', '必须提供expected_updated_at')
  return value
}

function strategyDto(row) {
  const item = Object.fromEntries(STRATEGY_COLUMNS.map(column => [column, clone(row[column])]))
  const preview = buildNextRequestPreviewModel({
    requestType: item.request_type,
    activeTargets: item.active_targets || [],
    date: item.date,
    month: item.month,
    minRead: item.min_read,
    maxRead: item.max_read,
    cursor: item.cursor,
    cycleNo: item.cycle_no,
    completedItems: item.completed_items || []
  })
  item.expected_requests = preview.expectedRequests
  item.completed_requests = preview.completedRequests
  item.next_request = preview.nextRequest
  item.capability = clone(EXECUTION_CAPABILITY)
  return item
}

function strategyCasFilters(row) {
  return [
    { column: 'id', operator: 'eq', value: row.id },
    { column: 'updated_at', operator: row.updated_at === null ? 'is' : 'eq', value: row.updated_at }
  ]
}

function lockKey(ids) {
  return ids.map(positiveId).sort((left, right) => left - right).join(',')
}

export function createHotwordsStrategiesService({ client, now = () => new Date().toISOString() } = {}) {
  if (!client) throw new TypeError('Supabase client is required')
  const locks = new Map()

  async function withMergeLock(ids, operation) {
    const key = lockKey(ids)
    const previous = locks.get(key) ?? Promise.resolve()
    let release
    const next = new Promise(resolve => { release = resolve })
    locks.set(key, next)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (locks.get(key) === next) locks.delete(key)
    }
  }

  async function readHotword(id) {
    return (await client.get('hotwords', positiveId(id), { columns: HOTWORD_COLUMNS })).data
  }

  async function readOptionalHotword(id) {
    try {
      return await readHotword(id)
    } catch (error) {
      if (error?.status === 404 || error?.code === 'NOT_FOUND') return null
      throw error
    }
  }

  async function listHotwords(input = {}) {
    const { page, pageSize, offset } = parsePage(input)
    const filters = []
    if (input.statDate !== undefined && input.statDate !== null && input.statDate !== '') filters.push({ column: 'stat_date', operator: 'eq', value: validDate(input.statDate, true) })
    const keyword = input.keyword === undefined || input.keyword === null || input.keyword === '' ? undefined : requiredText(input.keyword, 50)
    const sort = HOTWORD_SORT_FIELDS.has(input.sort) ? input.sort : 'stat_date'
    const direction = input.sortDir === 'asc' ? 'asc' : 'desc'
    const order = [
      { column: sort, direction, nulls: 'last' },
      ...(sort === 'stat_date' ? [] : [{ column: 'stat_date', direction: 'desc', nulls: 'last' }]),
      { column: 'id', direction: 'desc' }
    ]
    const result = await client.list('hotwords', {
      columns: HOTWORD_COLUMNS,
      filters,
      search: keyword ? { columns: ['hotword'], value: keyword } : undefined,
      order,
      limit: pageSize,
      offset,
      count: 'exact'
    })
    return { items: rowsOf(result).map(clone), total: result.total ?? null, page, pageSize }
  }

  async function listStrategyKeywords(input = {}) {
    const result = await listHotwords({
      keyword: input.search ?? input.keyword,
      page: input.page,
      pageSize: input.pageSize
    })
    return {
      items: result.items.map(row => ({ name: row.hotword, articleCount: row.article_count })),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize
    }
  }

  async function getHotword(id) {
    return { item: clone(await readHotword(id)) }
  }

  async function listHotwordHistory(id, input = {}) {
    const current = await readHotword(id)
    const { page, pageSize, offset } = parsePage(input)
    const result = await client.list('hotwords', {
      columns: HOTWORD_COLUMNS,
      filters: [{ column: 'hotword', operator: 'eq', value: current.hotword }],
      order: [
        { column: 'stat_date', direction: 'asc', nulls: 'last' },
        { column: 'id', direction: 'asc' }
      ],
      limit: pageSize,
      offset,
      count: 'exact'
    })
    return { hotword: current.hotword, items: rowsOf(result).map(clone), total: result.total ?? null, page, pageSize }
  }

  async function listHotwordArticles(id, input = {}) {
    const hotwordId = positiveId(id)
    const { page, pageSize, offset } = parsePage(input)
    const filters = [{ column: 'hotword_id', operator: 'eq', value: hotwordId }]
    if (input.statDate) filters.push({ column: 'stat_date', operator: 'eq', value: validDate(input.statDate, true) })
    const result = await client.list('hotword_articles', { columns: ['id', 'hotword_id', 'article_id', 'article_key', 'stat_date', 'source_platforms', 'matched_terms', 'created_at', 'updated_at'], filters, order: [{ column: 'stat_date', direction: 'desc' }, { column: 'article_key', direction: 'asc' }], limit: pageSize, offset, count: 'exact' })
    const relations = rowsOf(result)
    const articleIds = [...new Set(relations.map(row => Number(row.article_id)).filter(Number.isSafeInteger))]
    const articleKeys = [...new Set(relations.map(row => typeof row.article_key === 'string' ? row.article_key.trim() : '').filter(Boolean))]
    const articleMap = new Map()
    const articleMapByKey = new Map()
    for (let index = 0; index < articleIds.length; index += 1_000) {
      const batch = articleIds.slice(index, index + 1_000)
      const articles = await client.list('articles', { columns: ['id', 'article_key', 'account_id', 'article_sn', 'idx', 'title', 'article_url', 'published_at', 'read_num', 'like_num'], relations: [{ table: 'accounts', columns: ['wx_biz', 'wx_name'] }], filters: [{ column: 'id', operator: 'in', value: batch }], limit: batch.length })
      for (const article of rowsOf(articles)) {
        articleMap.set(Number(article.id), article)
        if (article.article_key) articleMapByKey.set(String(article.article_key), article)
      }
    }
    for (let index = 0; index < articleKeys.length; index += 1_000) {
      const batch = articleKeys.slice(index, index + 1_000)
      const articles = await client.list('articles', { columns: ['id', 'article_key', 'account_id', 'article_sn', 'idx', 'title', 'article_url', 'published_at', 'read_num', 'like_num'], relations: [{ table: 'accounts', columns: ['wx_biz', 'wx_name'] }], filters: [{ column: 'article_key', operator: 'in', value: batch }], limit: batch.length })
      for (const article of rowsOf(articles)) {
        articleMap.set(Number(article.id), article)
        if (article.article_key) articleMapByKey.set(String(article.article_key), article)
      }
    }
    return { items: relations.map(row => ({ ...row, article: articleMap.get(Number(row.article_id)) || articleMapByKey.get(String(row.article_key || '')) || null })), total: result.total ?? null, page, pageSize }
  }

  async function listArticleHotwords(articleKeyValue) {
    const articleKey = requiredText(articleKeyValue, 1_000, 'INVALID_ARTICLE_KEY')
    const relationResult = await client.list('hotword_articles', { columns: ['id', 'hotword_id', 'article_id', 'article_key', 'stat_date', 'source_platforms', 'matched_terms', 'created_at', 'updated_at'], filters: [{ column: 'article_key', operator: 'eq', value: articleKey }], order: [{ column: 'stat_date', direction: 'desc' }], limit: 1_000 })
    const relations = rowsOf(relationResult)
    const ids = [...new Set(relations.map(row => Number(row.hotword_id)).filter(Number.isSafeInteger))]
    const byId = new Map()
    for (let index = 0; index < ids.length; index += 1_000) {
      const result = await client.list('hotwords', { columns: HOTWORD_COLUMNS, filters: [{ column: 'id', operator: 'in', value: ids.slice(index, index + 1_000) }], limit: 1_000 })
      for (const row of rowsOf(result)) byId.set(Number(row.id), row)
    }
    return { article_key: articleKey, items: relations.map(row => ({ ...row, hotword: byId.get(Number(row.hotword_id)) || null })) }
  }

  async function updateHotword(id, input = {}) {
    const hotwordId = positiveId(id)
    const current = await readHotword(hotwordId)
    assertHotwordSnapshot(current, input.expected_snapshot)
    const payload = {}
    if (Object.hasOwn(input, 'hotword')) payload.hotword = requiredText(input.hotword, 50, 'INVALID_HOTWORD')
    if (Object.hasOwn(input, 'aliases')) {
      const aliases = normalizeTextArray(input.aliases, { maxItems: 100, maxLength: 50, code: 'INVALID_ALIASES' })
      payload.aliases = aliases.filter(alias => alias !== payload.hotword && alias !== current.hotword)
    }
    if (Object.hasOwn(input, 'article_url')) payload.article_url = optionalUrl(input.article_url)
    if (!Object.keys(payload).length) invalid('EMPTY_UPDATE', '没有可更新的热词字段')
    const result = await client.patch('hotwords', [
      ...hotwordCasFilters({ ...current, id: hotwordId })
    ], payload)
    if (rowsOf(result).length !== 1) throw conflict('HOTWORD_CONFLICT', '热词已变更，请重新加载')
    return { item: clone(await readHotword(hotwordId)) }
  }

  async function deleteHotword(id, input = {}) {
    const hotwordId = positiveId(id)
    const current = await readHotword(hotwordId)
    assertHotwordSnapshot(current, input.expected_snapshot)
    const result = await client.remove('hotwords', [
      ...hotwordCasFilters({ ...current, id: hotwordId })
    ])
    if (rowsOf(result).length !== 1) throw conflict('HOTWORD_DELETE_CONFLICT', '热词已变更或删除结果未知')
    if (await readOptionalHotword(hotwordId)) throw conflict('HOTWORD_DELETE_UNKNOWN', '热词删除后的状态未知')
    return { id: hotwordId, count: 1, deleted: true }
  }

  async function selectedHotwords(ids) {
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 100) invalid('INVALID_MERGE_IDS', '合并必须选择2到100条热词')
    const normalized = ids.map(positiveId)
    if (new Set(normalized).size !== normalized.length) invalid('DUPLICATE_ID', '合并项不能重复')
    const result = []
    for (const id of normalized) result.push(await readHotword(id))
    return { ids: normalized, rows: result }
  }

  async function mergePreview(input = {}) {
    if (input.target_id === undefined || input.target_id === null || input.target_id === '') invalid('HOTWORD_TARGET_REQUIRED', 'target_id不能为空')
    const { ids, rows } = await selectedHotwords(input.ids)
    const targetId = positiveId(input.target_id)
    if (!ids.includes(targetId)) invalid('TARGET_NOT_SELECTED', 'target_id必须属于ids')
    const computed = canonicalHotwordMerge({ rows, targetId }).target
    return {
      targetId,
      removedIds: ids.filter(id => id !== targetId),
      snapshots: rows.map(hotwordSnapshot),
      computed: clone(computed),
      date: computed.stat_date
    }
  }

  function resultFailure(id, error, fallbackCode, phase) {
    return { id, phase, code: error?.code || fallbackCode, message: error?.message || '写入失败' }
  }

  async function merge(input = {}) {
    if (input.target_id === undefined || input.target_id === null || input.target_id === '') invalid('HOTWORD_TARGET_REQUIRED', 'target_id不能为空')
    const selected = await selectedHotwords(input.ids)
    const targetId = positiveId(input.target_id)
    if (!selected.ids.includes(targetId)) invalid('TARGET_NOT_SELECTED', 'target_id必须属于ids')
    const expected = normalizeExpectedSnapshots(input.expected_snapshots, selected.ids)
    return withMergeLock(selected.ids, async () => {
      let current
      try {
        current = (await selectedHotwords(selected.ids)).rows
      } catch (error) {
        const survivingTarget = await readOptionalHotword(targetId)
        if (!survivingTarget || error?.status !== 404) throw error
        const computedAfterConcurrentChange = canonicalHotwordMerge({ rows: selected.rows, targetId }).target
        const retryPayload = Object.fromEntries(['hotword', 'aliases', 'stat_date', 'article_count', 'article_keys', 'article_url'].map(column => [column, clone(computedAfterConcurrentChange[column])]))
        const retryResult = await client.patch('hotwords', [
          ...hotwordCasFilters({ ...survivingTarget, id: targetId })
        ], retryPayload)
        return {
          status: 'partial',
          targetId,
          removedIds: [],
          row: clone(rowsOf(retryResult)[0] ?? survivingTarget),
          failed: selected.ids.filter(id => id !== targetId).map(id => resultFailure(id, error, 'HOTWORD_SOURCE_CONFLICT', 'source')),
          unknown: []
        }
      }
      for (const row of current) assertHotwordSnapshot(row, expected.get(String(row.id)))
      const computed = canonicalHotwordMerge({ rows: current, targetId }).target
      const sourceIds = selected.ids.filter(id => id !== targetId)
      const removedIds = []
      const failed = []
      const unknown = []
      const target = current.find(row => Number(row.id) === targetId)
      const targetPayload = Object.fromEntries(['hotword', 'aliases', 'stat_date', 'article_count', 'article_keys', 'article_url'].map(column => [column, clone(computed[column])]))
      let targetWriteOk = true

      try {
        const result = await client.patch('hotwords', [
          ...hotwordCasFilters({ ...target, id: targetId })
        ], targetPayload)
        if (rowsOf(result).length !== 1) {
          targetWriteOk = false
          failed.push(resultFailure(targetId, null, 'HOTWORD_TARGET_CONFLICT', 'target'))
        }
      } catch (error) {
        const readBack = await readOptionalHotword(targetId).catch(() => null)
        if (readBack && sameValue(hotwordSnapshot(readBack), { ...hotwordSnapshot(target), ...targetPayload })) {
          unknown.push({ id: targetId, phase: 'target', code: 'WRITE_RESULT_UNKNOWN', message: '目标写入响应未知但读回符合预期' })
        } else {
          targetWriteOk = false
          failed.push(resultFailure(targetId, error, 'HOTWORD_TARGET_WRITE_FAILED', 'target'))
        }
      }

      if (!targetWriteOk) {
        const row = await readOptionalHotword(targetId)
        return { status: 'partial', targetId, removedIds, row: clone(row), failed, unknown }
      }

      for (const sourceId of sourceIds) {
        const source = current.find(row => Number(row.id) === sourceId)
        try {
          const result = await client.remove('hotwords', [
            ...hotwordCasFilters({ ...source, id: sourceId })
          ])
          if (rowsOf(result).length === 1) removedIds.push(sourceId)
          else failed.push(resultFailure(sourceId, null, 'HOTWORD_SOURCE_CONFLICT', 'source'))
        } catch (error) {
          const readBack = await readOptionalHotword(sourceId).catch(() => null)
          if (!readBack) unknown.push({ id: sourceId, phase: 'source', code: 'DELETE_RESULT_UNKNOWN', message: '来源删除响应未知，需人工核对' })
          else failed.push(resultFailure(sourceId, error, 'HOTWORD_SOURCE_DELETE_FAILED', 'source'))
        }
      }

      const row = await readOptionalHotword(targetId)
      if (!row) failed.push(resultFailure(targetId, null, 'HOTWORD_TARGET_UNKNOWN', 'readback'))
      const status = failed.length || unknown.length || removedIds.length !== sourceIds.length ? 'partial' : 'success'
      return { status, targetId, removedIds, row: clone(row), failed, unknown }
    })
  }

  async function listStrategies(input = {}) {
    const { page, pageSize, offset } = parsePage(input)
    const result = await client.list('collection_strategy_groups', {
      columns: STRATEGY_COLUMNS,
      order: [{ column: 'updated_at', direction: 'desc' }, { column: 'id', direction: 'desc' }],
      limit: pageSize,
      offset,
      count: 'exact'
    })
    return { items: rowsOf(result).map(strategyDto), total: result.total ?? null, page, pageSize }
  }

  async function getStrategy(id) {
    const result = await client.get('collection_strategy_groups', positiveId(id), { columns: STRATEGY_COLUMNS })
    return { item: strategyDto(result.data) }
  }

  async function createStrategy(input = {}) {
    if (Object.hasOwn(input, 'completed_items') || Object.hasOwn(input, 'cycle_no')) invalid('STRATEGY_PROGRESS_READ_ONLY', 'completed_items和cycle_no只读')
    const config = validateStrategyConfig(input)
    const payload = { ...config, completed_items: [], cycle_no: 1 }
    const result = await client.insert('collection_strategy_groups', [payload])
    if (rowsOf(result).length !== 1) throw conflict('STRATEGY_CREATE_UNKNOWN', '策略创建结果未知')
    return { item: strategyDto(rowsOf(result)[0]) }
  }

  async function updateStrategy(id, input = {}) {
    const strategyId = positiveId(id)
    const expectedUpdatedAt = requireTimestamp(input.expected_updated_at)
    if (Object.hasOwn(input, 'completed_items') || Object.hasOwn(input, 'cycle_no')) invalid('STRATEGY_PROGRESS_READ_ONLY', 'completed_items和cycle_no只读')
    const current = (await client.get('collection_strategy_groups', strategyId, { columns: STRATEGY_COLUMNS })).data
    if (current.updated_at !== expectedUpdatedAt) throw conflict('STRATEGY_CONFLICT', '策略已变更，请重新加载')
    if (input.request_type !== undefined && input.request_type !== current.request_type) invalid('REQUEST_TYPE_IMMUTABLE', '已有策略不能就地切换request_type')
    const config = validateStrategyConfig(input, current)
    const payload = {}
    for (const column of STRATEGY_CONFIG_COLUMNS) {
      if (Object.hasOwn(input, column)) payload[column] = clone(config[column])
    }
    payload.updated_at = now()
    const result = await client.patch('collection_strategy_groups', [
      ...strategyCasFilters({ ...current, id: strategyId, updated_at: expectedUpdatedAt })
    ], payload)
    if (rowsOf(result).length !== 1) throw conflict('STRATEGY_CONFLICT', '策略已变更，请重新加载')
    const readBack = (await client.get('collection_strategy_groups', strategyId, { columns: STRATEGY_COLUMNS })).data
    return { item: strategyDto(readBack) }
  }

  async function deleteStrategy(id, input = {}) {
    const strategyId = positiveId(id)
    const expectedUpdatedAt = requireTimestamp(input.expected_updated_at)
    const current = (await client.get('collection_strategy_groups', strategyId, { columns: STRATEGY_COLUMNS })).data
    if (current.updated_at !== expectedUpdatedAt) throw conflict('STRATEGY_DELETE_CONFLICT', '策略已变更或不存在')
    const result = await client.remove('collection_strategy_groups', [
      ...strategyCasFilters({ ...current, id: strategyId, updated_at: expectedUpdatedAt })
    ])
    if (rowsOf(result).length !== 1) throw conflict('STRATEGY_DELETE_CONFLICT', '策略已变更或不存在')
    return { id: strategyId, count: 1, deleted: true }
  }

  async function executionCapability() {
    return clone(EXECUTION_CAPABILITY)
  }

  async function executeStrategy() {
    const error = new Error(EXECUTION_CAPABILITY.message)
    error.status = 501
    error.code = 'CAPABILITY_UNAVAILABLE'
    throw error
  }

  return Object.freeze({
    listHotwords,
    listStrategyKeywords,
    getHotword,
    listHotwordHistory,
    listHotwordArticles,
    listArticleHotwords,
    updateHotword,
    deleteHotword,
    mergePreview,
    merge,
    previewHotwordMerge: mergePreview,
    mergeHotwords: merge,
    listStrategies,
    getStrategy,
    createStrategy,
    updateStrategy,
    deleteStrategy,
    executionCapability,
    executeStrategy
  })
}

export const HOTWORD_FIELDS = HOTWORD_COLUMNS
export const STRATEGY_FIELDS = STRATEGY_COLUMNS
export const STRATEGY_REQUEST_TYPES = REQUEST_TYPES
export { WX_TYPE_TARGETS, canonicalHotwordMerge, mergeHotwordRow }
