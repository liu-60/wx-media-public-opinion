export const ACCOUNT_FIELD_LABELS = Object.freeze({
  account_id: '账号 ID',
  wx_biz: '公众号账号 ID',
  wx_name: '公众号名称',
  verify: '认证信息',
  description: '简介',
  decision_status: '审核状态',
  decision_source: '审核来源',
  filter_rule_id: '过滤规则',
  read_avg: '平均阅读量',
  read_median: '中位阅读量',
  read_max: '最高阅读量',
  active_days: '活跃天数',
  burst_count: '爆文数',
  burst_rate: '爆文率',
  pub_count: '文章数',
  last_pub_time: '最后发文',
  collected_at: '采集时间',
  tags: '自动标签',
  manual_tags: '人工标签',
  wx_user: '微信号',
  wx_type: '公众号分类',
  region: '地区',
  look_avg: '在看平均',
  look_median: '在看中位',
  look_max: '在看最高',
  like_avg: '点赞平均',
  like_median: '点赞中位',
  like_max: '点赞最高',
  share_avg: '分享平均',
  share_median: '分享中位',
  share_max: '分享最高',
  comment_avg: '留言平均',
  comment_median: '留言中位',
  comment_max: '留言最高',
  ori_count: '原创数'
})

export const ARTICLE_FIELD_LABELS = Object.freeze({
  id: '文章 ID',
  account_id: '账号 ID',
  article_sn: '文章唯一标识',
  title: '文章标题',
  article_url: '文章链接',
  published_at: '发布时间',
  read_num: '阅读量',
  like_num: '点赞数',
  look_num: '在看数',
  share_num: '分享数',
  comment_num: '留言数',
  is_original: '原创状态',
  source_code: '来源',
  updated_at: '更新时间',
  publisher: '公众号'
})

export const DECISION_STATUS_META = Object.freeze({
  0: { label: '待审核', color: 'warning' },
  1: { label: '通过', color: 'success' },
  2: { label: '过滤', color: 'error' },
  3: { label: '待复核', color: 'processing' }
})

export const DECISION_SOURCE_LABELS = Object.freeze({ manual: '人工', auto: '自动' })

export const RULE_OPERATOR_LABELS = Object.freeze({
  exact: '完全匹配',
  contains: '包含',
  not_contains: '不包含',
  eq: '等于',
  gt: '大于',
  gte: '大于等于',
  lt: '小于',
  lte: '小于等于'
})

export const RULE_SCOPE_LABELS = Object.freeze({ account: '公众号', article: '文章', hotword: '热词' })

export const RULE_FIELD_LABELS = Object.freeze({
  name: '公众号名称',
  verification: '认证主体',
  description: '简介',
  read_median: '中位阅读量',
  title: '文章标题',
  read_count: '阅读量',
  like_count: '点赞数',
  comment_count: '留言数',
  hotword: '热词'
})

export const FIELD_FORMATTERS = Object.freeze({
  read_avg: value => formatMetric(value),
  read_median: value => formatMetric(value),
  read_max: value => formatMetric(value),
  read_num: ({ value, row }) => formatMetric(value, { capped: row?.read_num_capped === true }),
  like_num: value => formatMetric(value),
  share_num: value => formatMetric(value),
  comment_num: value => formatMetric(value),
  look_num: value => formatMetric(value),
  burst_rate: value => formatRate(value)
})

export function parseListValue(value) {
  if (Array.isArray(value)) return value.filter(item => item !== null && item !== undefined && String(item).trim() !== '').map(String)
  if (value === null || value === undefined || value === '') return []
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parseListValue(parsed)
    } catch {}
    return value.split(/[，,\n]/u).map(item => item.trim()).filter(Boolean)
  }
  return [String(value)]
}

export function formatMetric(value, { capped = false } = {}) {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value)
  if (capped) return '100,000+'
  if (number >= 100000) return `${Math.floor(number / 10000)}万+`
  if (number >= 10000) return `${Number((number / 10000).toFixed(2))}万`
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(number)
}

export function formatRate(value) {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value)
  return `${(number * 100).toFixed(2).replace(/\.00$/u, '')}%`
}

export function formatDateTime(value) {
  if (value === null || value === undefined || value === '') return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return String(value)
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(parsed).replaceAll('/', '-')
}

export function formatDate(value) {
  if (value === null || value === undefined || value === '') return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return String(value)
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed).replaceAll('/', '-')
}

export function displayFieldValue(field, value, row = null) {
  const formatter = FIELD_FORMATTERS[field]
  if (!formatter) return value === null || value === undefined || value === '' ? '—' : String(value)
  return field === 'read_num' ? formatter({ value, row }) : formatter(value)
}

export function decisionLabel(value) {
  return DECISION_STATUS_META[String(value)]?.label || '未知'
}

export function decisionSourceLabel(value) {
  return DECISION_SOURCE_LABELS[value] || (value === null || value === undefined || value === '' ? '—' : String(value))
}

export function ruleValue(row) {
  return row?.value_text ?? row?.value_number ?? '—'
}
