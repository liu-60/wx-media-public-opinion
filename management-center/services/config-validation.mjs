export class ConfigValidationError extends Error {
  constructor(code, message = 'Invalid request') {
    super(message)
    this.name = 'ConfigValidationError'
    this.code = code
    this.status = 400
  }
}

function invalid(code) {
  throw new ConfigValidationError(code)
}

function text(value, { required = false, min = 0, max = 500 } = {}) {
  if (value === undefined || value === null) {
    if (required) invalid('TEXT_REQUIRED')
    return ''
  }
  if (typeof value !== 'string') invalid('INVALID_TEXT')
  const result = value.trim()
  if ((required && !result) || result.length < min || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) invalid('INVALID_TEXT')
  return result
}

function integer(value, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) invalid('INTEGER_REQUIRED')
    return undefined
  }
  const result = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isSafeInteger(result) || result < min || result > max) invalid('INVALID_INTEGER')
  return result
}

function number(value, { min = -Number.MAX_VALUE, max = Number.MAX_VALUE, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) invalid('NUMBER_REQUIRED')
    return undefined
  }
  const result = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(result) || result < min || result > max) invalid('INVALID_NUMBER')
  return result
}

function date(value, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) invalid('DATE_REQUIRED')
    return undefined
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) invalid('INVALID_DATE')
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid('INVALID_DATE')
  return value
}

function month(value, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) invalid('MONTH_REQUIRED')
    return undefined
  }
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(value)) invalid('INVALID_MONTH')
  return value
}

function enumValue(value, values, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) invalid('ENUM_REQUIRED')
    return undefined
  }
  if (!values.includes(value)) invalid('INVALID_ENUM')
  return value
}

function boolean(value, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) invalid('BOOLEAN_REQUIRED')
    return undefined
  }
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  invalid('INVALID_BOOLEAN')
}

function textArray(value, { maxItems = 100, maxItemLength = 100 } = {}) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > maxItems) invalid('INVALID_TEXT_ARRAY')
  return value.map(item => text(item, { required: true, max: maxItemLength }))
}

function id(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) invalid('INVALID_ID')
  const result = value.trim()
  if (!/^[\p{L}\p{N}_:-]+$/u.test(result)) invalid('INVALID_ID')
  return result
}

function parsePageQuery(query = {}) {
  const page = integer(query.page ?? 1, { min: 1, max: 1_000_000, required: true })
  const pageSize = integer(query.pageSize ?? 50, { min: 1, max: 500, required: true })
  return { page, pageSize, offset: (page - 1) * pageSize }
}

export function createConfigValidation() {
  return Object.freeze({ text, integer, number, date, month, enum: enumValue, boolean, textArray, id, parsePageQuery })
}

export { text as safeText, integer as safeInteger, number as safeNumber, date as safeDate, month as safeMonth, enumValue as safeEnum, boolean as safeBoolean, textArray as safeTextArray, parsePageQuery }
