import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { openDatabase } from '../src/db.mjs'
import { argumentsMap } from '../src/runner/cli.mjs'
import { createArtifactStore } from '../src/runner/artifacts.mjs'
import { mergeCollectorConfig } from '../src/runner/config.mjs'
import { executeCollector } from '../src/runner/executor.mjs'
import { createCollectionDb } from '../management-center/services/collection-db.mjs'
import { resolveRegisteredEntrypoint, validateScriptSnapshot } from '../src/runner/registry.mjs'
import { createRunStore } from '../src/runner/run-store.mjs'
import { createCollectionSchema } from '../src/runner/schema.mjs'
import { runWorkflow } from '../src/runner/runner.mjs'
import { validateOutputArtifacts } from '../src/runner/workflow.mjs'
import { materializeInputArtifacts } from '../src/runner/input-artifacts.mjs'
import { canonicalizeArtifactRefs, normalizeArtifactEntry } from '../src/runner/artifact-contract.mjs'

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

function refList(value) { return Array.isArray(value) ? value : value ? [value] : [] }

async function persistArtifactManifest(store, runId, manifest) {
  try {
    return await store.updateRun(runId, { artifact_manifest: manifest })
  } catch (error) {
    if (!['UPSTREAM_UNAVAILABLE', 'UPSTREAM_TIMEOUT'].includes(error?.code)) throw error
    await new Promise(resolve => setTimeout(resolve, 500))
    try {
      return await store.updateRun(runId, { artifact_manifest: manifest })
    } catch (retryError) {
      if (!['UPSTREAM_UNAVAILABLE', 'UPSTREAM_TIMEOUT'].includes(retryError?.code)) throw retryError
      return null
    }
  }
}

