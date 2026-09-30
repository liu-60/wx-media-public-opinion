const SUPPORTED_REQUEST_TYPES = new Set(['account', 'wx_type', 'month', 'date'])

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim()
}

export function getWxRankStrategyCapability(requestType) {
  const available = SUPPORTED_REQUEST_TYPES.has(requestType)
  return {
    requestType,
    available,
    code: available ? 'OK' : 'CAPABILITY_UNAVAILABLE',
    reason: available ? null : 'CAPABILITY_UNAVAILABLE: WxRank strategy supports account, wx_type, month, and date'
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

  if (type === 'date') {
    const date = text(typeof target === 'string' ? target : target?.date) || text(strategy.date)
    if (!/^20\d{2}-\d{2}-\d{2}$/u.test(date)) {
      const error = new Error('STRATEGY_TARGET_INVALID: date target must be YYYY-MM-DD')
      error.code = 'STRATEGY_TARGET_INVALID'
      throw error
    }
    request.date = date
  }

  if (type === 'month') {
    const rawMonth = text(typeof target === 'string' ? target : target?.month) || text(strategy.month)
    const month = rawMonth.replace('-', '')
    if (!/^20\d{4}$/u.test(month)) {
      const error = new Error('STRATEGY_TARGET_INVALID: month target must be YYYYMM')
      error.code = 'STRATEGY_TARGET_INVALID'
      throw error
    }
    request.month = month
  }

  if (type === 'account') {
    const wxBiz = text(target?.wx_biz ?? target?.wxBiz)
    if (!wxBiz) {
      const error = new Error('STRATEGY_TARGET_INVALID: account target has no wx_biz')
      error.code = 'STRATEGY_TARGET_INVALID'
      throw error
    }
    request.wxBiz = wxBiz
  } else if (type === 'wx_type') {
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
