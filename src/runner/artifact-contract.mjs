/**
 * 业务 Artifact 的稳定契约与旧运行兼容层。
 *
 * 文件名只用于定位物理文件，工作流依赖和管理中心展示统一使用
 * artifact_type。历史 manifest 不会被回写；读取时在这里完成映射。
 */

export const BUSINESS_ARTIFACT_TYPES = Object.freeze([
  'accounts',
  'articles',
  'hotwords',
  'filtered_articles',
  'write_set',
  'publish_result',
  'exceptions'
])

export const DEBUG_ARTIFACT_TYPES = Object.freeze([
  'raw_response',
  'debug_report',
  'collector_errors',
  'filter_report'
])

const LEGACY_TYPE_MAP = new Map([
  ['normalized_accounts', 'accounts'],
  ['normalized_articles', 'articles'],
  ['frozen_write_set', 'write_set'],
  ['publish_preview', 'publish_result'],
  ['collector_errors', 'exceptions'],
  ['filter_report', 'debug_report']
])

const LEGACY_FILE_MAP = [
  [/^(?:wxrank-base-)?accounts(?:-updated)?\.json$/iu, 'accounts'],
  [/^wxrank-base-accounts\.json$/iu, 'accounts'],
  [/^redfox-gzh-normalized\.json$/iu, 'articles'],
  [/^hotwords-updated\.json$/iu, 'hotwords'],
  [/^(?:frozen-write-set|write-set)\.json$/iu, 'write_set'],
  [/^publish-(?:preview|result)\.json$/iu, 'publish_result'],
  [/^(?:wxrank-base|redfox-gzh)-errors\.json$/iu, 'exceptions'],
  [/^(?:wxrank-base|redfox-gzh)-raw\.json$/iu, 'raw_response'],
  [/^articles-filter-report\.json$/iu, 'debug_report']
]

function fileName(value) {
  return String(value || '').replaceAll('\\', '/').split('/').pop() || ''
}

export function canonicalArtifactType(entry = {}) {
  const rawType = String(entry.artifact_type || entry.type || '').trim()
  if (BUSINESS_ARTIFACT_TYPES.includes(rawType)) return rawType
  if (LEGACY_TYPE_MAP.has(rawType)) return LEGACY_TYPE_MAP.get(rawType)
  const name = fileName(entry.artifact_id || entry.id || entry.relative_path)
  for (const [pattern, type] of LEGACY_FILE_MAP) if (pattern.test(name)) return type
  return rawType || null
}

function inferredKind(type, entry = {}) {
  if (entry.kind) return String(entry.kind)
  if (DEBUG_ARTIFACT_TYPES.includes(type) || type === 'raw_response') return 'debug'
  return 'collector-output'
}

export function normalizeArtifactEntry(entry = {}) {
  const type = canonicalArtifactType(entry)
  const kind = inferredKind(type, entry)
  const debug = entry.default_visible === false || kind === 'debug' || kind === 'snapshot' || kind === 'stderr-log' || DEBUG_ARTIFACT_TYPES.includes(type)
  return {
    ...entry,
    ...(type ? { artifact_type: type } : {}),
    kind,
    default_visible: debug ? false : entry.default_visible !== false
  }
}

export function normalizeArtifactManifest(manifest = {}) {
  const source = manifest && typeof manifest === 'object' ? manifest : {}
  const artifacts = Array.isArray(source.artifacts) ? source.artifacts.map(normalizeArtifactEntry) : []
  return { ...source, artifacts, schema_version: source.schema_version || 'collection-artifact-v1' }
}

export function isBusinessArtifact(entry = {}) {
  const normalized = normalizeArtifactEntry(entry)
  return normalized.default_visible !== false && (BUSINESS_ARTIFACT_TYPES.includes(normalized.artifact_type) || (!normalized.artifact_type && normalized.kind === 'collector-output')) && normalized.availability !== 'unavailable'
}

export function canonicalizeArtifactRef(entry = {}) {
  if (!canonicalArtifactType(entry)) return { ...entry }
  const normalized = normalizeArtifactEntry(entry)
  return { ...normalized, artifact_type: normalized.artifact_type }
}

export function canonicalizeArtifactRefs(entries = []) {
  return (Array.isArray(entries) ? entries : entries ? [entries] : []).filter(Boolean).map(canonicalizeArtifactRef)
}

export function artifactTypeMatches(left, right) {
  return canonicalArtifactType(left) === canonicalArtifactType(right) && String(left?.schema_version || '1') === String(right?.schema_version || '1')
}

export { LEGACY_TYPE_MAP, LEGACY_FILE_MAP }
