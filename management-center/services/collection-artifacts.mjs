import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { canonicalArtifactType, isBusinessArtifact, normalizeArtifactEntry } from '../../src/runner/artifact-contract.mjs'

function safePart(value, field) {
  const text = String(value || '').trim()
  if (!text || text === '.' || text === '..' || /[\\/]/u.test(text) || !/^[A-Za-z0-9._:-]+$/u.test(text)) {
    const error = new Error(`${field} is unsafe`)
    error.status = 400
    error.code = 'INVALID_ARTIFACT_ID'
    throw error
  }
  return text
}

function safeRelative(value) {
  const text = String(value || '').trim().replaceAll('\\', '/')
  if (!text || text.startsWith('/') || text.split('/').some(part => !part || part === '.' || part === '..')) {
    const error = new Error('artifact path is unsafe')
    error.status = 400
    error.code = 'INVALID_ARTIFACT_ID'
    throw error
  }
  return text
}

async function readManifest(root, runId, run) {
  try { return JSON.parse(await readFile(path.join(root, runId, 'manifest.json'), 'utf8')) }
  catch { return run?.artifact_manifest || {} }
}

function requirementKey(artifactType, schemaVersion) { return JSON.stringify([String(artifactType || ''), String(schemaVersion || '')]) }

function entries(manifest) {
  if (Array.isArray(manifest)) return manifest
  return Array.isArray(manifest?.artifacts) ? manifest.artifacts.map(normalizeArtifactEntry) : []
}

function indexRequirements(requirements) {
  const exact = new Map()
  const typeOnly = new Map()
  const schemaOnly = new Map()
  const all = []
  for (const requirement of requirements) {
    if (requirement.artifactType && requirement.schemaVersion) {
      const key = requirementKey(requirement.artifactType, requirement.schemaVersion)
      const values = exact.get(key) || []
      values.push(requirement)
      exact.set(key, values)
    } else if (requirement.artifactType) {
      const values = typeOnly.get(requirement.artifactType) || []
      values.push(requirement)
      typeOnly.set(requirement.artifactType, values)
    } else if (requirement.schemaVersion) {
      const values = schemaOnly.get(requirement.schemaVersion) || []
      values.push(requirement)
      schemaOnly.set(requirement.schemaVersion, values)
    } else all.push(requirement)
  }
  return entry => [
    ...all,
    ...(exact.get(requirementKey(entry.artifact_type, entry.schema_version)) || []),
    ...(typeOnly.get(entry.artifact_type) || []),
    ...(schemaOnly.get(String(entry.schema_version ?? '')) || [])
  ]
}

function artifactFormat(entry, artifactId) {
  if (entry?.format === 'jsonl' || String(artifactId).toLowerCase().endsWith('.jsonl')) return 'jsonl'
  return 'json'
}

function recordsFromContent(content, format) {
  if (format === 'jsonl') {
    const records = []
    const invalid = []
    for (const [index, line] of content.split(/\r?\n/u).map(value => value.trim()).filter(Boolean).entries()) {
      try { records.push(JSON.parse(line)) } catch { invalid.push({ line: index + 1, code: 'INVALID_JSONL', message: 'JSONL 行无法解析' }) }
    }
    return { records, invalid }
  }
  let value
  try { value = JSON.parse(content) } catch { return { records: [], invalid: [{ line: 1, code: 'INVALID_JSON', message: 'JSON 无法解析' }] } }
  if (Array.isArray(value)) return { records: value, invalid: [] }
  for (const key of ['rows', 'records', 'accounts', 'articles', 'hotwords', 'data']) if (Array.isArray(value?.[key])) return { records: value[key], invalid: [] }
  return { records: [value], invalid: [] }
}

