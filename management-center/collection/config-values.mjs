function schemaType(schema) {
  return typeof schema === 'string' ? schema : schema?.type
}

function arrayFieldError(name, schema, detail = '') {
  const error = new Error(`${schema?.label || name}${detail ? `：${detail}` : '必须填写有效的 JSON 数组'}`)
  error.code = 'INVALID_CONFIG_ARRAY'
  return error
}

export function formatArrayConfigForForm(config = {}, fields = {}) {
  const result = { ...(config && typeof config === 'object' && !Array.isArray(config) ? config : {}) }
  for (const [name, schema] of Object.entries(fields || {})) {
    if (schemaType(schema) !== 'array') continue
    const defaultValue = typeof schema === 'object' && Object.hasOwn(schema, 'default') ? schema.default : []
    const value = Object.hasOwn(result, name) ? result[name] : defaultValue
    result[name] = JSON.stringify(value ?? [], null, 2)
  }
  return result
}

export function parseArrayConfigFromForm(config = {}, fields = {}) {
  const result = { ...(config && typeof config === 'object' && !Array.isArray(config) ? config : {}) }
  for (const [name, schemaValue] of Object.entries(fields || {})) {
    if (schemaType(schemaValue) !== 'array') continue
    const schema = typeof schemaValue === 'object' ? schemaValue : {}
    const raw = result[name]
    let value
    if (Array.isArray(raw)) value = raw
    else if (raw === undefined || raw === null || raw === '') value = []
    else if (typeof raw !== 'string') throw arrayFieldError(name, schema)
    else {
      try { value = JSON.parse(raw) } catch { throw arrayFieldError(name, schema) }
    }
    if (!Array.isArray(value)) throw arrayFieldError(name, schema)
    const minimum = Number.isSafeInteger(schema.minItems) ? schema.minItems : (schema.required === true ? 1 : 0)
    const maximum = Number.isSafeInteger(schema.maxItems) ? schema.maxItems : null
    if (value.length < minimum) throw arrayFieldError(name, schema, `至少填写 ${minimum} 项`)
    if (maximum !== null && value.length > maximum) throw arrayFieldError(name, schema, `最多填写 ${maximum} 项`)
    result[name] = value
  }
  return result
}
