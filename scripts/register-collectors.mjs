import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../src/db.mjs'
import { argumentsMap } from '../src/runner/cli.mjs'
import { registerLocalCollectors } from '../src/runner/local-bootstrap.mjs'

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const DEFAULT_REGISTRY = path.join(PROJECT_ROOT, 'config/collectors/registry.json')

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsMap(argv)
  const dbPath = path.resolve(String(args.db || 'data/collection-orchestration.sqlite'))
  const registryPath = path.resolve(String(args.registry || DEFAULT_REGISTRY))
  const db = openDatabase(dbPath)
  try {
    const scripts = await registerLocalCollectors({ db, registryPath, rootDir: PROJECT_ROOT, allowUntrackedLocal: args['allow-untracked-local'] === true })
    process.stdout.write(`${JSON.stringify({ status: 'registered', database: dbPath, scripts: scripts.map(script => ({ id: script.id, script_key: script.script_key, version: script.version, enabled: Boolean(script.enabled), entrypoint: script.entrypoint, code_hash: script.code_hash })) }, null, 2)}\n`)
    return scripts
  } finally { db.close() }
}

if (import.meta.main) main().catch(error => { process.stderr.write(`${error?.stack || error?.message || error}\n`); process.exitCode = 1 })
