function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
  return value
}

function merge(left, right) {
  const result = isPlainObject(left) ? clone(left) : {}
  if (!isPlainObject(right)) return result
  for (const [key, value] of Object.entries(right)) result[key] = isPlainObject(value) && isPlainObject(result[key]) ? merge(result[key], value) : clone(value)
  return result
}

export const DEFAULT_RUN_OVERRIDE_KEYS = Object.freeze([
  'publish_mode', 'run_date', 'target_date', 'start_date', 'end_date', 'stat_date', 'request_type', 'request_types', 'lookback_days', 'range', 'base_url', 'request_budget',
  'page_budget', 'max_requests', 'max_hotwords', 'min_platform_count', 'merge_consistency_threshold', 'merge_min_article_count', 'title_overlap_threshold', 'min_article_count', 'stage', 'output_name', 'category_url', 'wechat_node_url', 'wechat_platform', 'plans', 'strategy', 'source', 'publish_only', 'publish_artifact_run_id', 'publish_artifact_id', 'publish_write_set_hash', 'input_artifacts'
])

export function mergeCollectorConfig({ scriptDefault = {}, stepOverride = {}, runOverride = {} } = {}) {
  return merge(merge(scriptDefault, stepOverride), runOverride)
}

export function selectAllowedRunOverride(value, allowlist = []) {
  if (!isPlainObject(value)) throw new TypeError('run override must be an object')
  const allowed = new Set(allowlist)
  return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key)).map(([key, item]) => [key, clone(item)]))
}
