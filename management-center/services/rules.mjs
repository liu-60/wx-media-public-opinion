import { ConfigValidationError, createConfigValidation } from './config-validation.mjs'

const validation = createConfigValidation()

const FIELD_DEFINITIONS = [
  { scope: 'account', field_name: 'name', label: '公众号名称', business_field: 'accounts.wx_name', type: 'text', operators: ['contains', 'not_contains', 'eq'] },
  { scope: 'account', field_name: 'verification', label: '认证主体', business_field: 'accounts.verify', type: 'text', operators: ['contains', 'not_contains', 'eq'] },
  { scope: 'account', field_name: 'description', label: '简介', business_field: 'accounts.description', type: 'text', operators: ['contains', 'not_contains', 'eq'] },
  { scope: 'account', field_name: 'read_median', label: '中位阅读', business_field: 'accounts.read_median', type: 'number', operators: ['eq', 'gt', 'gte', 'lt', 'lte'] },
  { scope: 'article', field_name: 'title', label: '标题', business_field: 'articles.title', type: 'text', operators: ['contains', 'not_contains', 'eq'] },
  { scope: 'article', field_name: 'read_count', label: '阅读', business_field: 'articles.read_num', type: 'number', operators: ['eq', 'gt', 'gte', 'lt', 'lte'] },
  { scope: 'article', field_name: 'like_count', label: '点赞', business_field: 'articles.like_num', type: 'number', operators: ['eq', 'gt', 'gte', 'lt', 'lte'] },
  { scope: 'article', field_name: 'comment_count', label: '评论', business_field: 'articles.comment_num', type: 'number', operators: ['eq', 'gt', 'gte', 'lt', 'lte'] },
  { scope: 'hotword', field_name: 'hotword', label: '热词', business_field: 'hotwords.hotword', type: 'text', operators: ['exact', 'contains'] }
]

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

const fieldDictionary = {}
for (const definition of FIELD_DEFINITIONS) {
  fieldDictionary[definition.scope] ??= {}
  fieldDictionary[definition.scope][definition.field_name] = { ...definition }
}

export const RULE_FIELDS = deepFreeze(fieldDictionary)
export const RULE_FIELD_DICTIONARY = RULE_FIELDS
export const FIELD_DICTIONARY = RULE_FIELDS
export const RULE_COLUMNS = Object.freeze(['id', 'scope', 'field_name', 'operator', 'value_text', 'value_number', 'enabled', 'hit_count', 'remark', 'created_at', 'updated_at'])
export const RULE_GROUPS = Object.freeze(FIELD_DEFINITIONS.flatMap(definition => definition.operators.map(operator => Object.freeze({
  key: `${definition.scope}|${definition.field_name}|${operator}`,
  scope: definition.scope,
  field_name: definition.field_name,
  operator,
  label: definition.label,
  type: definition.type,
  business_field: definition.business_field
}))))

const RULE_GROUP_BY_KEY = new Map(RULE_GROUPS.map(group => [group.key, group]))
const EDITABLE_FIELDS = new Set(['scope', 'field_name', 'operator', 'value_text', 'value_number', 'enabled', 'remark'])
const CREATE_KEYS = new Set(['scope', 'field_name', 'operator', 'value', 'value_text', 'value_number', 'enabled', 'remark'])
const UPDATE_KEYS = new Set([...CREATE_KEYS, 'expected_updated_at'])
const READ_ONLY_FIELDS = new Set(['id', 'hit_count', 'created_at', 'updated_at'])
const GROUP_READ_LIMIT = 5_000

function invalid(code, message = 'Invalid rule') {
  throw new ConfigValidationError(code, message)
}

function serviceError(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

function resultRows(result) {
  if (Array.isArray(result?.data)) return result.data
  if (result?.data && typeof result.data === 'object') return [result.data]
  return []
}

function assertObject(value, code = 'INVALID_PAYLOAD') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(code)
  return value
}

