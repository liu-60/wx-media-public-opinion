const UNAVAILABLE = 'CAPABILITY_UNAVAILABLE: WxRank strategy request contract is not verified by the current adapter'

export function getWxRankStrategyCapability(requestType) {
  return { requestType, available: false, code: 'CAPABILITY_UNAVAILABLE', reason: UNAVAILABLE }
}

export function createWxRankStrategyRequest() {
  const error = new Error(UNAVAILABLE)
  error.code = 'CAPABILITY_UNAVAILABLE'
  error.status = 501
  throw error
}