async function executeRun({ run, store, artifacts, sourceArtifacts = artifacts, allowUntrackedLocal, leaseSeconds }) {
  const runRoot = artifacts.runPath(run.id)
  await mkdir(runRoot, { recursive: true })
  const ruleSnapshot = await artifacts.writeJson(run.id, 'rule-snapshot.json', run.rule_snapshot || {})
  const strategySnapshot = await artifacts.writeJson(run.id, 'strategy-snapshot.json', run.strategy_snapshot || {})
  const artifactEntries = [
    { artifact_id: ruleSnapshot.artifact_id, kind: 'snapshot', default_visible: false, step_key: '$run', availability: 'available', sha256: ruleSnapshot.sha256, bytes: ruleSnapshot.bytes },
    { artifact_id: strategySnapshot.artifact_id, kind: 'snapshot', default_visible: false, step_key: '$run', availability: 'available', sha256: strategySnapshot.sha256, bytes: strategySnapshot.bytes }
  ]
  let initialArtifacts = Array.isArray(run.config_snapshot?.input_artifacts) ? run.config_snapshot.input_artifacts.filter(value => value && value.artifact_id && value.sha256) : []
  try {
    const materialized = await materializeInputArtifacts({ runId: run.id, references: initialArtifacts, artifacts, sourceArtifacts, artifactEntries })
    initialArtifacts = materialized.references
  } catch (error) {
    const step = run.workflow_snapshot?.steps?.[0]
    if (step) {
      const stepRun = await store.createStepRun({ runId: run.id, stepKey: step.step_key, scriptSnapshot: step.script_snapshot || {}, attempt: 1, status: 'blocked' })
      await store.finishStepRun(stepRun.id, { status: 'blocked', error_code: error.code || 'INPUT_ARTIFACT_INVALID', error_message: error.message, finished_at: new Date().toISOString(), duration_ms: 0 })
    }
    await store.finishRun(run.id, 'blocked', { failure_count: 1, blocked_step: step?.step_key || null, blocked_reason: error.code || 'INPUT_ARTIFACT_INVALID', error_message: error.message })
    return { status: 'blocked', run: await store.getRun(run.id) }
  }
  if (run.config_snapshot?.publish_artifact_run_id && run.config_snapshot?.publish_artifact_id) {
    try {
      const sourceRunId = String(run.config_snapshot.publish_artifact_run_id)
      const artifactId = String(run.config_snapshot.publish_artifact_id)
      const expectedHash = run.config_snapshot.publish_write_set_hash || null
      const verified = await artifacts.verify(sourceRunId, artifactId, expectedHash)
      const content = await artifacts.read(sourceRunId, artifactId)
      const copied = await artifacts.writeText(run.id, artifactId, content)
      initialArtifacts.push({ artifact_id: copied.artifact_id, sha256: copied.sha256 })
      artifactEntries.push({ artifact_id: copied.artifact_id, kind: 'input', default_visible: false, step_key: '$run', source_run_id: sourceRunId, availability: 'available', sha256: copied.sha256, bytes: verified.bytes })
    } catch (error) {
      await store.finishRun(run.id, 'blocked', { failure_count: 1, blocked_reason: 'PUBLISH_ARTIFACT_INVALID', error_message: error.message })
      return { status: 'blocked', run: await store.getRun(run.id) }
    }
  }
  const heartbeatMs = Math.max(1000, Math.floor(leaseSeconds * 1000 / 2))
  const heartbeat = setInterval(() => { store.heartbeat(run.id, { leaseSeconds }).catch(() => {}) }, heartbeatMs)
  heartbeat.unref?.()
  try {
    const result = await runWorkflow({
      run,
      store,
      input: { input_artifacts: initialArtifacts, rule_snapshot_ref: ruleSnapshot, strategy_snapshot_ref: strategySnapshot },
      executeStep: async (step, { stepRun, attempt, input }) => {
        const snapshot = step.script_snapshot
        if (!snapshot?.entrypoint) return { status: 'failed', error_code: 'SCRIPT_SNAPSHOT_MISSING', message: 'collector script snapshot is missing' }
        let resolved
        try {
          resolved = resolveRegisteredEntrypoint(snapshot, { rootDir: PROJECT_ROOT, gitLsFiles: allowUntrackedLocal ? relative => relative : null })
          validateScriptSnapshot(snapshot, resolved)
        } catch (error) {
          return { status: 'failed', error_code: error.code || 'SCRIPT_VALIDATION_FAILED', message: error.message, duration_ms: 0 }
        }
        const config = mergeCollectorConfig({ scriptDefault: snapshot.default_config || {}, stepOverride: step.config_override || {}, runOverride: run.config_snapshot || {} })
        const declaredInputIds = Array.isArray(step.config_override?.input_artifacts) ? step.config_override.input_artifacts : []
        const protocolArtifactMap = new Map([...artifactEntries, ...(input.input_artifacts || [])].map(ref => [String(ref.artifact_id || ref.id || ''), ref]))
        const protocolArtifacts = declaredInputIds.length
          ? declaredInputIds.map(reference => protocolArtifactMap.get(String(reference?.artifact_id || reference?.id || reference))).filter(Boolean)
          : (input.input_artifacts || [])
        const protocolInput = {
          protocol_version: '1.0', run_id: run.id, step_run_id: stepRun.id, attempt, config,
          workdir: runRoot, input_artifacts: protocolArtifacts, rule_snapshot_ref: input.rule_snapshot_ref,
          strategy_snapshot_ref: input.strategy_snapshot_ref, publish_mode: run.config_snapshot?.publish_mode || 'preview',
          execution_mode: run.run_kind === 'single_script' || run.workflow_snapshot?.validation_only === true ? 'single_validation' : 'workflow'
        }
        const execution = await executeCollector({ entrypoint: resolved.absolutePath, input: protocolInput, workdir: PROJECT_ROOT, timeoutMs: Number(step.timeout_seconds || snapshot.timeout_seconds || 900) * 1000 })
        let logRef = null
        if (execution.stderr) {
          const log = await artifacts.writeLog(run.id, step.step_key, attempt, execution.stderr)
          logRef = log.relative_path
          artifactEntries.push({ artifact_id: log.artifact_id, relative_path: log.relative_path, kind: 'stderr-log', default_visible: false, step_key: step.step_key, attempt, availability: 'available', sha256: log.sha256, bytes: log.bytes })
        }
        if (!execution.result) return { status: execution.status || 'failed', error_code: execution.error_code || 'COLLECTOR_FAILED', message: execution.error_message || 'collector did not return a result', duration_ms: null, artifact: null }
        const refs = canonicalizeArtifactRefs(execution.result.artifact)
        const debugRefs = canonicalizeArtifactRefs(execution.result.debug_artifacts).map(ref => ({ ...ref, kind: 'debug', default_visible: false }))
        try {
          validateOutputArtifacts(snapshot.output_schema || {}, refs, { status: execution.result.status })
          for (const ref of refs) {
            const verified = await artifacts.verify(run.id, ref.artifact_id, ref.sha256)
            artifactEntries.push(normalizeArtifactEntry({ ...ref, step_key: step.step_key, attempt, kind: 'collector-output', default_visible: true, availability: 'available', bytes: verified.bytes }))
          }
          for (const ref of debugRefs) {
            const verified = await artifacts.verify(run.id, ref.artifact_id, ref.sha256)
            artifactEntries.push(normalizeArtifactEntry({ ...ref, step_key: step.step_key, attempt, availability: 'available', bytes: verified.bytes }))
          }
        } catch (error) {
          return { ...execution.result, status: 'failed', error_code: 'ARTIFACT_INVALID', message: error.message, artifact: null, debug_artifacts: [] }
        }
        const manifest = await artifacts.manifest(run.id, artifactEntries, { source: 'collection-worker', run_status: 'running' })
        await persistArtifactManifest(store, run.id, { schema_version: 'collection-artifact-v1', artifacts: artifactEntries, manifest_sha256: manifest.sha256 })
        return { ...execution.result, artifact: refs, debug_artifacts: debugRefs, log_ref: logRef }
      }
    })
    if (run.config_snapshot?.publish_mode === 'commit') {
      const publishStep = result.run?.summary?.steps?.['publish-results']
      await store.updateRun(run.id, { publish_status: publishStep?.status === 'success' ? 'confirmed' : 'failed' }).catch(() => null)
    }
    const finalManifest = await artifacts.manifest(run.id, artifactEntries, { source: 'collection-worker', run_status: result.status })
    await persistArtifactManifest(store, run.id, { schema_version: 'collection-artifact-v1', artifacts: artifactEntries, manifest_sha256: finalManifest.sha256 })
    return result
  } finally { clearInterval(heartbeat) }
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsMap(argv)
  const dbPath = path.resolve(String(args.db || 'data/collection-orchestration.sqlite'))
  const artifactRoot = path.resolve(String(args['artifact-root'] || 'data/collection-runs'))
  const testArtifactRoot = path.resolve(String(args['test-artifact-root'] || process.env.COLLECTION_TEST_ARTIFACT_ROOT || 'data/collection-test-artifacts'))
  const workerId = String(args['worker-id'] || `worker-${process.pid}`)
  const leaseSeconds = Math.max(15, Number(args['lease-seconds'] || 120))
  const allowUntrackedLocal = args['allow-untracked-local'] === true
  const remote = args.remote === true
  const db = remote ? null : openDatabase(dbPath)
  if (db) createCollectionSchema(db)
  const client = remote ? createCollectionDb({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY }) : null
  const store = createRunStore({ db, client, workerId })
  const artifacts = createArtifactStore(artifactRoot)
  const testArtifacts = createArtifactStore(testArtifactRoot)
  const targetRunId = args['run-id'] && args['run-id'] !== true ? String(args['run-id']) : null
  const waitSeconds = Math.max(5, Number(args['wait-seconds'] || 1800))
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  const claimTarget = async () => {
    if (!targetRunId) return store.claimNextRun({ leaseSeconds })
    const deadline = Date.now() + waitSeconds * 1000
    let waitingMarked = false
    while (Date.now() <= deadline) {
      const current = await store.getRun(targetRunId)
      if (!current) return null
      if (!['queued', 'retrying'].includes(current.status)) return current.status === 'running' && current.worker_id === workerId ? current : null
      const claimed = await store.claimRunById(targetRunId, { leaseSeconds })
      if (claimed) return claimed
      if (!waitingMarked) {
        await store.updateRun(targetRunId, { summary: { ...(current.summary || {}), execution_state: 'waiting_for_slot', waiting_since: new Date().toISOString() } })
        waitingMarked = true
      }
      await sleep(1000)
    }
    await store.updateRun(targetRunId, { status: 'failed', finished_at: new Date().toISOString(), lease_until: null, summary: { recovery: 'worker_slot_timeout', error_code: 'WORKER_SLOT_TIMEOUT', error_message: 'execution slot did not become available before timeout' } })
    return await store.getRun(targetRunId)
  }
  try {
    const recovered = await store.recoverExpiredRuns()
    const run = await claimTarget()
    if (!run) {
      process.stdout.write(`${JSON.stringify({ status: targetRunId ? 'not_claimed' : 'idle', run_id: targetRunId, worker_id: workerId, recovered })}\n`)
      return null
    }
    if (run.status === 'failed' && run.summary?.error_code === 'WORKER_SLOT_TIMEOUT') {
      process.stdout.write(`${JSON.stringify({ status: run.status, run_id: run.id, worker_id: workerId, recovered }, null, 2)}\n`)
      return { status: run.status, run }
    }
    const result = await executeRun({ run, store, artifacts, sourceArtifacts: testArtifacts, allowUntrackedLocal, leaseSeconds })
    process.stdout.write(`${JSON.stringify({ status: result.status, run_id: run.id, worker_id: workerId, recovered, database: dbPath, artifact_root: artifactRoot }, null, 2)}\n`)
    return result
  } catch (error) {
    if (targetRunId) {
      try { await store.markStartFailed(targetRunId, error?.message || 'worker execution failed') } catch {}
    }
    process.stderr.write(`${error?.stack || error?.message || error}\n`)
    return { status: 'failed', run_id: targetRunId, error_code: error?.code || 'WORKER_EXECUTION_FAILED', error_message: error?.message || String(error) }
  } finally { db?.close() }
}

if (import.meta.main) main().catch(error => { process.stderr.write(`${error?.stack || error?.message || error}\n`); process.exitCode = 1 })