function assertAllowedKeys(input, allowed) {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      if (READ_ONLY_FIELDS.has(key)) invalid('READ_ONLY_FIELD')
      invalid('INVALID_COLUMN')
    }
  }
}

function normalizeId(value) {
  const id = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/u.test(value.trim()) ? Number(value) : NaN)
  if (!Number.isSafeInteger(id) || id < 1) invalid('INVALID_ID')
  return id
}

function normalizeUpdatedAt(value) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/u.test(value)) invalid('TIMESTAMP_REQUIRED')
  return value
}

function groupFromInput(input) {
  const candidate = typeof input === 'string' ? input : input?.groupKey
  if (candidate !== undefined) {
    if (typeof candidate !== 'string' || !RULE_GROUP_BY_KEY.has(candidate)) invalid('INVALID_RULE_GROUP')
    return RULE_GROUP_BY_KEY.get(candidate)
  }
  const group = assertObject(input?.group || input, 'INVALID_RULE_GROUP')
  const key = `${group.scope}|${group.field_name}|${group.operator}`
  if (!RULE_GROUP_BY_KEY.has(key)) invalid('INVALID_RULE_GROUP')
  return RULE_GROUP_BY_KEY.get(key)
}

function groupKey(row) {
  return `${row.scope}|${row.field_name}|${row.operator}`
}

function normalizeText(value) {
  if (typeof value !== 'string') invalid('INVALID_RULE_VALUE')
  const result = value.trim()
  if (!result || /[\u0000-\u001f\u007f]/u.test(result)) invalid('INVALID_RULE_VALUE')
  return result
}

function normalizeNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid('INVALID_RULE_VALUE')
  return value
}

function numberIdentity(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) invalid('INVALID_RULE_VALUE')
  return String(number)
}

function normalizeRemark(value, fallback = null) {
  if (value === undefined) return fallback
  if (value === null || value === '') return null
  return validation.text(value, { max: 255 }) || null
}

function hasValue(input, key) {
  return Object.hasOwn(input, key) && input[key] !== undefined && input[key] !== null
}

function valueWasSupplied(input) {
  return hasValue(input, 'value') || hasValue(input, 'value_text') || hasValue(input, 'value_number')
}

function normalizeRuleValue(input, group, { existing, required = true } = {}) {
  const hasValueInput = hasValue(input, 'value')
  const hasTextInput = hasValue(input, 'value_text')
  const hasNumberInput = hasValue(input, 'value_number')
  if (hasValueInput && (hasTextInput || hasNumberInput)) invalid('INVALID_RULE_VALUE')

  let valueText = existing?.value_text ?? null
  let valueNumber = existing?.value_number ?? null
  if (hasValueInput) {
    valueText = null
    valueNumber = null
    if (group.type === 'text') valueText = normalizeText(input.value)
    else valueNumber = normalizeNumber(input.value)
  } else if (hasTextInput || hasNumberInput) {
    valueText = hasTextInput ? normalizeText(input.value_text) : null
    valueNumber = hasNumberInput ? normalizeNumber(input.value_number) : null
  }

  if (valueText !== null && valueNumber !== null) invalid('INVALID_RULE_VALUE')
  if (group.type === 'text') {
    if (valueNumber !== null) invalid('INVALID_RULE_VALUE')
    if (valueText === null && required) invalid('INVALID_RULE_VALUE')
    if (valueText !== null && typeof valueText !== 'string') invalid('INVALID_RULE_VALUE')
    return { value_text: valueText, value_number: null }
  }
  if (valueText !== null) invalid('INVALID_RULE_VALUE')
  if (valueNumber === null && required) invalid('INVALID_RULE_VALUE')
  if (valueNumber !== null) valueNumber = normalizeNumber(valueNumber)
  return { value_text: null, value_number: valueNumber }
}

function normalizeEnabled(value, fallback = true) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') invalid('INVALID_BOOLEAN')
  return value
}

function normalizeEnabledFilter(value) {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  invalid('INVALID_BOOLEAN')
}

