/**
 * 采集策略的业务文案与类型配置。
 *
 * 当前管理中心没有 TypeScript 构建步骤，因此本文件只使用可被浏览器
 * 直接执行的 TypeScript-compatible 模块语法；服务端按 JavaScript 模块提供。
 */
export const FIELD_LABELS = Object.freeze({
  id: '策略编号',
  request_type: '采集类型',
  source_targets: '目标范围',
  active_targets: '下次采集目标',
  completed_items: '本轮已完成',
  date: '采集日期',
  month: '采集月份',
  cursor: '请求页数',
  min_read: '最低阅读量',
  max_read: '最高阅读量',
  cycle_no: '当前轮次',
  updated_at: '更新时间'
})

export const REQUEST_TYPE_LABELS = Object.freeze({
  date: '按日期采集',
  month: '按月份采集',
  account: '按公众号采集',
  keyword: '按热词采集',
  wx_type: '按公众号类型采集'
})

export const REQUEST_TYPE_ICONS = Object.freeze({
  date: '◷',
  month: '▣',
  account: '◎',
  keyword: '✦',
  wx_type: '◇'
})

export const WX_TYPE_OPTIONS = Object.freeze([
  '时事', '文化', '健康', '职场', '学术', '美食', '民生', '科技', '情感', '楼市', '汽车', '幽默',
  '政务', '财富', '旅行', '企业', '时尚', '美体', '教育', '体娱', '百科', '乐活', '创业', '文摘'
])

export const STRATEGY_TYPE_CONFIG = Object.freeze({
  account: Object.freeze({
    label: REQUEST_TYPE_LABELS.account,
    icon: REQUEST_TYPE_ICONS.account,
    targetSelector: 'account',
    sourceLabel: '目标公众号',
    activeLabel: '下次采集公众号',
    targetUnit: '公众号',
    dateField: null,
    visibleFields: Object.freeze(['request_type', 'source_targets', 'active_targets', 'min_read', 'max_read', 'cursor', 'cycle_no'])
  }),
  wx_type: Object.freeze({
    label: REQUEST_TYPE_LABELS.wx_type,
    icon: REQUEST_TYPE_ICONS.wx_type,
    targetSelector: 'wxType',
    sourceLabel: '公众号分类',
    activeLabel: '下次采集分类',
    targetUnit: '分类',
    dateField: 'month',
    visibleFields: Object.freeze(['request_type', 'source_targets', 'active_targets', 'month', 'min_read', 'max_read', 'cursor', 'cycle_no'])
  }),
  keyword: Object.freeze({
    label: REQUEST_TYPE_LABELS.keyword,
    icon: REQUEST_TYPE_ICONS.keyword,
    targetSelector: 'keyword',
    sourceLabel: '目标热词',
    activeLabel: '下次采集热词',
    targetUnit: '热词',
    dateField: 'month',
    visibleFields: Object.freeze(['request_type', 'source_targets', 'active_targets', 'month', 'min_read', 'max_read', 'cursor', 'cycle_no'])
  }),
  date: Object.freeze({
    label: REQUEST_TYPE_LABELS.date,
    icon: REQUEST_TYPE_ICONS.date,
    targetSelector: null,
    sourceLabel: null,
    activeLabel: null,
    targetUnit: '',
    dateField: 'date',
    visibleFields: Object.freeze(['request_type', 'date', 'min_read', 'max_read', 'cursor', 'cycle_no'])
  }),
  month: Object.freeze({
    label: REQUEST_TYPE_LABELS.month,
    icon: REQUEST_TYPE_ICONS.month,
    targetSelector: null,
    sourceLabel: null,
    activeLabel: null,
    targetUnit: '',
    dateField: 'month',
    visibleFields: Object.freeze(['request_type', 'month', 'min_read', 'max_read', 'cursor', 'cycle_no'])
  })
})

export const STRATEGY_STATUS_LABELS = Object.freeze({
  configured: '已配置',
  disabled: '未启用',
  running: '运行中'
})

export function getStrategyTypeConfig(requestType) {
  return STRATEGY_TYPE_CONFIG[requestType] || STRATEGY_TYPE_CONFIG.account
}
