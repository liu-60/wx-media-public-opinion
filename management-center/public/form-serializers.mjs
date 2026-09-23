export function serializeDateValue(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value?.format === 'function') return value.format('YYYY-MM-DD')
  if (typeof value === 'string') return value.slice(0, 10)
  return undefined
}

export function normalizeMultipleValue(value) {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null || value === '') return []
  return [value]
}

const TEXT_RULE_OPERATORS = ['contains', 'not_contains', 'eq']
const NUMBER_RULE_OPERATORS = ['eq', 'gt', 'gte', 'lt', 'lte']

export function normalizeRuleEditorValues(values, groups) {
  const availableGroups = (groups || []).filter(group => !values?.scope || group.scope === values.scope)
  const selectedGroup = availableGroups.find(group => group.field_name === values?.field_name) || availableGroups[0]
  const fieldName = selectedGroup?.field_name || values?.field_name
  const fieldGroups = availableGroups.filter(group => group.field_name === fieldName)
  const declaredOperators = [...new Set(fieldGroups.map(group => group.operator).filter(Boolean))]
  const operators = declaredOperators.length ? declaredOperators : selectedGroup?.type === 'number' ? NUMBER_RULE_OPERATORS : TEXT_RULE_OPERATORS
  const operator = operators.includes(values?.operator) ? values.operator : operators[0]
  const selectionChanged = fieldName !== values?.field_name || operator !== values?.operator
  return { ...values, field_name: fieldName, operator, value: selectionChanged ? undefined : values?.value }
}
