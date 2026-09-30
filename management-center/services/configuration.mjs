import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { COLLECTOR_CONFIG_DEFAULTS, loadCollectorEnvironment, readDotEnv } from '../../src/collector-config.mjs'

const DEFAULT_FILE = path.resolve('data', 'collector-configuration.json')
const SECRET_REFS = Object.freeze({ wxrank: 'WXRANK_API_KEY', wxrank_authorization: 'WXRANK_AUTHORIZATION', wxrank_cookie: 'WXRANK_COOKIE', redfox: 'REDFOX_API_KEY', llm: 'LLM_API_KEY' })

function readSettings(filePath) {
  if (!existsSync(filePath)) return {}
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

function mask(value) {
  const text = String(value || '')
  return text ? (text.length <= 8 ? '••••' : `${text.slice(0, 3)}…${text.slice(-4)}`) : ''
}

function checkedUrl(value, label, allowEmpty = false) {
  const text = String(value ?? '').trim()
  if (!text && allowEmpty) return ''
  let url
  try { url = new URL(text) } catch {}
  if (!url || !['https:', 'http:'].includes(url.protocol)) {
    const error = new Error(`${label}必须是 http(s) URL`)
    error.status = 400
    error.code = 'INVALID_CONFIGURATION_URL'
    throw error
  }
  return text.replace(/\/+$/u, '')
}

function safeSource(ref, store, env, dotenv) {
  if (store?.getSaved?.(ref)) return '本地保存'
  if (String(env?.[ref] || '')) return '进程环境'
  if (String(dotenv?.[ref] || '')) return '.env'
  return '未配置'
}

function secretView(ref, store, env, dotenv) {
  const resolved = loadCollectorEnvironment({ env })[ref] || ''
  return { configured: Boolean(resolved), masked: mask(resolved), source: safeSource(ref, store, env, dotenv) }
}

export function createConfigurationService({ credentialStore, filePath = DEFAULT_FILE, env = process.env, dotenvPath } = {}) {
  if (!credentialStore || typeof credentialStore.set !== 'function') throw new TypeError('credentialStore is required')
  const target = path.resolve(filePath)
  const save = value => {
    mkdirSync(path.dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(temporary, 0o600) } catch {}
    renameSync(temporary, target)
    try { chmodSync(target, 0o600) } catch {}
  }
  return Object.freeze({
    get() {
      const stored = readSettings(target)
      const dotEnv = readDotEnv(dotenvPath)
      const resolved = loadCollectorEnvironment({ env, settingsPath: target, dotenvPath })
      const apiValues = stored.apis || {}
      const llmValues = stored.llm || {}
      const settingSource = (storedValue, envName) => storedValue ? '本地保存' : env[envName] ? '进程环境' : dotEnv[envName] ? '.env' : '默认值'
      return {
        priority: ['本地保存配置', '进程环境', '.env', '默认值'],
        apis: {
          wxrank: {
            base_url: apiValues.wxrank?.base_url || resolved.WXRANK_API_URL || COLLECTOR_CONFIG_DEFAULTS.WXRANK_API_URL,
            search_url: apiValues.wxrank?.search_url || resolved.WXRANK_SEARCH_API_URL || COLLECTOR_CONFIG_DEFAULTS.WXRANK_SEARCH_API_URL,
            account_base_url: apiValues.wxrank?.account_base_url || resolved.WXRANK_ACCOUNT_API_URL || COLLECTOR_CONFIG_DEFAULTS.WXRANK_ACCOUNT_API_URL,
            key: secretView(SECRET_REFS.wxrank, credentialStore, env, dotEnv),
            authorization: secretView(SECRET_REFS.wxrank_authorization, credentialStore, env, dotEnv),
            cookie: secretView(SECRET_REFS.wxrank_cookie, credentialStore, env, dotEnv),
            source: settingSource(apiValues.wxrank?.base_url, 'WXRANK_API_URL')
          },
          redfox: {
            base_url: apiValues.redfox?.base_url || resolved.REDFOX_API_URL || COLLECTOR_CONFIG_DEFAULTS.REDFOX_API_URL,
            key: secretView(SECRET_REFS.redfox, credentialStore, env, dotEnv),
            source: settingSource(apiValues.redfox?.base_url, 'REDFOX_API_URL')
          }
        },
        llm: {
          provider: llmValues.provider || resolved.LLM_PROVIDER || COLLECTOR_CONFIG_DEFAULTS.LLM_PROVIDER,
          model: llmValues.model || resolved.LLM_MODEL || COLLECTOR_CONFIG_DEFAULTS.LLM_MODEL,
          base_url: llmValues.base_url ?? resolved.LLM_BASE_URL ?? '',
          enabled: llmValues.enabled ?? String(resolved.LLM_ENABLED).toLowerCase() === 'true',
          api_key: secretView(SECRET_REFS.llm, credentialStore, env, dotEnv),
          source: settingSource(llmValues.model, 'LLM_MODEL')
        }
      }
    },
    set(input = {}) {
      const current = readSettings(target)
      const next = { apis: { ...(current.apis || {}) }, llm: { ...(current.llm || {}) } }
      if (input.apis?.wxrank) {
        next.apis.wxrank = {
          base_url: checkedUrl(input.apis.wxrank.base_url, 'WxRank API 地址'),
          search_url: checkedUrl(input.apis.wxrank.search_url, 'WxRank 搜一搜地址'),
          account_base_url: checkedUrl(input.apis.wxrank.account_base_url, 'WxRank 账号接口地址')
        }
        if (String(input.apis.wxrank.api_key || '').trim()) credentialStore.set(SECRET_REFS.wxrank, String(input.apis.wxrank.api_key).trim())
        if (String(input.apis.wxrank.authorization || '').trim()) credentialStore.set(SECRET_REFS.wxrank_authorization, String(input.apis.wxrank.authorization).trim())
        if (String(input.apis.wxrank.cookie || '').trim()) credentialStore.set(SECRET_REFS.wxrank_cookie, String(input.apis.wxrank.cookie).trim())
      }
      if (input.apis?.redfox) {
        next.apis.redfox = { base_url: checkedUrl(input.apis.redfox.base_url, 'RedFox API 地址') }
        if (String(input.apis.redfox.api_key || '').trim()) credentialStore.set(SECRET_REFS.redfox, String(input.apis.redfox.api_key).trim())
      }
      if (input.llm) {
        const provider = String(input.llm.provider || '').trim()
        const model = String(input.llm.model || '').trim()
        if (provider.length > 80 || model.length > 160) {
          const error = new Error('LLM provider 或 model 长度超出限制')
          error.status = 400
          error.code = 'INVALID_LLM_CONFIGURATION'
          throw error
        }
        next.llm = {
          provider: provider || 'openai-compatible',
          model: model || 'gpt-4o-mini',
          base_url: checkedUrl(input.llm.base_url, 'LLM Base URL', true),
          enabled: input.llm.enabled === true
        }
        if (String(input.llm.api_key || '').trim()) credentialStore.set(SECRET_REFS.llm, String(input.llm.api_key).trim())
      }
      save(next)
      return this.get()
    }
  })
}
