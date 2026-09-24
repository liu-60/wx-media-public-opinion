import { ConfigValidationError, createConfigValidation } from './config-validation.mjs'

const validation = createConfigValidation()
const ACCOUNT_LIST_COLUMNS = ['account_id', 'wx_biz', 'wx_name', 'verify', 'decision_status', 'decision_source', 'read_median', 'read_max', 'updated_at']
const ACCOUNT_DETAIL_COLUMNS = ['account_id', 'wx_biz', 'wx_name', 'verify', 'description', 'decision_status', 'decision_source', 'read_median', 'read_max', 'filter_rule_id', 'updated_at']
const PROFILE_LIST_COLUMNS = ['account_id', 'wx_type', 'region', 'read_avg', 'active_days']
const PROFILE_DETAIL_COLUMNS = ['account_id', 'wx_user', 'avatar', 'wx_type', 'region', 'tags', 'last_pub_time', 'pub_count', 'active_days', 'read_avg', 'read_median', 'read_max', 'burst_count', 'burst_rate', 'look_avg', 'look_median', 'look_max', 'like_avg', 'like_median', 'like_max', 'share_avg', 'share_median', 'share_max', 'comment_avg', 'comment_median', 'comment_max', 'ori_count', 'manual_tags', 'collected_at']
const ARTICLE_COLUMNS = ['id', 'account_id', 'article_sn', 'idx', 'title', 'article_url', 'published_at', 'read_num', 'read_num_capped', 'like_num', 'look_num', 'share_num', 'comment_num', 'is_original', 'source_code', 'updated_at']
const ACCOUNT_PROFILE_RELATION = 'account_profiles'
const ACCOUNT_RELATION = 'accounts'
const PROFILE_COLLISION_COLUMNS = new Set(['account_id', 'read_median', 'read_max'])
const ACCOUNT_NUMERIC_FIELDS = Object.freeze({
  'account.read_median': { key: 'accountReadMedian', column: 'read_median' },
  'account.read_max': { key: 'accountReadMax', column: 'read_max' }
})
const PROFILE_NUMERIC_FIELDS = Object.freeze({
  'profile.read_avg': { key: 'profileReadAvg', column: 'read_avg' },
  'profile.read_median': { key: 'profileReadMedian', column: 'read_median' },
  'profile.read_max': { key: 'profileReadMax', column: 'read_max' },
  'profile.pub_count': { key: 'profilePubCount', column: 'pub_count' },
  'profile.active_days': { key: 'profileActiveDays', column: 'active_days' },
  'profile.burst_count': { key: 'profileBurstCount', column: 'burst_count' },
  'profile.burst_rate': { key: 'profileBurstRate', column: 'burst_rate' },
  'profile.look_avg': { key: 'profileLookAvg', column: 'look_avg' },
  'profile.look_median': { key: 'profileLookMedian', column: 'look_median' },
  'profile.look_max': { key: 'profileLookMax', column: 'look_max' },
  'profile.like_avg': { key: 'profileLikeAvg', column: 'like_avg' },
  'profile.like_median': { key: 'profileLikeMedian', column: 'like_median' },
  'profile.like_max': { key: 'profileLikeMax', column: 'like_max' },
  'profile.share_avg': { key: 'profileShareAvg', column: 'share_avg' },
  'profile.share_median': { key: 'profileShareMedian', column: 'share_median' },
  'profile.share_max': { key: 'profileShareMax', column: 'share_max' },
  'profile.comment_avg': { key: 'profileCommentAvg', column: 'comment_avg' },
  'profile.comment_median': { key: 'profileCommentMedian', column: 'comment_median' },
  'profile.comment_max': { key: 'profileCommentMax', column: 'comment_max' },
  'profile.ori_count': { key: 'profileOriCount', column: 'ori_count' }
})
const ACCOUNT_SORT_FIELDS = Object.freeze({
  account_id: { column: 'account_id' },
  updated_at: { column: 'updated_at' },
  'account.read_median': { column: 'read_median' },
  'account.read_max': { column: 'read_max' },
  'profile.last_pub_time': { relation: ACCOUNT_PROFILE_RELATION, column: 'last_pub_time' },
  'profile.collected_at': { relation: ACCOUNT_PROFILE_RELATION, column: 'collected_at' },
  'profile.pub_count': { relation: ACCOUNT_PROFILE_RELATION, column: 'pub_count' },
  'profile.active_days': { relation: ACCOUNT_PROFILE_RELATION, column: 'active_days' },
  'profile.read_avg': { relation: ACCOUNT_PROFILE_RELATION, column: 'read_avg' },
  'profile.read_median': { relation: ACCOUNT_PROFILE_RELATION, column: 'read_median' },
  'profile.read_max': { relation: ACCOUNT_PROFILE_RELATION, column: 'read_max' },
  'profile.burst_count': { relation: ACCOUNT_PROFILE_RELATION, column: 'burst_count' },
  'profile.burst_rate': { relation: ACCOUNT_PROFILE_RELATION, column: 'burst_rate' },
  'profile.look_avg': { relation: ACCOUNT_PROFILE_RELATION, column: 'look_avg' },
  'profile.look_median': { relation: ACCOUNT_PROFILE_RELATION, column: 'look_median' },
  'profile.look_max': { relation: ACCOUNT_PROFILE_RELATION, column: 'look_max' },
  'profile.like_avg': { relation: ACCOUNT_PROFILE_RELATION, column: 'like_avg' },
  'profile.like_median': { relation: ACCOUNT_PROFILE_RELATION, column: 'like_median' },
  'profile.like_max': { relation: ACCOUNT_PROFILE_RELATION, column: 'like_max' },
  'profile.share_avg': { relation: ACCOUNT_PROFILE_RELATION, column: 'share_avg' },
  'profile.share_median': { relation: ACCOUNT_PROFILE_RELATION, column: 'share_median' },
  'profile.share_max': { relation: ACCOUNT_PROFILE_RELATION, column: 'share_max' },
  'profile.comment_avg': { relation: ACCOUNT_PROFILE_RELATION, column: 'comment_avg' },
  'profile.comment_median': { relation: ACCOUNT_PROFILE_RELATION, column: 'comment_median' },
  'profile.comment_max': { relation: ACCOUNT_PROFILE_RELATION, column: 'comment_max' },
  'profile.ori_count': { relation: ACCOUNT_PROFILE_RELATION, column: 'ori_count' }
})

