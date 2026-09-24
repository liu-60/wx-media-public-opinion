export const WXRANK_REQUEST_TYPES = Object.freeze(['account', 'wx_type'])

const ALLOWED_TYPES = new Set(WXRANK_REQUEST_TYPES)

function configError(code, message) {
  const error = new Error(message)
  error.code = code
  error.status = 400
  return error
}

export function normalizeWxRankRequestTypes(value) {
  const raw = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value]
  const values = []
  for (const item of raw) {
    const normalized = String(item ?? '').trim()
    if (!normalized || values.includes(normalized)) continue
    values.push(normalized)
  }
  return values
}

export function validateWxRankRequestTypes(config = {}, { mode = 'workflow' } = {}) {
  const source = config && typeof config === 'object' && !Array.isArray(config)
    ? Object.hasOwn(config, 'request_types') ? config.request_types : config.request_type
    : config
  const values = normalizeWxRankRequestTypes(source)
  if (!values.length) throw configError('INVALID_REQUEST_TYPES', 'request_types must contain at least one strategy')
  if (values.some(value => !ALLOWED_TYPES.has(value))) throw configError('INVALID_REQUEST_TYPE', 'request_types must contain only account or wx_type')
  if (mode === 'single_validation' && values.length !== 1) throw configError('INVALID_REQUEST_TYPES', 'single-script validation accepts exactly one strategy')
  if (mode !== 'workflow' && mode !== 'single_validation') throw configError('INVALID_EXECUTION_MODE', 'execution mode is invalid')
  return values
}

export function requestTypeLabel(value) {
  return value === 'account' ? '账号策略' : value === 'wx_type' ? '类型策略' : String(value || '')
}
