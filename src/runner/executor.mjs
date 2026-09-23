import { spawn } from 'node:child_process'
import { parseCollectorOutput, redactDiagnostic } from './contract.mjs'

function killTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => {})
    return
  }
  try { child.kill('SIGTERM') } catch {}
  setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 250).unref()
}

export function executeCollector({ entrypoint, input, workdir = process.cwd(), timeoutMs = 900_000, env = process.env, spawnImpl = spawn } = {}) {
  if (!entrypoint) return Promise.reject(new TypeError('entrypoint is required'))
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const child = spawnImpl(process.execPath, [entrypoint], { shell: false, cwd: workdir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const settle = result => {
      if (settled) return
      settled = true
      resolve(result)
    }
    child.stdout?.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', chunk => { stderr += redactDiagnostic(chunk.toString('utf8')) })
    child.on('error', error => settle({ status: 'failed', result: null, error_code: 'PROCESS_ERROR', error_message: redactDiagnostic(error.message), stderr }))
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    timer.unref?.()
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut) return settle({ status: 'timed_out', result: null, error_code: 'TIMED_OUT', error_message: 'collector exceeded timeout', stderr })
      try {
        const parsed = parseCollectorOutput(stdout, { exitCode: code })
        if (code !== 0 && parsed.result.status === 'success') return settle({ status: 'failed', result: null, error_code: 'EXIT_NONZERO', error_message: `collector exited with ${code}`, stderr, events: parsed.events })
        return settle({ status: parsed.result.status, result: parsed.result, stderr, events: parsed.events, businessFailure: parsed.businessFailure, exitCode: code })
      } catch (error) {
        settle({ status: 'failed', result: null, error_code: 'PROTOCOL_INVALID', error_message: redactDiagnostic(error.message), stderr, exitCode: code })
      }
    })
    child.stdin?.end(`${JSON.stringify(input)}\n`)
  })
}

export { killTree }
