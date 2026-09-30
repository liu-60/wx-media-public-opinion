const MANUAL_PLATFORMS = Object.freeze(['wxrank', 'redfox'])

function invalid(code, message) {
  const error = new Error(message)
  error.code = code
  error.status = 400
  return error
}

export function normalizeManualHotwords(value, { maxCount = 20, maxLength = 50 } = {}) {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，;；\r\n]+/u)
      : []
  if (values.some(item => typeof item !== 'string')) throw invalid('INVALID_MANUAL_HOTWORDS', '手动热词必须是文本')
  const words = values.map(item => item.trim()).filter(Boolean)
  if (!words.length) throw invalid('MANUAL_HOTWORDS_REQUIRED', '手动检索至少录入一个热词')
  if (words.some(word => word.length > maxLength || /[\u0000-\u001f\u007f]/u.test(word))) {
    throw invalid('INVALID_MANUAL_HOTWORDS', `每个手动热词不能超过${maxLength}个字符且不能包含控制字符`)
  }
  const unique = [...new Map(words.map(word => [word.toLocaleLowerCase('zh-CN'), word])).values()]
  if (unique.length > maxCount) throw invalid('TOO_MANY_MANUAL_HOTWORDS', `单独验证最多检索${maxCount}个热词`)
  return unique
}

export function normalizeManualSearchConfig(config = {}) {
  if (config.search_mode !== 'manual_keywords') return { ...config }
  const manualHotwords = normalizeManualHotwords(config.manual_hotwords ?? config.hotwords)
  const providedPlatforms = config.manual_platforms === undefined ? MANUAL_PLATFORMS : config.manual_platforms
  const platforms = typeof providedPlatforms === 'string' ? [providedPlatforms] : providedPlatforms
  if (!Array.isArray(platforms) || !platforms.length || platforms.some(platform => !MANUAL_PLATFORMS.includes(platform))) {
    throw invalid('INVALID_MANUAL_PLATFORMS', '手动检索平台只能选择 WxRank 或 RedFox')
  }
  const selectedPlatforms = [...new Set(platforms)]
  const rawMaxRequests = config.max_total_requests ?? 6
  const maxRequests = Number(rawMaxRequests)
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 0 || maxRequests > 10) {
    throw invalid('INVALID_MAX_TOTAL_REQUESTS', '本轮请求上限必须是0到10之间的整数')
  }
  return { ...config, manual_hotwords: manualHotwords, manual_platforms: selectedPlatforms, max_total_requests: maxRequests }
}

export { MANUAL_PLATFORMS }