export function createCollectionArtifactService({ root = path.resolve('data/collection-runs'), testRoot: configuredTestRoot = null, runService } = {}) {
  if (!runService || typeof runService.get !== 'function') throw new TypeError('runService is required')
  const rootPath = path.resolve(root)
  const testRoot = path.resolve(configuredTestRoot || process.env.COLLECTION_TEST_ARTIFACT_ROOT || path.join(path.dirname(rootPath), 'collection-test-artifacts'))
  async function localCandidates(requirements, limits) {
    const itemsByRequirement = new Map(requirements.map(requirement => [requirement.key, []]))
    if (!requirements.some(requirement => (limits.get(requirement.key) || 0) > 0)) return itemsByRequirement
    let bundles
    try { bundles = await readdir(testRoot, { withFileTypes: true }) } catch { return itemsByRequirement }
    const matchRequirements = indexRequirements(requirements)
    for (const bundle of bundles.filter(item => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
      if (![...limits].some(([key, limit]) => (itemsByRequirement.get(key)?.length || 0) < limit)) break
      let manifest
      try { manifest = JSON.parse(await readFile(path.join(testRoot, bundle.name, 'manifest.json'), 'utf8')) } catch { continue }
      for (const entry of entries(manifest)) {
        if (entry?.availability && entry.availability !== 'available') continue
        if (!isBusinessArtifact(entry)) continue
        const matches = matchRequirements(entry)
        if (!matches.length) continue
        try { safeRelative(entry.relative_path || entry.artifact_id) } catch { continue }
        for (const requirement of matches) {
          const bucket = itemsByRequirement.get(requirement.key)
          if (bucket.length < (limits.get(requirement.key) || 0)) bucket.push({ ...entry, source: 'local_test', source_test_bundle_id: bundle.name })
        }
      }
    }
    return itemsByRequirement
  }

  async function collectCandidates(requirements, limit) {
    const itemsByRequirement = new Map(requirements.map(requirement => [requirement.key, []]))
    if (!requirements.length) return itemsByRequirement
    const matchRequirements = indexRequirements(requirements)
    const listRuns = typeof runService.listCandidates === 'function' ? runService.listCandidates.bind(runService) : runService.list.bind(runService)
    const runsResult = await listRuns({ page: 1, pageSize: Math.min(100, limit) })
    for (const run of runsResult.items || []) {
      const manifest = await readManifest(rootPath, String(run.id), run)
      for (const entry of entries(manifest)) {
        if (entry?.availability && entry.availability !== 'available') continue
        if (!isBusinessArtifact(entry)) continue
        const matches = matchRequirements(entry)
        for (const requirement of matches) {
          const bucket = itemsByRequirement.get(requirement.key)
          if (bucket.length < limit) bucket.push({ ...entry, source: 'run', source_run_id: String(run.id), run_status: run.status })
        }
      }
      if (requirements.every(requirement => itemsByRequirement.get(requirement.key).length >= limit)) break
    }
    const remaining = new Map(requirements.map(requirement => [requirement.key, Math.max(0, limit - itemsByRequirement.get(requirement.key).length)]))
    if ([...remaining.values()].some(value => value > 0)) {
      const local = await localCandidates(requirements, remaining)
      for (const requirement of requirements) itemsByRequirement.get(requirement.key).push(...local.get(requirement.key))
    }
    return itemsByRequirement
  }

  function parseRequirements(value) {
    if (Array.isArray(value)) return value
    if (typeof value !== 'string' || !value.trim() || value.length > 8_000) return null
    try { return JSON.parse(value) } catch { return null }
  }
  return Object.freeze({
    async list(runId) {
      const id = safePart(runId, 'run_id')
      const run = (await runService.get(id)).item
      const manifest = await readManifest(rootPath, id, run)
      return { run_id: id, schema_version: manifest.schema_version || null, items: entries(manifest).filter(isBusinessArtifact).map(({ content, ...entry }) => entry) }
    },
    async get(runId, artifactId, { offset = 0, limit = 200_000, page = null, pageSize = null, view = 'raw' } = {}) {
      const id = safePart(runId, 'run_id')
      const artifact = safePart(artifactId, 'artifact_id')
      const run = (await runService.get(id)).item
      const manifest = await readManifest(rootPath, id, run)
      const entry = entries(manifest).find(value => value?.artifact_id === artifact || value?.id === artifact)
      if (!entry) { const error = new Error('artifact not found'); error.status = 404; error.code = 'ARTIFACT_NOT_FOUND'; throw error }
      const relativePath = safeRelative(entry.relative_path || artifact)
      const target = path.resolve(rootPath, id, relativePath)
      const runRoot = path.resolve(rootPath, id)
      if (!target.startsWith(`${runRoot}${path.sep}`)) { const error = new Error('artifact path is unsafe'); error.status = 400; error.code = 'INVALID_ARTIFACT_ID'; throw error }
      const content = await readFile(target, 'utf8')
      const start = Math.max(0, Number(offset) || 0)
      const end = Math.min(content.length, start + Math.max(1, Number(limit) || 200_000))
      const response = { run_id: id, artifact_id: artifact, content: content.slice(start, end), truncated: end < content.length, manifest: entry }
      if (view === 'records' || page !== null || pageSize !== null) {
        const parsed = recordsFromContent(content, artifactFormat(entry, artifact))
        const currentPage = Math.max(1, Number(page) || 1)
        const currentPageSize = Math.min(500, Math.max(1, Number(pageSize) || 50))
        const begin = (currentPage - 1) * currentPageSize
        response.records = parsed.records.slice(begin, begin + currentPageSize)
        response.total = parsed.records.length
        response.page = currentPage
        response.pageSize = currentPageSize
        response.format = artifactFormat(entry, artifact)
        response.invalid_records = parsed.invalid
      }
      return response
    },
    async getStepLog(runId, stepRunId, { limit = 200_000 } = {}) {
      const id = safePart(runId, 'run_id')
      if (typeof runService.getStepRun !== 'function') {
        const error = new Error('步骤日志查询暂不可用')
        error.status = 503
        error.code = 'STEP_LOG_UNAVAILABLE'
        throw error
      }
      const stepResult = await runService.getStepRun(id, stepRunId)
      const step = stepResult?.item
      if (!step || String(step.run_id) !== id) {
        const error = new Error('未找到该运行下的步骤记录')
        error.status = 404
        error.code = 'STEP_RUN_NOT_FOUND'
        throw error
      }
      if (!step.log_ref) {
        const error = new Error('该步骤没有保存标准错误日志')
        error.status = 404
        error.code = 'STEP_LOG_NOT_FOUND'
        throw error
      }
      const run = (await runService.get(id)).item
      const manifest = await readManifest(rootPath, id, run)
      const entry = entries(manifest).find(value => value?.kind === 'stderr-log'
        && value?.relative_path === step.log_ref
        && value?.step_key === step.step_key
        && Number(value?.attempt) === Number(step.attempt)
        && value?.availability !== 'unavailable')
      if (!entry) {
        const error = new Error('步骤日志不在该运行的产物清单中')
        error.status = 404
        error.code = 'STEP_LOG_NOT_FOUND'
        throw error
      }
      const relativePath = safeRelative(entry.relative_path)
      const runRoot = path.resolve(rootPath, id)
      const runRelativePath = relativePath.startsWith(`${id}/`) ? relativePath.slice(id.length + 1) : relativePath
      const target = path.resolve(runRoot, runRelativePath)
      if (!target.startsWith(`${runRoot}${path.sep}`)) {
        const error = new Error('步骤日志路径无效')
        error.status = 400
        error.code = 'INVALID_ARTIFACT_ID'
        throw error
      }
      const buffer = await readFile(target)
      const sha256 = createHash('sha256').update(buffer).digest('hex')
      if (entry.sha256 && entry.sha256 !== sha256) {
        const error = new Error('步骤日志与产物清单中的校验值不一致')
        error.status = 409
        error.code = 'ARTIFACT_HASH_MISMATCH'
        throw error
      }
      const content = buffer.toString('utf8')
      const maxChars = Math.max(1, Math.min(500_000, Number(limit) || 200_000))
      const truncated = content.length > maxChars
      return {
        run_id: id,
        step_run_id: String(step.id),
        step_key: step.step_key,
        attempt: step.attempt,
        content: truncated ? content.slice(-maxChars) : content,
        truncated,
        bytes: buffer.byteLength,
        sha256
      }
    },
    async candidates({ artifactType = null, schemaVersion = null, artifact_type = null, schema_version = null, requirements: rawRequirements = null, limit = 100 } = {}) {
      artifactType = artifactType || artifact_type
      schemaVersion = schemaVersion || schema_version
      artifactType = artifactType ? canonicalArtifactType({ artifact_type: artifactType }) : null
      if (typeof runService.list !== 'function') return { items: [], total: 0 }
      const parsedLimit = Number(limit)
      const cap = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(100, Math.floor(parsedLimit)) : 100
      if (rawRequirements !== null && rawRequirements !== undefined) {
        const parsed = parseRequirements(rawRequirements)
        if (!Array.isArray(parsed) || parsed.length > 20 || parsed.some(item => !item || typeof item !== 'object' || !item.artifact_type || !item.schema_version)) {
          const error = new Error('requirements are invalid')
          error.status = 400
          error.code = 'INVALID_ARTIFACT_REQUIREMENTS'
          throw error
        }
        const requirements = [...new Map(parsed.map(item => {
          const type = canonicalArtifactType({ artifact_type: item.artifact_type })
          const version = String(item.schema_version).trim()
          const key = requirementKey(type, version)
          return [key, { key, artifactType: type, schemaVersion: version }]
        })).values()]
        const result = await collectCandidates(requirements, cap)
        const itemsByRequirement = Object.fromEntries([...result].map(([key, items]) => [key, items]))
        return { itemsByRequirement, total: Object.values(itemsByRequirement).reduce((sum, items) => sum + items.length, 0) }
      }
      const requirement = { key: requirementKey(artifactType, schemaVersion), artifactType, schemaVersion: schemaVersion ? String(schemaVersion) : null }
      const itemsByRequirement = await collectCandidates([requirement], cap)
      const items = itemsByRequirement.get(requirement.key) || []
      return { items, total: items.length }
    }
  })
}