function invalid(code) {
  throw new ConfigValidationError(code)
}

function positiveId(value) {
  const id = validation.integer(value, { min: 1, max: Number.MAX_SAFE_INTEGER, required: true })
  return id
}

function optionalText(value, max = 500) {
  if (value === undefined || value === null || value === '') return undefined
  return validation.text(value, { max })
}

function range(value, name) {
  if (value === undefined || value === null || value === '') return undefined
  return validation.integer(value, { min: 0, max: Number.MAX_SAFE_INTEGER, required: true })
}

function rangePair(minValue, maxValue, minName, maxName) {
  const min = range(minValue, minName)
  const max = range(maxValue, maxName)
  if (min !== undefined && max !== undefined && min > max) invalid('INVALID_RANGE')
  return { min, max }
}

function numeric(value, required = true, decimal = false) {
  return decimal ? validation.number(value, { min: 0, max: Number.MAX_VALUE, required }) : validation.integer(value, { min: 0, max: Number.MAX_SAFE_INTEGER, required })
}

function numericFieldValue(field, value) {
  return numeric(value, true, field.column === 'burst_rate')
}

function requestedColumns(value, allowed, defaults) {
  if (value === undefined || value === null || value === '') return [...defaults]
  const raw = Array.isArray(value) ? value : String(value).split(',')
  const columns = [...new Set(raw.map(column => String(column).trim()).filter(Boolean))]
  if (!columns.length || columns.some(column => !allowed.includes(column))) invalid('INVALID_COLUMN')
  return columns
}

function addColumn(columns, column) {
  if (!columns.includes(column)) columns.push(column)
}

function numericFilters(input, config, filters) {
  for (const field of Object.values(config)) {
    const operatorInput = input[`${field.key}Op`]
    if (operatorInput === undefined || operatorInput === null || operatorInput === '') continue
    const operator = { eq: 'eq', gte: 'gte', lte: 'lte', gt: 'gt', lt: 'lt', range: 'range' }[String(operatorInput)]
    if (!operator) invalid('INVALID_OPERATOR')
    const value = numericFieldValue(field, input[`${field.key}Value`])
    if (operator === 'range') {
      const max = numericFieldValue(field, input[`${field.key}Max`])
      if (value > max) invalid('INVALID_RANGE')
      filters.push({ field, conditions: [{ column: field.column, operator: 'gte', value }, { column: field.column, operator: 'lte', value: max }] })
    } else {
      filters.push({ field, conditions: [{ column: field.column, operator, value }] })
    }
  }
}