function normalizeRuleFields(input, group, { existing, requiredValue = true } = {}) {
  const values = normalizeRuleValue(input, group, { existing, required: requiredValue })
  return {
    scope: group.scope,
    field_name: group.field_name,
    operator: group.operator,
    ...values,
    enabled: normalizeEnabled(input.enabled, existing?.enabled ?? true),
    remark: normalizeRemark(input.remark, existing?.remark ?? null)
  }
}

function normalizeStoredRow(row, expectedGroup) {
  assertObject(row, 'INVALID_RULE_ROW')
  const id = normalizeId(row.id)
  const group = groupFromInput({ scope: row.scope, field_name: row.field_name, operator: row.operator })
  if (expectedGroup && group.key !== expectedGroup.key) invalid('RULE_GROUP_MISMATCH')
  const stored = { ...row }
  if (typeof stored.value_number === 'string' && stored.value_number.trim()) {
    const numericValue = Number(stored.value_number)
    if (!Number.isFinite(numericValue)) invalid('INVALID_RULE_VALUE')
    stored.value_number = numericValue
  }
  const fields = normalizeRuleFields(stored, group, { existing: stored })
  if (typeof row.enabled !== 'boolean') invalid('INVALID_BOOLEAN')
  return { ...stored, id, ...fields }
}

function valueIdentity(row, group) {
  return group.type === 'text' ? `text:${row.value_text}` : `number:${numberIdentity(row.value_number)}`
}

function diffRowEquals(original, next, group) {
  return original.enabled === next.enabled &&
    normalizeRemark(original.remark, null) === next.remark &&
    valueIdentity(original, group) === valueIdentity(next, group)
}

export function buildRuleGroupDiff(originalRows, draft) {
  if (!Array.isArray(originalRows)) invalid('INVALID_RULE_ROWS')
  const group = groupFromInput(draft)
  const original = originalRows.map(row => normalizeStoredRow(row, group))
  const originalsById = new Map()
  const originalsByValue = new Map()
  for (const row of original) {
    if (originalsById.has(row.id)) invalid('DUPLICATE_ID')
    const identity = valueIdentity(row, group)
    if (originalsByValue.has(identity)) invalid('DUPLICATE_RULE')
    originalsById.set(row.id, row)
    originalsByValue.set(identity, row)
  }

  if (!Array.isArray(draft?.entries)) invalid('INVALID_RULE_ENTRIES')
  const entries = draft.entries
  const chosen = new Map()
  for (const rawEntry of entries) {
    const entry = assertObject(rawEntry, 'INVALID_RULE_ENTRY')
    const id = entry.id === undefined || entry.id === null || entry.id === '' ? undefined : normalizeId(entry.id)
    if (id !== undefined && !originalsById.has(id)) invalid('RULE_ID_NOT_IN_GROUP')
    if (id !== undefined && chosen.has(id)) invalid('DUPLICATE_ID')
    const base = id === undefined ? undefined : originalsById.get(id)
    const normalized = normalizeRuleFields(entry, group, { existing: base, requiredValue: id === undefined || valueWasSupplied(entry) })
    const candidate = { ...(base || {}), ...(id === undefined ? {} : { id }), ...normalized }
    const identity = valueIdentity(candidate, group)
    const previous = [...chosen.values()].find(item => item.identity === identity)
    if (previous) {
      if (candidate.id !== undefined && previous.entry.id === undefined) {
        chosen.delete(previous.key)
        chosen.set(candidate.id ?? `new:${chosen.size}`, { key: candidate.id ?? `new:${chosen.size}`, entry: candidate, identity })
      }
      continue
    }
    const key = id ?? `new:${chosen.size}`
    chosen.set(key, { key, entry: candidate, identity })
  }

  const update = []
  const insert = []
  const unchanged = []
  const selectedIds = new Set()
  for (const { entry } of chosen.values()) {
    if (entry.id === undefined) {
      const originalMatch = originalsByValue.get(valueIdentity(entry, group))
      if (originalMatch) invalid('RULE_ID_REQUIRED')
      insert.push({
        scope: group.scope,
        field_name: group.field_name,
        operator: group.operator,
        value_text: entry.value_text,
        value_number: entry.value_number,
        enabled: entry.enabled,
        remark: entry.remark
      })
      continue
    }
    selectedIds.add(entry.id)
    const previous = originalsById.get(entry.id)
    if (diffRowEquals(previous, entry, group)) {
      unchanged.push(previous)
    } else {
      update.push({
        id: entry.id,
        scope: group.scope,
        field_name: group.field_name,
        operator: group.operator,
        value_text: entry.value_text,
        value_number: entry.value_number,
        enabled: entry.enabled,
        remark: entry.remark,
        updated_at: previous.updated_at
      })
    }
  }

  const remove = original.filter(row => !selectedIds.has(row.id))
  return { insert, update, delete: remove, unchanged }
}

