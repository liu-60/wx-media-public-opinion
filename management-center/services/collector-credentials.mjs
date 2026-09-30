import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadCollectorEnvironment } from '../../src/collector-config.mjs'

const DEFAULT_CREDENTIALS_FILE = path.resolve('data', 'collector-credentials.json')
const CREDENTIAL_REF = /^[A-Z][A-Z0-9_]{1,127}$/u

function credentialFilePath(filePath) {
  const configured = filePath || process.env.COLLECTOR_CREDENTIALS_FILE
  return path.resolve(configured || DEFAULT_CREDENTIALS_FILE)
}

function readCredentials(filePath) {
  if (!existsSync(filePath)) return {}
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => CREDENTIAL_REF.test(key) && typeof value === 'string' && value.length > 0))
  } catch {
    return {}
  }
}

function maskCredential(value) {
  const text = String(value || '')
  if (!text) return ''
  if (text.length <= 8) return '••••'
  return `${text.slice(0, 3)}…${text.slice(-4)}`
}

function validateRef(ref) {
  const value = String(ref || '').trim()
  if (!CREDENTIAL_REF.test(value)) {
    const error = new Error('credential_ref 格式不正确')
    error.status = 400
    error.code = 'INVALID_CREDENTIAL_REF'
    throw error
  }
  return value
}

function safeMeta(ref, value, source) {
  return { credential_ref: ref, configured: Boolean(value), masked: maskCredential(value), source: value ? source : 'none' }
}

/**
 * Local server-only credential storage. The API exposes only safe metadata;
 * saved values are injected into each new run's child environment.
 */
export function createCollectorCredentialStore({ filePath } = {}) {
  const target = credentialFilePath(filePath)
  const getSaved = ref => readCredentials(target)[validateRef(ref)] || ''
  const getValue = ref => {
    const name = validateRef(ref)
    const saved = readCredentials(target)[name]
    return saved || String(process.env[name] || '')
  }
  const get = ref => {
    const name = validateRef(ref)
    const saved = readCredentials(target)[name]
    if (saved) return safeMeta(name, saved, 'saved')
    const environment = String(process.env[name] || '')
    return safeMeta(name, environment, environment ? 'environment' : 'none')
  }
  const set = (ref, value) => {
    const name = validateRef(ref)
    if (typeof value !== 'string' || !value.trim()) {
      const error = new Error('请输入有效的配置 key')
      error.status = 400
      error.code = 'INVALID_CREDENTIAL_VALUE'
      throw error
    }
    const credentials = readCredentials(target)
    credentials[name] = value.trim()
    const directory = path.dirname(target)
    mkdirSync(directory, { recursive: true })
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(temporary, 0o600) } catch { /* Windows may not expose POSIX modes. */ }
    renameSync(temporary, target)
    try { chmodSync(target, 0o600) } catch { /* Windows may not expose POSIX modes. */ }
    return get(name)
  }
  const toEnvironment = () => readCredentials(target)
  return Object.freeze({
    filePath: target,
    get,
    getValue,
    getSaved,
    set,
    toEnvironment
  })
}

export function createCollectorEnvironmentProvider({ store = createCollectorCredentialStore(), baseEnv = process.env } = {}) {
  return () => ({ ...loadCollectorEnvironment({ env: baseEnv }), ...store.toEnvironment() })
}
