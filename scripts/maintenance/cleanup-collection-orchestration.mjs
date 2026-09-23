import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { openDatabase } from '../../src/db.mjs'
import { argumentsMap } from '../../src/runner/cli.mjs'
import { createCollectionSchema } from '../../src/runner/schema.mjs'
import { loadCollectorRegistry, resolveRegisteredEntrypoint } from '../../src/runner/registry.mjs'
import { createCollectionDb } from '../../management-center/services/collection-db.mjs'

export const ORCHESTRATION_TABLES = Object.freeze([
  'collector_scripts',
  'collection_workflows',
  'collection_workflow_steps',
  'collection_runs',
  'collection_step_runs'
])

const TERMINAL_RUN_STATUSES = new Set(['success', 'partial', 'failed', 'cancelled', 'blocked', 'interrupted', 'timed_out', 'waiting_auth'])
const LEGACY_INPUT_KEYS = new Set(['input_artifacts', 'required_inputs'])

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
  return value
}

function stable(value) {
  const normalize = input => {
    if (Array.isArray(input)) return input.map(normalize)
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalize(item)]))
    return input === undefined ? null : input
  }
  return JSON.stringify(normalize(value))
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function rowsById(rows = []) {
  return new Map(rows.filter(Boolean).map(row => [String(row.id), row]))
}

function isStaleQueuedRun(row, now, staleAfterMs) {
  if (row?.run_kind !== 'single_script' || row.status !== 'queued') return false
  if (row.worker_id || row.heartbeat_at) return false
  if (parseJson(row.summary, {}).execution_state === 'waiting_for_slot') return false
  if (row.lease_until && new Date(row.lease_until).getTime() > now.getTime()) return false
  const updated = new Date(row.updated_at || row.created_at || 0).getTime()
  return Number.isFinite(updated) && now.getTime() - updated >= staleAfterMs
}

function finding({ table, problemType, rows, plannedAction, whyItConflicts, patch, row, exampleLimit = 10 }) {
  return {
    table,
    problem_type: problemType,
    count: rows.length,
    example_ids: rows.slice(0, exampleLimit).map(item => String(item.id)),
    planned_action: plannedAction,
    why_it_conflicts: whyItConflicts,
    row_ids: rows.map(item => String(item.id)),
    patch,
    row
  }
}

function canonicalRegistryContract(entry) {
  return {
    entrypoint: entry.entrypoint,
    run_mode: entry.run_mode || 'standalone',
    required_artifacts: entry.required_artifacts || [],
    output_schema: entry.output_schema || {},
    code_hash: entry.code_hash || null
  }
}

function collectLegacyInputValues(config) {
  const values = []
  for (const key of LEGACY_INPUT_KEYS) {
    if (Array.isArray(config?.[key])) values.push(...config[key].filter(value => typeof value === 'string'))
  }
  return values
}

