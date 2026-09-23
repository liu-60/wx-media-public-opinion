import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { openDatabase } from '../src/db.mjs'
import { argumentsMap } from '../src/runner/cli.mjs'
import { retentionExpiry, selectRetentionCandidates } from '../src/runner/retention.mjs'
import { createCollectionSchema } from '../src/runner/schema.mjs'

function parseJson(value) {
  try { return value ? JSON.parse(value) : {} } catch { return {} }
}

function safeRunId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]+$/u.test(value) && !['.', '..'].includes(value)
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsMap(argv)
  const dbPath = path.resolve(String(args.db || 'data/collection-orchestration.sqlite'))
  const root = path.resolve(String(args['artifact-root'] || 'data/collection-runs'))
  if (path.basename(root) !== 'collection-runs') throw new Error('artifact root must end with collection-runs')
  const rootPrefix = `${root}${path.sep}`
  const now = new Date(String(args.now || Date.now()))
  if (Number.isNaN(now.getTime())) throw new Error('--now is invalid')
  const db = openDatabase(dbPath)
  createCollectionSchema(db)
  try {
    const runs = db.prepare('SELECT id,status,publish_status,pinned,parent_run_id,retention_until,created_at,finished_at,artifact_manifest FROM collection_runs ORDER BY created_at').all()
    const candidates = selectRetentionCandidates(runs, now).filter(run => safeRunId(run.id)).map(run => ({ ...run, target: path.resolve(root, run.id) }))
    if (candidates.some(run => !run.target.startsWith(rootPrefix))) throw new Error('resolved cleanup target is outside artifact root')
    const applied = []
    if (args.apply === true) {
      for (const run of candidates) {
        await rm(run.target, { recursive: true, force: true })
        const manifest = { ...parseJson(run.artifact_manifest), status: 'expired', expired_at: now.toISOString() }
        db.prepare('UPDATE collection_runs SET artifact_manifest=?,updated_at=? WHERE id=?').run(JSON.stringify(manifest), now.toISOString(), run.id)
        applied.push(run.id)
      }
    }
    const output = { mode: args.apply === true ? 'apply' : 'dry-run', database: dbPath, artifact_root: root, now: now.toISOString(), candidates: candidates.map(run => ({ id: run.id, status: run.status, expires_at: retentionExpiry(run, now).toISOString() })), applied }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    return output
  } finally { db.close() }
}

if (import.meta.main) main().catch(error => { process.stderr.write(`${error?.stack || error?.message || error}\n`); process.exitCode = 1 })
