import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULTS = Object.freeze({
  WXRANK_API_URL: 'https://data.wxrank.com/weixin/artlist',
  WXRANK_SEARCH_API_URL: 'https://data.wxrank.com/weixin/getso',
  WXRANK_ACCOUNT_API_URL: 'https://wxrank.com',
  REDFOX_API_URL: 'https://redfox.hk',
  LLM_PROVIDER: 'openai-compatible',
  LLM_MODEL: 'gpt-4o-mini',
  LLM_BASE_URL: '',
  LLM_ENABLED: 'false'
})

function unquote(value) {
  const text = String(value || '').trim()
  if (text.length >= 2 && ((text[0] === '"' && text.at(-1) === '"') || (text[0] === "'" && text.at(-1) === "'"))) return text.slice(1, -1)
  return text.replace(/\s+#.*$/u, '').trim()
}

export function readDotEnv(filePath = path.resolve('.env')) {
  if (!existsSync(filePath)) return {}
  const output = {}
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line)
    if (match) output[match[1]] = unquote(match[2])
  }
  return output
}

function savedSettings(filePath = path.resolve('data', 'collector-configuration.json')) {
  if (!existsSync(filePath)) return {}
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

function savedCredentials(filePath = path.resolve('data', 'collector-credentials.json')) {
  if (!existsSync(filePath)) return {}
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

export function loadCollectorEnvironment({ env = process.env, settingsPath, credentialsPath, dotenvPath } = {}) {
  const settings = savedSettings(settingsPath || env.COLLECTOR_CONFIGURATION_FILE || path.resolve('data', 'collector-configuration.json'))
  const dotenv = readDotEnv(dotenvPath || env.COLLECTOR_DOTENV_FILE || path.resolve('.env'))
  const credentials = savedCredentials(credentialsPath || env.COLLECTOR_CREDENTIALS_FILE || path.resolve('data', 'collector-credentials.json'))
  const overrides = {}
  const api = settings.apis || {}
  const llm = settings.llm || {}
  if (api.wxrank?.base_url) overrides.WXRANK_API_URL = api.wxrank.base_url
  if (api.wxrank?.search_url) overrides.WXRANK_SEARCH_API_URL = api.wxrank.search_url
  if (api.wxrank?.account_base_url) overrides.WXRANK_ACCOUNT_API_URL = api.wxrank.account_base_url
  if (api.redfox?.base_url) overrides.REDFOX_API_URL = api.redfox.base_url
  if (llm.provider) overrides.LLM_PROVIDER = llm.provider
  if (llm.model) overrides.LLM_MODEL = llm.model
  if (llm.base_url !== undefined) overrides.LLM_BASE_URL = llm.base_url
  if (llm.enabled !== undefined) overrides.LLM_ENABLED = String(Boolean(llm.enabled))
  const output = {
    ...DEFAULTS,
    ...dotenv,
    ...(env || {}),
    ...credentials,
    ...overrides
  }
  const explicitLlmEnabled = llm.enabled !== undefined || dotenv.LLM_ENABLED !== undefined || env?.LLM_ENABLED !== undefined || credentials.LLM_ENABLED !== undefined
  if (!explicitLlmEnabled) {
    const apiKey = output.LLM_API_KEY || output.OPENAI_API_KEY || output.AI_GATEWAY_API_KEY
    const baseUrl = output.LLM_BASE_URL || output.OPENAI_BASE_URL
    output.LLM_ENABLED = String(Boolean(apiKey && baseUrl))
  }
  return output
}

export { DEFAULTS as COLLECTOR_CONFIG_DEFAULTS }