function toEditablePayload(row) {
  return Object.fromEntries(['value_text', 'value_number', 'enabled', 'remark']
    .filter(field => row[field] !== undefined)
    .map(field => [field, row[field]]))
}

function conflict(operation, id) {
  return serviceError(409, 'RULE_CONFLICT', `Rule ${operation} conflict${id === undefined ? '' : `: ${id}`}`)
}

function failedItem(operation, id, error) {
  return {
    operation,
    ...(id === undefined ? {} : { id }),
    code: error?.code || 'RULE_WRITE_FAILED',
    ...(error?.status === undefined ? {} : { status: error.status }),
    message: error?.message || 'Rule write failed'
  }
}

export function createRulesService({ client, now = () => new Date().toISOString() } = {}) {
  if (!client) throw new TypeError('Supabase client is required')

  async function readAllRules() {
    const result = await client.list('filter_rules', {
      columns: RULE_COLUMNS,
      order: [{ column: 'id', direction: 'asc' }],
      limit: GROUP_READ_LIMIT,
      offset: 0,
      count: 'exact'
    })
    const rows = resultRows(result)
    if (result?.total !== null && result?.total !== undefined && result.total > GROUP_READ_LIMIT) {
      throw serviceError(413, 'RULE_CAPACITY_EXCEEDED', `More than ${GROUP_READ_LIMIT} rules are configured`)
    }
    if ((result?.total === null || result?.total === undefined) && rows.length >= GROUP_READ_LIMIT) {
      throw serviceError(413, 'RULE_CAPACITY_EXCEEDED', `Rule count cannot be verified within ${GROUP_READ_LIMIT} rows`)
    }
    return rows.map(row => normalizeStoredRow(row))
  }

  async function listRules(input = {}) {
    assertObject(input)
    const { page, pageSize, offset } = validation.parsePageQuery(input)
    const filters = []
    if (input.scope !== undefined && input.scope !== '') {
      if (!['account', 'article', 'hotword'].includes(input.scope)) invalid('INVALID_ENUM')
      filters.push({ column: 'scope', operator: 'eq', value: input.scope })
    }
    if (input.field_name !== undefined && input.field_name !== '') {
      const matchingFields = RULE_GROUPS.filter(group => group.field_name === input.field_name && (input.scope === undefined || input.scope === '' || group.scope === input.scope))
      if (!matchingFields.length) invalid('INVALID_ENUM')
      filters.push({ column: 'field_name', operator: 'eq', value: input.field_name })
    }
    if (input.operator !== undefined && input.operator !== '') {
      if (!['exact', 'contains', 'not_contains', 'eq', 'gt', 'gte', 'lt', 'lte'].includes(input.operator)) invalid('INVALID_ENUM')
      if (input.scope !== undefined && input.scope !== '' && !RULE_GROUPS.some(group => group.scope === input.scope && group.operator === input.operator)) invalid('INVALID_ENUM')
      if (input.field_name !== undefined && input.field_name !== '' && !RULE_GROUPS.some(group => group.field_name === input.field_name && group.operator === input.operator && (input.scope === undefined || input.scope === '' || group.scope === input.scope))) invalid('INVALID_ENUM')
      filters.push({ column: 'operator', operator: 'eq', value: input.operator })
    }
    if (input.enabled !== undefined && input.enabled !== '') filters.push({ column: 'enabled', operator: 'eq', value: normalizeEnabledFilter(input.enabled) })
    const keyword = input.keyword === undefined || input.keyword === '' ? undefined : validation.text(input.keyword, { max: 255 })
    const result = await client.list('filter_rules', {
      columns: RULE_COLUMNS,
      filters,
      search: keyword === undefined ? undefined : { columns: ['value_text', 'remark'], value: keyword },
      order: [{ column: 'id', direction: 'asc' }],
      limit: pageSize,
      offset,
      count: 'exact'
    })
    return { items: resultRows(result).map(row => normalizeStoredRow(row)), total: result?.total ?? null, page, pageSize }
  }

  async function getRule(idInput) {
    const id = normalizeId(idInput)
    const result = await client.get('filter_rules', id, { columns: RULE_COLUMNS })
    return { item: normalizeStoredRow(result?.data) }
  }

  async function listRuleGroups() {
    const rows = await readAllRules()
    const grouped = new Map()
    for (const row of rows) {
      const key = groupKey(row)
      const group = RULE_GROUP_BY_KEY.get(key)
      if (!group) throw serviceError(502, 'INVALID_RULE_DATA', `Unsupported rule group: ${key}`)
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key).push(row)
    }
    const groups = RULE_GROUPS.map(group => {
      const groupRows = grouped.get(group.key) ?? []
      const enabledCount = groupRows.filter(row => row.enabled).length
      const enabled = groupRows.length === 0 ? null : enabledCount === groupRows.length ? true : enabledCount === 0 ? false : null
      return {
        ...group,
        rows: groupRows,
        enabled,
        enabled_state: groupRows.length === 0 ? 'empty' : enabled === null ? 'mixed' : enabled ? 'enabled' : 'disabled',
        hit_count: groupRows.reduce((sum, row) => sum + Number(row.hit_count || 0), 0)
      }
    })
    return { groups, total: rows.length }
  }

  async function saveRuleGroup(input) {
    assertObject(input)
    const group = groupFromInput(input)
    const originalRows = input.original_rows ?? input.originalRows
    const diff = buildRuleGroupDiff(originalRows, { group, entries: input.draft?.entries ?? input.draft?.rows ?? input.draft })
    const succeeded = []
    const failed = []

    for (const item of diff.update) {
      try {
        const result = await client.patch('filter_rules', [
          { column: 'id', operator: 'eq', value: item.id },
          { column: 'scope', operator: 'eq', value: group.scope },
          { column: 'field_name', operator: 'eq', value: group.field_name },
          { column: 'operator', operator: 'eq', value: group.operator },
          { column: 'updated_at', operator: 'eq', value: item.updated_at }
        ], toEditablePayload(item))
        if (!resultRows(result).length) throw conflict('update', item.id)
        succeeded.push({ operation: 'update', id: item.id, item: resultRows(result)[0] })
      } catch (error) {
        failed.push(failedItem('update', item.id, error))
      }
    }

    for (const item of diff.insert) {
      try {
        const result = await client.insert('filter_rules', [item])
        const rows = resultRows(result)
        if (!rows.length) throw serviceError(409, 'RULE_WRITE_UNKNOWN', 'Inserted rule was not returned')
        succeeded.push({ operation: 'insert', id: rows[0].id, item: rows[0] })
      } catch (error) {
        failed.push(failedItem('insert', undefined, error))
      }
    }

    for (const item of diff.delete) {
      try {
        const result = await client.remove('filter_rules', [
          { column: 'id', operator: 'eq', value: item.id },
          { column: 'scope', operator: 'eq', value: group.scope },
          { column: 'field_name', operator: 'eq', value: group.field_name },
          { column: 'operator', operator: 'eq', value: group.operator },
          { column: 'updated_at', operator: 'eq', value: item.updated_at }
        ])
        if (!resultRows(result).length) throw conflict('delete', item.id)
        succeeded.push({ operation: 'delete', id: item.id })
      } catch (error) {
        failed.push(failedItem('delete', item.id, error))
      }
    }

    let latest
    if (typeof client.list === 'function') {
      try {
        latest = (await listRuleGroups()).groups.find(item => item.key === group.key)
      } catch {}
    }
    return {
      status: failed.length === 0 ? 'success' : succeeded.length ? 'partial' : 'failed',
      count: succeeded.length,
      requestedCount: diff.update.length + diff.insert.length + diff.delete.length,
      succeeded,
      failed,
      conflicts: failed.filter(item => item.status === 409 || item.code === 'RULE_CONFLICT'),
      unchanged: diff.unchanged,
      diff,
      ...(latest ? { group: latest } : {})
    }
  }

  async function createRule(input = {}) {
    assertObject(input)
    assertAllowedKeys(input, CREATE_KEYS)
    const group = groupFromInput(input)
    const payload = normalizeRuleFields(input, group)
    const result = await client.insert('filter_rules', [payload])
    const rows = resultRows(result)
    if (!rows.length) throw serviceError(409, 'RULE_WRITE_UNKNOWN', 'Created rule was not returned')
    return { item: rows[0] }
  }

  async function updateRule(idInput, input = {}) {
    const id = normalizeId(idInput)
    assertObject(input)
    assertAllowedKeys(input, UPDATE_KEYS)
    const expectedUpdatedAt = normalizeUpdatedAt(input.expected_updated_at)
    const currentResult = await client.get('filter_rules', id, { columns: RULE_COLUMNS })
    const current = normalizeStoredRow(currentResult?.data)
    const group = groupFromInput({
      scope: input.scope ?? current.scope,
      field_name: input.field_name ?? current.field_name,
      operator: input.operator ?? current.operator
    })
    const merged = normalizeRuleFields(input, group, { existing: current, requiredValue: true })
    const payload = {}
    for (const field of ['scope', 'field_name', 'operator', 'enabled', 'remark']) {
      if (Object.hasOwn(input, field)) payload[field] = merged[field]
    }
    if (valueWasSupplied(input) || group.key !== groupKey(current)) {
      payload.value_text = merged.value_text
      payload.value_number = merged.value_number
    }
    const result = await client.patch('filter_rules', [
      { column: 'id', operator: 'eq', value: id },
      { column: 'updated_at', operator: 'eq', value: expectedUpdatedAt }
    ], payload)
    const rows = resultRows(result)
    if (!rows.length) throw conflict('update', id)
    return { item: rows[0] }
  }

  async function deleteRule(idInput, input = {}) {
    const id = normalizeId(idInput)
    assertObject(input)
    for (const key of Object.keys(input)) if (key !== 'expected_updated_at') invalid('INVALID_COLUMN')
    const expectedUpdatedAt = normalizeUpdatedAt(input.expected_updated_at)
    const result = await client.remove('filter_rules', [
      { column: 'id', operator: 'eq', value: id },
      { column: 'updated_at', operator: 'eq', value: expectedUpdatedAt }
    ])
    if (!resultRows(result).length) throw conflict('delete', id)
    return { id, count: 1, deleted: true }
  }

  return Object.freeze({ listRules, getRule, listRuleGroups, buildRuleGroupDiff, saveRuleGroup, createRule, updateRule, deleteRule })
}

export const createFilterRulesService = createRulesService
export const createConfigCenterRulesService = createRulesService

export async function listRules(client, input = {}) {
  return createRulesService({ client }).listRules(input)
}

export async function listRuleGroups(client) {
  return createRulesService({ client }).listRuleGroups()
}

export async function saveRuleGroup(client, input) {
  return createRulesService({ client }).saveRuleGroup(input)
}

export async function createRule(client, input) {
  return createRulesService({ client }).createRule(input)
}

export async function updateRule(client, id, input) {
  return createRulesService({ client }).updateRule(id, input)
}

export async function deleteRule(client, id, input) {
  return createRulesService({ client }).deleteRule(id, input)
}
