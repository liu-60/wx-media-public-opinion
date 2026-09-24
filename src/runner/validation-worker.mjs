import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const WORKER_ENTRYPOINT = path.join(PROJECT_ROOT, 'scripts', 'run-collector-worker.mjs')

/**
 * 启动一次指定 Run 的现有 Collector Worker。启动成功只代表子进程已创建，
 * 真正的业务结果仍由 Runner 写回 collection_runs/step_runs。
 */
export function createValidationWorkerStarter({ rootDir = PROJECT_ROOT, workerEntrypoint = WORKER_ENTRYPOINT, env = process.env, envProvider = null } = {}) {
  return ({ runId, workerId = `validation-worker-${process.pid}-${Date.now()}`, leaseSeconds = 120 } = {}) => new Promise((resolve, reject) => {
    if (!runId) {
      const error = new Error('runId is required')
      error.code = 'WORKER_START_FAILED'
      reject(error)
      return
    }
    const childEnv = typeof envProvider === 'function' ? envProvider() : env
    const child = spawn(process.execPath, [workerEntrypoint, '--remote', '--run-id', String(runId), '--worker-id', String(workerId), '--lease-seconds', String(leaseSeconds), '--allow-untracked-local'], {
      cwd: rootDir,
      env: { ...childEnv },
      stdio: 'ignore',
      windowsHide: true,
      detached: false,
      shell: false
    })
    child.once('error', error => {
      error.code = error.code || 'WORKER_START_FAILED'
      reject(error)
    })
    child.once('spawn', () => resolve({ pid: child.pid, worker_id: workerId }))
  })
}

export const startValidationWorker = createValidationWorkerStarter()