export function auditOrchestrationRows({
  collectorScripts = [],
  registryScripts = [],
  workflows = [],
  workflowSteps = [],
  runs = [],
  stepRuns = [],
  now = new Date(),
  staleAfterMs = 30 * 60 * 1000,
  expectedValidationNames = new Set()
} = {}) {
  const findings = []
  const registry = new Map(registryScripts.map(item => [`${item.script_key}:${item.version}`, item]))
  const scriptsByKey = new Map()
  for (const row of collectorScripts) {
    const key = `${row.script_key}:${row.version}`
    if (!scriptsByKey.has(key)) scriptsByKey.set(key, [])
    scriptsByKey.get(key).push(row)
    const expected = registry.get(key)
    if (expected && row.enabled !== false) {
      const contract = canonicalRegistryContract(expected)
      const patch = {}
      for (const field of ['entrypoint', 'run_mode', 'required_artifacts', 'output_schema']) {
        if (stable(row[field]) !== stable(contract[field])) patch[field] = clone(contract[field])
      }
      if (contract.code_hash && row.code_hash !== contract.code_hash) patch.code_hash = contract.code_hash
      if (Object.keys(patch).length) findings.push(finding({
        table: 'collector_scripts', problemType: 'collector_contract_conflict', rows: [row],
        plannedAction: 'update_current_script_contract',
        whyItConflicts: '当前启用脚本的执行/输入/输出契约仍是旧验证与旧 Artifact 设计，无法按新 Runner 执行。',
        patch, row
      }))
    }
  }
  for (const duplicateRows of scriptsByKey.values()) {
    const enabled = duplicateRows.filter(row => row.enabled !== false)
    if (enabled.length > 1) {
      const keep = [...enabled].sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')) || Number(right.id) - Number(left.id))[0]
      const duplicates = enabled.filter(row => String(row.id) !== String(keep.id))
      for (const row of duplicates) findings.push(finding({
        table: 'collector_scripts', problemType: 'duplicate_active_registration', rows: [row],
        plannedAction: 'disable_duplicate_registration',
        whyItConflicts: '同一 script_key+version 有多个有效注册，validation workflow 无法唯一选择脚本。',
        patch: { enabled: false }, row
      }))
    }
  }

  const workflowMap = rowsById(workflows)
  const runRefs = new Set(runs.filter(row => row.workflow_id !== null && row.workflow_id !== undefined).map(row => String(row.workflow_id)))
  for (const row of workflows) {
    const name = String(row.name || '')
    const isLegacyValidation = /^validation[-_]/u.test(name) || (row.validation_only === true && !expectedValidationNames.has(name))
    if (isLegacyValidation && !expectedValidationNames.has(name) && row.enabled !== false) {
      findings.push(finding({
        table: 'collection_workflows', problemType: 'legacy_validation_workflow', rows: [row],
        plannedAction: 'disable_legacy_validation_workflow',
        whyItConflicts: '旧验证机制为每次执行创建独立 validation workflow；新机制要求按脚本版本复用一个系统 validation workflow。',
        patch: { enabled: false, system_generated: true, validation_only: true }, row
      }))
    }
  }

  for (const row of workflowSteps) {
    const workflow = workflowMap.get(String(row.workflow_id))
    if (!workflow || workflow.enabled === false || workflow.validation_only === true || row.enabled === false) continue
    const config = parseJson(row.config_override, {})
    const legacyValues = collectLegacyInputValues(config)
    if (!legacyValues.length) continue
    const next = { ...config }
    for (const key of LEGACY_INPUT_KEYS) delete next[key]
    findings.push(finding({
      table: 'collection_workflow_steps', problemType: 'legacy_input_contract', rows: [row],
      plannedAction: 'migrate_input_contract_to_artifact_type',
      whyItConflicts: `当前有效工作流仍依赖旧文件名（${legacyValues.join(', ')}），新执行依赖 canonical artifact.type。`,
      patch: { config_override: next }, row
    }))
  }

  const staleRuns = runs.filter(row => isStaleQueuedRun(row, now, staleAfterMs))
  for (const row of staleRuns) findings.push(finding({
    table: 'collection_runs', problemType: 'stale_queued', rows: [row],
    plannedAction: 'mark_interrupted',
    whyItConflicts: '旧单脚本验证 Run 无 Worker、无 heartbeat、无有效 lease，继续显示 queued 会遮蔽新验证执行状态。',
    patch: { status: 'interrupted', finished_at: now.toISOString(), worker_id: null, lease_until: null, summary: { ...parseJson(row.summary, {}), recovery: 'legacy_stale_queued_cleanup' } }, row
  }))

  const staleRunIds = new Set(staleRuns.map(row => String(row.id)))
  const terminalOrInterruptedRuns = new Set(runs.filter(row => TERMINAL_RUN_STATUSES.has(row.status) || staleRunIds.has(String(row.id))).map(row => String(row.id)))
  for (const row of stepRuns) {
    if (!['running', 'pending'].includes(row.status) || !terminalOrInterruptedRuns.has(String(row.run_id))) continue
    const parent = runs.find(run => String(run.id) === String(row.run_id))
    findings.push(finding({
      table: 'collection_step_runs', problemType: 'orphaned_active_step', rows: [row],
      plannedAction: 'mark_interrupted',
      whyItConflicts: `父 Run 已是 ${parent?.status || '结束'}，该 Step 仍 active 会让管理中心展示错误的执行状态。`,
      patch: { status: 'interrupted', finished_at: now.toISOString(), error_code: 'LEGACY_STALE_QUEUED_CLEANUP', error_message: 'parent run is no longer executable' }, row
    }))
  }

  return { generated_at: now.toISOString(), stale_after_minutes: Math.round(staleAfterMs / 60000), findings }
}

export async function applyOrchestrationFindings({ adapter, findings = [] } = {}) {
  if (!adapter || typeof adapter.patch !== 'function') throw new TypeError('orchestration adapter is required')
  let changed = 0
  for (const item of findings) {
    if (!ORCHESTRATION_TABLES.includes(item.table) || !item.patch) throw new Error(`invalid orchestration cleanup table: ${item.table}`)
    const current = item.row || null
    const targetStatus = item.patch.status
    if (targetStatus && current?.status === targetStatus) continue
    if (item.table === 'collection_workflow_steps' && stable(parseJson(current?.config_override, {})) === stable(item.patch.config_override)) continue
    if (item.table === 'collector_scripts' && Object.entries(item.patch).every(([key, value]) => stable(current?.[key]) === stable(value))) continue
    if (item.table === 'collection_workflows' && current?.enabled === false) continue
    await adapter.patch(item.table, String(item.row?.id || item.example_ids?.[0]), item.patch)
    changed += 1
  }
  return { changed }
}

