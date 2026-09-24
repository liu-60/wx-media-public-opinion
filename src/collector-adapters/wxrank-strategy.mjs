const SUPPORTED_REQUEST_TYPES = new Set(['account', 'wx_type'])

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim()
}

export function getWxRankStrategyCapability(requestType) {
  const available = SUPPORTED_REQUEST_TYPES.has(requestType)
  return {
    requestType,
    available,
    code: available ? 'OK' : 'CAPABILITY_UNAVAILABLE',
    reason: available ? null : 'CAPABILITY_UNAVAILABLE: WxRank strategy supports account and wx_type only'
  }
}

export function createWxRankStrategyRequest({ requestType, strategy = {}, target, cursor } = {}) {
  const type = requestType || strategy.request_type
  if (!SUPPORTED_REQUEST_TYPES.has(type)) {
    const error = new Error(`CAPABILITY_UNAVAILABLE: unsupported WxRank strategy ${type || '(empty)'}`)
    error.code = 'CAPABILITY_UNAVAILABLE'
    error.status = 501
    throw error
  }

  const request = {}
  for (const [source, destination] of [
    ['date', 'date'],
    ['month', 'month'],
    ['min_read', 'minReadNum'],
    ['max_read', 'maxReadNum']
  ]) {
    const value = strategy[source]
    if (value !== undefined && value !== null && value !== '') request[destination] = value
  }

  if (type === 'account') {
    const wxBiz = text(target?.wx_biz ?? target?.wxBiz)
    if (!wxBiz) {
      const error = new Error('STRATEGY_TARGET_INVALID: account target has no wx_biz')
      error.code = 'STRATEGY_TARGET_INVALID'
      throw error
    }
    request.wxBiz = wxBiz
  } else {
    const wxType = text(typeof target === 'string' ? target : target?.wx_type)
    if (!wxType) {
      const error = new Error('STRATEGY_TARGET_INVALID: wx_type target is empty')
      error.code = 'STRATEGY_TARGET_INVALID'
      throw error
    }
    request.wxType = wxType
  }

  if (cursor !== undefined && cursor !== null && cursor !== '') request.cursor = cursor
  return request
}

export { SUPPORTED_REQUEST_TYPES }
