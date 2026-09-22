import {
  buildNextRequestPreviewModel,
  chunkValues,
  formatReadingRange,
  formatStrategyUpdatedAt,
  serializeMonthInput,
  serializeStrategyTargets,
  strategyStatus
} from './strategy-ui.mjs'

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function strategyTargetKey(requestType, target) {
  return requestType === 'account'
    ? String(target?.account_id ?? target?.id ?? '')
    : String(target ?? '')
}

export function strategyAccountIdBatches(ids = [], size = 100) {
  const normalized = [...new Set((Array.isArray(ids) ? ids : []).map(value => Number(value)).filter(value => Number.isSafeInteger(value) && value > 0))]
  return chunkValues(normalized, size)
}

export function strategyStatusTag(item = {}) {
  const status = strategyStatus(item)
  if (status.label === '未启用') return { label: '未启用', color: 'warning' }
  if (item.capability?.available === true) return { label: '运行中', color: 'success' }
  return { label: '已启用', color: 'success' }
}

export function buildStrategyCardModel(item = {}, config = {}, accountOptions = new Map()) {
  const presentTarget = target => {
    if (config.targetSelector !== 'account') return { name: typeof target === 'string' ? target : '未命名对象' }
    const option = accountOptions.get(String(target?.account_id))
    return option || {
      name: target?.wx_name || '未命名公众号',
      avatar: target?.avatar || null,
      key: target?.wx_biz || null
    }
  }
  const preview = buildNextRequestPreviewModel({
    requestType: item.request_type,
    requestTypeLabel: config.label,
    activeTargets: item.active_targets || [],
    presentTarget,
    date: item.date,
    month: item.month,
    minRead: item.min_read,
    maxRead: item.max_read,
    cursor: item.cursor,
    cycleNo: item.cycle_no
  })
  return {
    status: strategyStatusTag(item),
    readingRange: formatReadingRange(item.min_read, item.max_read),
    visibleTargets: preview.visibleTargets,
    hiddenTargetCount: preview.hiddenTargetCount,
    targetCount: preview.targetCount,
    expectedRequestsLabel: preview.expectedRequestsLabel,
    pagesLabel: preview.pages,
    cycleLabel: `第 ${preview.cycleNo} 轮`,
    scheduleLabel: preview.date ? `采集日期 ${preview.date}` : preview.month ? `采集月份 ${preview.month}` : '暂未设置下次请求对象',
    updatedAtLabel: formatStrategyUpdatedAt(item.updated_at),
    typeLabel: config.label || '采集策略',
    targetUnit: config.targetUnit || '对象'
  }
}

export function strategyFormPayload(draft = {}, isCreate = false) {
  const payload = {
    request_type: draft.requestType,
    source_targets: serializeStrategyTargets(draft.requestType, draft.sourceTargets),
    active_targets: serializeStrategyTargets(draft.requestType, draft.activeTargets),
    date: draft.date || null,
    month: serializeMonthInput(draft.month),
    cursor: Number(draft.cursor || 0),
    min_read: numberOrNull(draft.minRead),
    max_read: numberOrNull(draft.maxRead)
  }
  if (!isCreate) payload.expected_updated_at = draft.updatedAt
  return payload
}

export function formatStrategyTimestamp(value) {
  return formatStrategyUpdatedAt(value)
}
