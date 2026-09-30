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

function datePageComplete(completedItems, target, page) {
  const key = `date:${stringValue(target)}`
  return (Array.isArray(completedItems) ? completedItems : []).some(item => item?.request_type === 'date' && item?.target_key === key && Number(item?.page_no) === page && ['reserved', 'success', 'failed'].includes(item?.status))
}

function datePageEntry(completedItems, target, page) {
  const key = `date:${stringValue(target)}`
  return (Array.isArray(completedItems) ? completedItems : []).find(item => item?.request_type === 'date' && item?.target_key === key && Number(item?.page_no) === page) || null
}

function remainingDatePages(completedItems, target, pages) {
  if (!pages) return 0
  const first = (Array.isArray(completedItems) ? completedItems : []).find(item => item?.request_type === 'date' && item?.target_key === `date:${stringValue(target)}` && Number(item?.page_no) === 1 && ['reserved', 'success', 'failed'].includes(item?.status))
  if (!first) return pages
  if (first.status !== 'success' || first.next_cursor === null || first.next_cursor === undefined || first.next_cursor === '') return 0
  if (pages > 1 && !datePageComplete(completedItems, target, 2)) return 1
  return 0
}

export function calculateExpectedRequests({ requestType, activeTargets = [], cursor = 0, completedItems = [], month = null } = {}) {
  const pages = readNumber(cursor)
  if (!pages || pages <= 0) return 0
  if (requestType === 'date') return activeTargets.reduce((total, target) => total + remainingDatePages(completedItems, target, pages), 0)
  if (requestType === 'month') return normalizeMonthInput(month) ? pages : 0
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
  cycleNo = 1,
  completedItems = []
} = {}) {
  const visibleTargets = activeTargets.slice(0, 3).map(target => ({ raw: target, ...presentTarget(target) }))
  const expectedRequests = calculateExpectedRequests({ requestType, activeTargets, cursor, completedItems, month })
  const completedRequests = requestType === 'date'
    ? activeTargets.reduce((total, target) => total + Array.from({ length: readNumber(cursor) || 0 }, (_, index) => index + 1).filter(page => ['success', 'failed'].includes(datePageEntry(completedItems, target, page)?.status)).length, 0)
    : null
  let nextDateRequest = null
  if (requestType === 'date') {
    nextDateRequest = activeTargets.flatMap(target => Array.from({ length: readNumber(cursor) || 0 }, (_, index) => index + 1).filter(page => !datePageComplete(completedItems, target, page)).map(page => `${stringValue(target)} · 第 ${page} 页`))[0]
    if (!nextDateRequest) {
      const pending = activeTargets.flatMap(target => Array.from({ length: readNumber(cursor) || 0 }, (_, index) => index + 1).filter(page => datePageEntry(completedItems, target, page)?.status === 'reserved').map(page => `${stringValue(target)} · 第 ${page} 页结果待确认`))[0]
      nextDateRequest = pending || '当前两日已完成'
    }
  }
  const nextMonthRequest = requestType === 'month' && normalizeMonthInput(month) && readNumber(cursor) > 0
    ? `${normalizeMonthInput(month)} · 第 1 页`
    : null
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
    completedRequests,
    completedRequestsLabel: completedRequests === null ? '—' : `${formatMetric(completedRequests)} 次`,
    nextRequest: nextDateRequest || nextMonthRequest,
    cycleNo: readNumber(cycleNo) || 1
  }
}

export function strategyStatus({ request_type = '', month = null, date = null, cursor = 0, activeTargets, active_targets, capability = null } = {}) {
  const targets = activeTargets ?? active_targets ?? []
  const timeTargetConfigured = request_type === 'month' ? Boolean(normalizeMonthInput(month)) : request_type === 'date' ? Boolean(stringValue(date)) : false
  if (!readNumber(cursor) || (!targets.length && !timeTargetConfigured)) return { label: '未启用', className: 'pill-amber' }
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
