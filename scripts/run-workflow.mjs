import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../src/db.mjs'
import { argumentsMap, jsonArgument } from '../src/runner/cli.mjs'
import { DEFAULT_RUN_OVERRIDE_KEYS, selectAllowedRunOverride } from '../src/runner/config.mjs'
import { bootstrapCollection } from '../src/runner/local-bootstrap.mjs'

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const DEFAULT_REGISTRY = path.join(PROJECT_ROOT, 'config/collectors/registry.json')
const DEFAULT_WORKFLOW = path.join(PROJECT_ROOT, 'config/collectors/default-workflow.json')

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsMap(argv)
  const dbPath = path.resolve(String(args.db || 'data/collection-orchestration.sqlite'))
  const registryPath = path.resolve(String(args.registry || DEFAULT_REGISTRY))
  const workflowPath = path.resolve(String(args.workflow || DEFAULT_WORKFLOW))
  const runConfig = selectAllowedRunOverride({ ...jsonArgument(args.config, {}), ...(args['publish-mode'] ? { publish_mode: args['publish-mode'] } : {}) }, DEFAULT_RUN_OVERRIDE_KEYS)
  if (runConfig.publish_mode && !['none', 'preview', 'commit'].includes(runConfig.publish_mode)) throw new Error('--publish-mode must be none, preview, or commit')
  const db = openDatabase(dbPath)
  try {
    const result = await bootstrapCollection({ db, registryPath, workflowPath, rootDir: PROJECT_ROOT, allowUntrackedLocal: args['allow-untracked-local'] === true, runConfig, runId: args['run-id'] })
    process.stdout.write(`${JSON.stringify({ status: 'queued', run_id: result.run.id, database: dbPath, workflow_id: result.workflow.id, workflow_revision: result.workflow.revision, steps: result.workflowSnapshot.steps.map(step => ({ step_key: step.step_key, seq: step.seq, enabled: step.enabled })) }, null, 2)}\n`)
    return result
  } finally { db.close() }
}

if (import.meta.main) main().catch(error => { process.stderr.write(`${error?.stack || error?.message || error}\n`); process.exitCode = 1 })