function metricFilter(input, filters) {
  const fieldName = input.metricField
  if (fieldName === undefined || fieldName === null || fieldName === '') return
  if (input.metricOp === undefined || input.metricOp === null || input.metricOp === '') return
  const field = ACCOUNT_NUMERIC_FIELDS[fieldName] || PROFILE_NUMERIC_FIELDS[fieldName]
  if (!field) invalid('INVALID_COLUMN')
  const operator = { eq: 'eq', gte: 'gte', lte: 'lte', gt: 'gt', lt: 'lt', range: 'range' }[String(input.metricOp)]
  if (!operator) invalid('INVALID_OPERATOR')
  const value = numericFieldValue(field, input.metricValue)
  if (operator === 'range') {
    const max = numericFieldValue(field, input.metricMax)
    if (value > max) invalid('INVALID_RANGE')
    filters.push({ field, conditions: [{ column: field.column, operator: 'gte', value }, { column: field.column, operator: 'lte', value: max }] })
  } else {
    filters.push({ field, conditions: [{ column: field.column, operator, value }] })
  }
}

function flattenNumericConditions(groups, target, profileTarget) {
  for (const group of groups) {
    const destination = Object.values(PROFILE_NUMERIC_FIELDS).includes(group.field) ? profileTarget : target
    for (const condition of group.conditions) destination.push(condition)
  }
}

function sortOptions(input) {
  const requested = input.sort === undefined || input.sort === null || input.sort === '' ? 'updated_at' : String(input.sort)
  const field = ACCOUNT_SORT_FIELDS[requested]
  if (!field) invalid('INVALID_ORDER')
  const direction = input.sortDir === undefined || input.sortDir === '' ? 'desc' : String(input.sortDir)
  if (!['asc', 'desc'].includes(direction)) invalid('INVALID_ORDER')
  const primary = { ...field, direction, ...(field.relation ? { nulls: 'last' } : {}) }
  const order = [primary]
  if (requested !== 'account_id') order.push({ column: 'account_id', direction: 'asc' })
  return order
}

function pageOptions(input = {}) {
  const { page, pageSize, offset } = validation.parsePageQuery(input)
  return { page, pageSize, offset }
}

function isoTimestamp(value, required = true) {
  if (value === undefined || value === null || value === '') {
    if (required) invalid('TIMESTAMP_REQUIRED')
    return undefined
  }
  if (typeof value !== 'string' || /[\r\n]/u.test(value) || Number.isNaN(Date.parse(value))) invalid('INVALID_TIMESTAMP')
  return value
}

function utcDate(value, required = false) {
  return validation.date(value, { required })
}