function sqliteAdapter(db) {
  const jsonColumns = new Set(['default_config', 'input_schema', 'output_schema', 'capabilities', 'required_artifacts', 'retention_config', 'config_override', 'condition', 'workflow_snapshot', 'config_snapshot', 'rule_snapshot', 'strategy_snapshot', 'summary', 'artifact_manifest', 'script_snapshot', 'checkpoint'])
  return {
    async list(table) {
      if (!ORCHESTRATION_TABLES.includes(table)) throw new Error(`invalid orchestration table: ${table}`)
      return db.prepare(`SELECT * FROM ${table}`).all().map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonColumns.has(key) && typeof value === 'string' ? parseJson(value, {}) : value])))
    },
    async patch(table, id, patch) {
      if (!ORCHESTRATION_TABLES.includes(table)) throw new Error(`invalid orchestration table: ${table}`)
      const entries = Object.entries(patch)
      const columns = entries.map(([key]) => `${key}=?`).join(',')
      const values = entries.map(([key, value]) => jsonColumns.has(key) ? JSON.stringify(value ?? {}) : value)
      db.prepare(`UPDATE ${table} SET ${columns}, updated_at=? WHERE id=?`).run(...values, new Date().toISOString(), id)
    }
  }
}

async function remoteAdapter(client) {
  return {
    async list(table) {
      if (!ORCHESTRATION_TABLES.includes(table)) throw new Error(`invalid orchestration table: ${table}`)
      const result = await client.list(table, { limit: 1000, offset: 0 })
      return Array.isArray(result?.data) ? result.data : []
    },
    async patch(table, id, patch) {
      if (!ORCHESTRATION_TABLES.includes(table)) throw new Error(`invalid orchestration table: ${table}`)
      await client.patch(table, [{ column: 'id', operator: 'eq', value: id }], patch)
    }
  }
}

async function expectedRegistryScripts({ registryPath, rootDir }) {
  const entries = await loadCollectorRegistry(registryPath)
  return entries.map(entry => {
    if (entry.enabled === false) return entry
    try {
      const resolved = resolveRegisteredEntrypoint(entry, { rootDir, gitLsFiles: relative => relative })
      return { ...entry, code_hash: resolved.codeHash }
    } catch {
      return entry
    }
  })
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsMap(argv)
  const rootDir = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const registryPath = path.resolve(String(args.registry || path.join(rootDir, 'config/collectors/registry.json')))
  const staleMinutes = Math.max(1, Number(args['stale-minutes'] || 30))
  const now = new Date()
  let db = null
  let adapter
  if (args.remote === true) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required for --remote')
    adapter = await remoteAdapter(createCollectionDb({ url, key }))
  } else {
    const dbPath = path.resolve(String(args.db || path.join(rootDir, 'data/collection-orchestration.sqlite')))
    db = openDatabase(dbPath)
    createCollectionSchema(db)
    adapter = sqliteAdapter(db)
  }
  try {
    const [collectorScripts, workflows, workflowSteps, runs, stepRuns, registryScripts] = await Promise.all([
      adapter.list('collector_scripts'), adapter.list('collection_workflows'), adapter.list('collection_workflow_steps'), adapter.list('collection_runs'), adapter.list('collection_step_runs'), expectedRegistryScripts({ registryPath, rootDir })
    ])
    const expectedValidationNames = new Set(registryScripts.filter(item => item.enabled !== false && item.run_mode !== 'workflow_only').map(item => `validation:${item.script_key}:v${item.version}`))
    const report = auditOrchestrationRows({ collectorScripts, registryScripts, workflows, workflowSteps, runs, stepRuns, now, staleAfterMs: staleMinutes * 60 * 1000, expectedValidationNames })
    const dryRun = args.apply !== true
    if (!dryRun) {
      const applied = await applyOrchestrationFindings({ adapter, findings: report.findings })
      report.applied = applied
      report.mode = 'apply'
    } else {
      report.applied = { changed: 0 }
      report.mode = 'dry-run'
    }
    if (args.report) await writeFile(path.resolve(String(args.report)), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return report
  } finally { db?.close() }
}

if (import.meta.main) main().catch(error => { process.stderr.write(`${error?.stack || error?.message || error}\n`); process.exitCode = 1 })
