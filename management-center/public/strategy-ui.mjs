const NUMBER_FORMATTER = new Intl.NumberFormat('zh-CN')

function stringValue(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function readNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function chunkValues(values, size) {
  if (!Array.isArray(values) || !Number.isSafeInteger(size) || size < 1) return []
  const chunks = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}

export function serializeStrategyTargets(requestType, targets = []) {
  const cloned = Array.isArray(targets) ? structuredClone(targets) : []
  if (requestType !== 'account') return cloned
  return cloned.map(target => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) return target
    const result = { ...target }
    delete result.avatar
    return result
  })
}

export function targetIdentity(requestType, target) {
  if (requestType === 'account') return `account:${target?.account_id ?? ''}`
  return `text:${stringValue(target)}`
}

export function filterActiveTargets(requestType, sourceTargets = [], activeTargets = []) {
  const source = new Set(sourceTargets.map(target => targetIdentity(requestType, target)))
  return activeTargets.filter(target => source.has(targetIdentity(requestType, target)))
}

export function calculateExpectedRequests({ requestType: _requestType, activeTargets = [], cursor = 0 } = {}) {
  const pages = readNumber(cursor)
  if (!pages || pages <= 0) return 0
  return Math.max(0, activeTargets.length) * pages
}

export function normalizeMonthInput(value) {
  const normalized = stringValue(value)
  if (/^\d{6}$/u.test(normalized)) return `${normalized.slice(0, 4)}-${normalized.slice(4)}`
  return normalized
}

export function serializeMonthInput(value) {
  const normalized = stringValue(value)
  if (!normalized) return null
  if (/^\d{6}$/u.test(normalized)) return normalized
  if (/^\d{4}-\d{2}$/u.test(normalized)) return normalized.replace('-', '')
  return normalized
}

export function formatMetric(value) {
  const number = readNumber(value)
  return number === null ? '—' : NUMBER_FORMATTER.format(number)
}

export function formatReadingRange(minRead, maxRead) {
  const min = readNumber(minRead)
  const max = readNumber(maxRead)
  if (min !== null && max !== null) return `${formatMetric(min)}–${formatMetric(max)}`
  if (min !== null) return `≥ ${formatMetric(min)}`
  if (max !== null) return `≤ ${formatMetric(max)}`
  return '不限'
}

function completedStatus(value) {
  const normalized = stringValue(value).toLowerCase()
  if (['pending', 'processing', 'running'].includes(normalized)) return '处理中'
  if (['failed', 'error'].includes(normalized)) return '未完成'
  if (['done', 'completed', 'success'].includes(normalized)) return '已完成'
  return stringValue(value) || '已完成'
}

export function completedItemViewModel(item, index = 0) {
  const value = item && typeof item === 'object' && !Array.isArray(item) ? item : {}
  const name = [value.wx_name, value.name, value.hotword, value.keyword, value.label, value.title].find(candidate => stringValue(candidate)) || '已完成对象'
  const articleCount = readNumber(value.article_count ?? value.articleCount ?? value.articles_count ?? value.fetched_articles ?? value.count)
  return {
    name: stringValue(name),
    status: completedStatus(value.status ?? value.state ?? (value.completed === false ? '处理中' : '已完成')),
    articleCount,
    order: index + 1
  }
}

export function buildNextRequestPreviewModel({
  requestType,
  requestTypeLabel,
  activeTargets = [],
  presentTarget = target => ({ name: stringValue(target) }),
  date = null,
  month = null,
  minRead = null,
  maxRead = null,
  cursor = 0,
  cycleNo = 1
} = {}) {
  const visibleTargets = activeTargets.slice(0, 3).map(target => ({ raw: target, ...presentTarget(target) }))
  const expectedRequests = calculateExpectedRequests({ requestType, activeTargets, cursor })
  return {
    method: requestTypeLabel || '采集策略',
    date: stringValue(date),
    month: normalizeMonthInput(month),
    targetCount: activeTargets.length,
    visibleTargets,
    hiddenTargetCount: Math.max(0, activeTargets.length - visibleTargets.length),
    readingRange: formatReadingRange(minRead, maxRead),
    pages: readNumber(cursor) && readNumber(cursor) > 0 ? `${readNumber(cursor)} 页` : '暂不请求',
    expectedRequests,
    expectedRequestsLabel: expectedRequests > 0 ? `${formatMetric(expectedRequests)} 次` : '暂不请求',
    cycleNo: readNumber(cycleNo) || 1
  }
}

export function strategyStatus({ cursor = 0, activeTargets, active_targets, capability = null } = {}) {
  const targets = activeTargets ?? active_targets ?? []
  if (!readNumber(cursor) || !targets.length) return { label: '未启用', className: 'pill-amber' }
  if (capability?.available === true) return { label: '运行中', className: 'pill-green' }
  return { label: '已配置', className: 'pill-blue' }
}

export function formatStrategyUpdatedAt(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return stringValue(value)
  const parts = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date)
  const get = type => parts.find(part => part.type === type)?.value || ''
  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}