function nextUtcDate(date) {
  const next = new Date(`${date}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString()
}

function normalizeTags(value) {
  if (!Array.isArray(value)) invalid('INVALID_TEXT_ARRAY')
  const result = []
  const seen = new Set()
  for (const item of value) {
    const tag = validation.text(item, { required: true, max: 50 })
    if (!seen.has(tag)) {
      seen.add(tag)
      result.push(tag)
    }
  }
  if (result.length > 50) invalid('INVALID_TEXT_ARRAY')
  return result
}

function normalizeExpectedTags(value) {
  if (value === undefined) {
    const error = new Error('Profile has no reliable compare-and-swap value')
    error.status = 409
    error.code = 'CAPABILITY_UNAVAILABLE'
    throw error
  }
  if (value === null) return null
  return normalizeTags(value)
}

function jsonFilterValue(value) {
  if (value === null) return { operator: 'is', value: null }
  return { operator: 'eq', value: JSON.stringify(value) }
}

function profileFromRow(row) {
  if (!row) return null
  if (Array.isArray(row)) return row[0] || null
  return row
}

function accountDto(row, { detail = false, accountColumns = ACCOUNT_LIST_COLUMNS, profileColumns = PROFILE_LIST_COLUMNS } = {}) {
  const profile = profileFromRow(row.account_profiles)
  const result = {}
  for (const column of accountColumns) result[column] = row[column]
  for (const column of profileColumns) {
    const value = profile?.[column]
    result[PROFILE_COLLISION_COLUMNS.has(column) ? `profile_${column}` : column] = value
    result[`profile_${column}`] = value
  }
  if (detail) {
    result.description = row.description
    result.filter_rule_id = row.filter_rule_id
    result.profile = profile ? Object.fromEntries(PROFILE_DETAIL_COLUMNS.map(column => [column, profile[column]])) : null
  }
  return result
}

function articleDto(row, { detail = false } = {}) {
  const result = Object.fromEntries(ARTICLE_COLUMNS.map(column => [column, row[column]]))
  const account = row[ACCOUNT_RELATION]
  result.publisher = account?.wx_name
  if (detail) result.account = account ? { account_id: account.account_id, wx_name: account.wx_name } : undefined
  return result
}

function resultRows(result) {
  return Array.isArray(result?.data) ? result.data : []
}

function upstreamError(error, fallbackCode) {
  if (error?.status) return error
  const wrapped = new Error('Service unavailable')
  wrapped.status = 503
  wrapped.code = fallbackCode
  return wrapped
}

export function createAccountsArticlesService({ client, now = () => new Date().toISOString() } = {}) {
  if (!client) throw new TypeError('Supabase client is required')

  async function getAccount(id) {
    const accountId = positiveId(id)
    const result = await client.get('accounts', accountId, {
      columns: ACCOUNT_DETAIL_COLUMNS,
      relations: [{ table: ACCOUNT_PROFILE_RELATION, columns: PROFILE_DETAIL_COLUMNS, join: 'left' }]
    })
    return { item: accountDto(result.data, { detail: true, accountColumns: ACCOUNT_DETAIL_COLUMNS, profileColumns: PROFILE_DETAIL_COLUMNS }) }
  }

  async function listAccounts(input = {}) {
    const { page, pageSize, offset } = pageOptions({ ...input, pageSize: input.pageSize ?? 100 })
    const search = input.search ?? input.keyword
    const accountColumns = requestedColumns(input.accountColumns, ACCOUNT_LIST_COLUMNS.concat(['description', 'filter_rule_id']), ACCOUNT_LIST_COLUMNS)
    const profileColumns = requestedColumns(input.profileColumns, PROFILE_DETAIL_COLUMNS, PROFILE_LIST_COLUMNS)
    const filters = []
    const decisionStatusInput = input.decisionStatus ?? input.status
    if (decisionStatusInput !== undefined && decisionStatusInput !== null && decisionStatusInput !== '') {
      filters.push({ column: 'decision_status', operator: 'eq', value: validation.integer(decisionStatusInput, { min: 0, max: 3, required: true }) })
    }
    const decisionSource = optionalText(input.decisionSource, 16)
    if (decisionSource !== undefined) filters.push({ column: 'decision_source', operator: 'eq', value: decisionSource })
    const updatedStartDate = utcDate(input.updatedStartDate ?? input.startDate)
    const updatedEndDate = utcDate(input.updatedEndDate ?? input.endDate)
    if (updatedStartDate) filters.push({ column: 'updated_at', operator: 'gte', value: `${updatedStartDate}T00:00:00.000Z` })
    if (updatedEndDate) filters.push({ column: 'updated_at', operator: 'lt', value: nextUtcDate(updatedEndDate) })
    const legacyRead = rangePair(input.readMedianMin ?? input.minRead, input.readMedianMax ?? input.maxRead, 'readMedianMin', 'readMedianMax')
    if (legacyRead.min !== undefined) filters.push({ column: 'read_median', operator: 'gte', value: legacyRead.min })
    if (legacyRead.max !== undefined) filters.push({ column: 'read_median', operator: 'lte', value: legacyRead.max })
    const profileFilters = []
    const wxType = optionalText(input.wxType, 64)
    const region = optionalText(input.region, 64)
    if (wxType !== undefined) profileFilters.push({ column: 'wx_type', operator: 'eq', value: wxType })
    if (region !== undefined) profileFilters.push({ column: 'region', operator: 'eq', value: region })
    const numericGroups = []
    numericFilters(input, ACCOUNT_NUMERIC_FIELDS, numericGroups)
    numericFilters(input, PROFILE_NUMERIC_FIELDS, numericGroups)
    metricFilter(input, numericGroups)
    const accountNumericFilters = []
    const profileNumericFilters = []
    flattenNumericConditions(numericGroups, accountNumericFilters, profileNumericFilters)
    filters.push(...accountNumericFilters)
    profileFilters.push(...profileNumericFilters)
    const legacyActive = rangePair(input.activeDaysMin ?? input.minActive, input.activeDaysMax ?? input.maxActive, 'activeDaysMin', 'activeDaysMax')
    if (legacyActive.min !== undefined) profileFilters.push({ column: 'active_days', operator: 'gte', value: legacyActive.min })
    if (legacyActive.max !== undefined) profileFilters.push({ column: 'active_days', operator: 'lte', value: legacyActive.max })
    const verified = input.verified ?? input.hasVerify
    if (verified === 'yes' || verified === true || verified === 'true') filters.push({ column: 'verify', operator: 'not.is', value: null })
    if (verified === 'no' || verified === false || verified === 'false') filters.push({ column: 'verify', operator: 'is', value: null })
    const profileExists = input.profileExists ?? input.hasProfile
    if (!['', undefined, null, 'yes', 'no', true, false, 'true', 'false'].includes(profileExists)) invalid('INVALID_ENUM')
    if (['no', false, 'false'].includes(profileExists) && profileFilters.length) invalid('INVALID_FILTER')
    const requestedSort = sortOptions(input)
    for (const order of requestedSort) {
      if (order.relation) addColumn(profileColumns, order.column)
      else addColumn(accountColumns, order.column)
    }
    for (const condition of accountNumericFilters) addColumn(accountColumns, condition.column)
    for (const condition of profileNumericFilters) addColumn(profileColumns, condition.column)
    const relation = {
      table: ACCOUNT_PROFILE_RELATION,
      columns: profileColumns,
      join: profileFilters.length ? 'inner' : 'left',
      filters: profileFilters,
      ...(profileExists === 'yes' || profileExists === true || profileExists === 'true' ? { presence: 'exists' } : {}),
      ...(profileExists === 'no' || profileExists === false || profileExists === 'false' ? { presence: 'missing' } : {})
    }
    const result = await client.list('accounts', {
      columns: accountColumns,
      relations: [relation],
      search: search === undefined || search === '' ? undefined : { columns: ['wx_name', 'wx_biz'], value: validation.text(search, { max: 128 }), mode: input.searchMode === 'exact' ? 'exact' : 'contains' },
      filters,
      order: requestedSort,
      limit: pageSize,
      offset,
      count: 'exact'
    })
    return { items: (Array.isArray(result.data) ? result.data : []).map(row => accountDto(row, { accountColumns, profileColumns })), total: result.total ?? null, page, pageSize, search: search || '', sort: requestedSort }
  }

  async function listStrategyAccounts(input = {}) {
    const { page, pageSize, offset } = pageOptions({ ...input, pageSize: input.pageSize ?? 50 })
    const searchValue = optionalText(input.search ?? input.keyword, 128)
    const rawIds = input.ids === undefined || input.ids === null || input.ids === '' ? [] : Array.isArray(input.ids) ? input.ids : String(input.ids).split(',').map(value => value.trim()).filter(Boolean)
    if (rawIds.length > 100) invalid('INVALID_IDS')
    const ids = [...new Set(rawIds.map(positiveId))]
    const filters = ids.length ? [{ column: 'account_id', operator: 'in', value: ids }] : []
    const result = await client.list('accounts', {
      columns: ['account_id', 'wx_biz', 'wx_name', 'read_median'],
      relations: [{ table: ACCOUNT_PROFILE_RELATION, columns: ['account_id', 'avatar', 'active_days'], join: 'left' }],
      filters,
      search: searchValue ? { columns: ['wx_name', 'wx_biz'], value: searchValue } : undefined,
      order: [
        { relation: ACCOUNT_PROFILE_RELATION, column: 'active_days', direction: 'desc', nulls: 'last' },
        { column: 'read_median', direction: 'desc', nulls: 'last' },
        { column: 'account_id', direction: 'asc' }
      ],
      limit: pageSize,
      offset,
      count: 'exact'
    })
    return {
      items: (Array.isArray(result.data) ? result.data : []).map(row => {
        const profile = profileFromRow(row.account_profiles)
        return { id: row.account_id, key: row.wx_biz, name: row.wx_name, avatar: profile?.avatar ?? null, activeDays: profile?.active_days ?? null, medianReading: row.read_median ?? null }
      }),
      total: result.total ?? null,
      page,
      pageSize
    }
  }

  async function patchAccountDecision(id, input = {}) {
    const accountId = positiveId(id)
    const restore = input.restore_decision && typeof input.restore_decision === 'object' && !Array.isArray(input.restore_decision) ? input.restore_decision : null
    const decisionStatus = validation.integer(restore ? restore.decision_status : input.decision_status, { min: 0, max: 3, required: true })
    const expectedDecision = input.expected_decision && typeof input.expected_decision === 'object' ? input.expected_decision : input.expectedDecision && typeof input.expectedDecision === 'object' ? input.expectedDecision : null
    const expectedStatusInput = expectedDecision ? expectedDecision.decision_status : input.expected_decision_status
    const expectedStatus = expectedStatusInput === null ? null : validation.integer(expectedStatusInput, { min: 0, max: 3, required: true })
    const expectedUpdatedAt = isoTimestamp(input.expected_updated_at)
    const filters = [
      { column: 'account_id', operator: 'eq', value: accountId },
      expectedStatus === null ? { column: 'decision_status', operator: 'is', value: null } : { column: 'decision_status', operator: 'eq', value: expectedStatus },
      { column: 'updated_at', operator: 'eq', value: expectedUpdatedAt }
    ]
    if (expectedDecision && Object.hasOwn(expectedDecision, 'decision_source')) {
      filters.push(expectedDecision.decision_source === null
        ? { column: 'decision_source', operator: 'is', value: null }
        : { column: 'decision_source', operator: 'eq', value: optionalText(expectedDecision.decision_source, 16) })
    }
    if (expectedDecision && Object.hasOwn(expectedDecision, 'filter_rule_id')) {
      filters.push(expectedDecision.filter_rule_id === null
        ? { column: 'filter_rule_id', operator: 'is', value: null }
        : { column: 'filter_rule_id', operator: 'eq', value: positiveId(expectedDecision.filter_rule_id) })
    }
    const targetSource = restore && Object.hasOwn(restore, 'decision_source')
      ? restore.decision_source === null ? null : optionalText(restore.decision_source, 16)
      : 'manual'
    const targetRule = restore && Object.hasOwn(restore, 'filter_rule_id')
      ? restore.filter_rule_id === null ? null : positiveId(restore.filter_rule_id)
      : null
    const result = await client.patch('accounts', filters, { decision_status: decisionStatus, decision_source: targetSource, filter_rule_id: targetRule })
    if (!resultRows(result).length) {
      const error = new Error('Decision changed before save')
      error.status = 409
      error.code = 'ACCOUNT_DECISION_CONFLICT'
      throw error
    }
    return getAccount(accountId)
  }

  async function bulkAccountDecision(ids, input = {}) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100) invalid('INVALID_IDS')
    const normalizedIds = ids.map(positiveId)
    if (new Set(normalizedIds).size !== normalizedIds.length) invalid('DUPLICATE_ID')
    const decisionStatus = validation.integer(input.decision_status, { min: 0, max: 3, required: true })
    const expected = input.expected_decisions && typeof input.expected_decisions === 'object' && !Array.isArray(input.expected_decisions) ? input.expected_decisions : null
    const currentResult = await client.list('accounts', {
      columns: ['account_id', 'decision_status', 'decision_source', 'filter_rule_id', 'updated_at'],
      filters: [{ column: 'account_id', operator: 'in', value: normalizedIds }],
      limit: normalizedIds.length
    })
    const currentById = new Map(resultRows(currentResult).map(row => [Number(row.account_id), row]))
    const failed = []
    const writableIds = []
    for (const id of normalizedIds) {
      const current = currentById.get(id)
      if (!current) {
        failed.push({ id, code: 'ACCOUNT_NOT_FOUND', message: '账号不存在' })
        continue
      }
      const snapshot = expected?.[String(id)]
      if (snapshot && (
        Number(snapshot.decision_status) !== Number(current.decision_status)
        || (snapshot.decision_source ?? null) !== (current.decision_source ?? null)
        || (snapshot.filter_rule_id ?? null) !== (current.filter_rule_id ?? null)
        || snapshot.updated_at !== current.updated_at
      )) {
        failed.push({ id, code: 'ACCOUNT_DECISION_CONFLICT', message: '账号已被其他操作修改' })
        continue
      }
      writableIds.push(id)
    }
    if (!writableIds.length) return { count: 0, requestedCount: normalizedIds.length, succeededIds: [], failed }
    const result = await client.patch('accounts', [{ column: 'account_id', operator: 'in', value: writableIds }], {
      decision_status: decisionStatus,
      decision_source: 'manual',
      filter_rule_id: null
    })
    const succeededIds = resultRows(result).map(row => Number(row.account_id)).filter(id => writableIds.includes(id))
    if (!succeededIds.length) {
      return {
        count: 0,
        requestedCount: normalizedIds.length,
        succeededIds: [],
        failed: [...failed, ...writableIds.map(id => ({ id, code: 'BULK_WRITE_UNKNOWN', message: '写入结果无法确认' }))]
      }
    }
    const succeededSet = new Set(succeededIds)
    return {
      count: succeededIds.length,
      requestedCount: normalizedIds.length,
      succeededIds,
      failed: [...failed, ...writableIds.filter(id => !succeededSet.has(id)).map(id => ({ id, code: 'BULK_WRITE_UNKNOWN', message: '写入结果无法确认' }))]
    }
  }

  async function readProfile(accountId) {
    const result = await client.list('account_profiles', { columns: PROFILE_DETAIL_COLUMNS, filters: [{ column: 'account_id', operator: 'eq', value: accountId }], limit: 1 })
    return resultRows(result)[0] || null
  }

  async function patchAccountTags(id, input = {}) {
    const accountId = positiveId(id)
    const manualTags = normalizeTags(input.manual_tags)
    const expectedTags = normalizeExpectedTags(input.expected_manual_tags)
    if (input.expected_updated_at !== undefined) isoTimestamp(input.expected_updated_at)
    const current = await readProfile(accountId)
    if (!current) {
      if (expectedTags !== null) {
        const error = new Error('Profile state is no longer known')
        error.status = 409
        error.code = 'CAPABILITY_UNAVAILABLE'
        throw error
      }
      let inserted
      try {
        inserted = await client.insert('account_profiles', [{ account_id: accountId, manual_tags: manualTags }])
        if (!resultRows(inserted).length) {
          const error = new Error('Profile insert result is unknown')
          error.status = 409
          error.code = 'CAPABILITY_UNAVAILABLE'
          throw error
        }
      } catch (error) {
        if (error?.status === 409) {
          await readProfile(accountId).catch(() => null)
          const conflict = new Error('Profile changed before save')
          conflict.status = 409
          conflict.code = 'TAGS_CONFLICT'
          throw conflict
        }
        throw upstreamError(error, 'PROFILE_WRITE_FAILED')
      }
      return { item: insertedRow(inserted, accountId) }
    }
    const expectedFilter = jsonFilterValue(expectedTags)
    const result = await client.patch('account_profiles', [
      { column: 'account_id', operator: 'eq', value: accountId },
      { column: 'manual_tags', ...expectedFilter }
    ], { manual_tags: manualTags })
    if (!resultRows(result).length) {
      const error = new Error('Tags changed before save')
      error.status = 409
      error.code = 'TAGS_CONFLICT'
      throw error
    }
    return { item: resultRows(result)[0] }
  }

  function insertedRow(result, accountId) {
    return resultRows(result)[0] || { account_id: accountId, manual_tags: undefined }
  }

  async function listArticles(input = {}) {
    const { page, pageSize, offset } = pageOptions(input)
    const filters = []
    if (input.accountId !== undefined && input.accountId !== null && input.accountId !== '') filters.push({ column: 'account_id', operator: 'eq', value: positiveId(input.accountId) })
    const title = optionalText(input.title ?? input.keyword, 500)
    const from = utcDate(input.from)
    const to = utcDate(input.to)
    if (from) filters.push({ column: 'published_at', operator: 'gte', value: `${from}T00:00:00.000Z` })
    if (to) filters.push({ column: 'published_at', operator: 'lt', value: nextUtcDate(to) })
    if (input.isOriginal !== undefined && input.isOriginal !== null && input.isOriginal !== '') {
      if (input.isOriginal === 'unknown') filters.push({ column: 'is_original', operator: 'is', value: null })
      else if (input.isOriginal === true || input.isOriginal === 'true') filters.push({ column: 'is_original', operator: 'eq', value: true })
      else if (input.isOriginal === false || input.isOriginal === 'false') filters.push({ column: 'is_original', operator: 'eq', value: false })
      else invalid('INVALID_ENUM')
    }
    const ranges = [
      ['read_num', input.readMin, input.readMax],
      ['like_num', input.likeMin, input.likeMax],
      ['comment_num', input.commentMin, input.commentMax],
      ['share_num', input.shareMin, input.shareMax]
    ]
    for (const [column, minValue, maxValue] of ranges) {
      const pair = rangePair(minValue, maxValue, `${column}Min`, `${column}Max`)
      if (pair.min !== undefined) filters.push({ column, operator: 'gte', value: pair.min })
      if (pair.max !== undefined) filters.push({ column, operator: 'lte', value: pair.max })
    }
    const result = await client.list('articles', {
      columns: ARTICLE_COLUMNS,
      relations: [{ table: ACCOUNT_RELATION, columns: ['account_id', 'wx_name'], join: 'left' }],
      search: title === undefined ? undefined : { columns: ['title'], value: title },
      filters,
      order: [{ column: 'published_at', direction: 'desc', nulls: 'last' }, { column: 'id', direction: 'desc' }],
      limit: pageSize,
      offset,
      count: 'exact'
    })
    return { items: (Array.isArray(result.data) ? result.data : []).map(row => articleDto(row)), total: result.total ?? null, page, pageSize }
  }

  async function getArticle(id) {
    const articleId = positiveId(id)
    const result = await client.get('articles', articleId, {
      columns: ARTICLE_COLUMNS,
      relations: [{ table: ACCOUNT_RELATION, columns: ['account_id', 'wx_name'], join: 'left' }]
    })
    return { item: articleDto(result.data, { detail: true }) }
  }

  async function deleteArticle(id, input = {}) {
    const articleId = positiveId(id)
    const expectedUpdatedAt = isoTimestamp(input.expected_updated_at)
    const result = await client.remove('articles', [
      { column: 'id', operator: 'eq', value: articleId },
      { column: 'updated_at', operator: 'eq', value: expectedUpdatedAt }
    ])
    const rows = resultRows(result).filter(row => Number(row.id) === articleId)
    if (rows.length !== 1) {
      const error = new Error('Article changed before delete')
      error.status = 409
      error.code = 'ARTICLE_DELETE_CONFLICT'
      throw error
    }
    return { id: articleId, rows: 1, deleted: true }
  }

  async function bulkDeleteArticles(ids, input = {}) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100) invalid('INVALID_IDS')
    const normalizedIds = ids.map(positiveId)
    if (new Set(normalizedIds).size !== normalizedIds.length) invalid('DUPLICATE_ID')
    const expected = input.expected_updated_atById
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) invalid('INVALID_EXPECTED_VERSIONS')
    const expectedKeys = Object.keys(expected).map(Number).sort((a, b) => a - b)
    if (expectedKeys.length !== normalizedIds.length || expectedKeys.some((id, index) => id !== [...normalizedIds].sort((a, b) => a - b)[index])) invalid('INVALID_EXPECTED_VERSIONS')
    for (const id of normalizedIds) isoTimestamp(expected[String(id)])
    const succeededIds = []
    const failed = []
    for (const id of normalizedIds) {
      try {
        await deleteArticle(id, { expected_updated_at: expected[String(id)] })
        succeededIds.push(id)
      } catch (error) {
        failed.push({ id, code: error.code || 'DELETE_FAILED', message: error.status === 409 ? '记录已变更，请重新加载' : '删除失败' })
      }
    }
    return { count: succeededIds.length, requestedCount: normalizedIds.length, succeededIds, failed }
  }

  return Object.freeze({ listAccounts, listStrategyAccounts, getAccount, patchAccountDecision, bulkAccountDecision, patchAccountTags, listArticles, getArticle, deleteArticle, bulkDeleteArticles })
}
