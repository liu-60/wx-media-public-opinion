import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { openDatabase } from '../src/db.mjs'
import { createRuleSnapshot } from '../src/article-filter.mjs'
import { runPipeline } from '../src/pipeline.mjs'
import { buildSupabaseWriteSet, createSupabaseRestSink } from '../src/supabase-sink.mjs'

export function argumentsMap(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    const name = item.slice(2)
    const next = argv[index + 1]
    result[name] = !next || next.startsWith('--') ? true : next
  }
  return result
}

function inputRows(input) {
  return [...(input.accountRows || input.accounts || []), ...(input.articleRows || input.articles || [])]
}

function onlineAccountKeys(input) {
  return [...new Set(inputRows(input).map(row => row?.wx_biz || row?.wxBiz || row?.__biz || row?.biz).filter(Boolean).map(String))]
}

function onlineError(resource, status = '') {
  return new Error(`online ${resource} snapshot could not be loaded${status ? ` (HTTP ${status})` : ''}`)
}

export async function loadOnlineRuleSnapshot({ url, key, fetchImpl = globalThis.fetch, loadedAt = new Date().toISOString() } = {}) {
  if (!url || !key) throw new TypeError('--rules-from-supabase requires SUPABASE_URL and a server key')
  const base = `${String(url).replace(/\/+$/u, '')}/rest/v1/filter_rules`
  const rows = []
  const pageSize = 1_000
  const maxRows = 5_000
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const query = new URLSearchParams({ select: 'id,scope,field_name,operator,value_text,value_number,enabled', order: 'id.asc', limit: String(pageSize), offset: String(offset) })
    const response = await fetchImpl(`${base}?${query}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json', Prefer: 'count=exact' }
    })
    if (!response?.ok) throw onlineError('filter_rules', response?.status)
    let page
    try { page = await response.json() } catch { throw onlineError('filter_rules') }
    if (!Array.isArray(page)) throw onlineError('filter_rules')
    rows.push(...page)
    const totalMatch = /\/(\d+)$/u.exec(response.headers?.get?.('content-range') || '')
    const total = totalMatch ? Number(totalMatch[1]) : null
    if (total !== null && total > maxRows) throw onlineError('filter_rules', 'capacity exceeded')
    if ((total !== null && rows.length >= total) || page.length < pageSize) return createRuleSnapshot(rows, { source: 'supabase', loadedAt })
  }
  if (rows.length >= maxRows) throw onlineError('filter_rules', 'capacity cannot be verified within 5000 rows')
  return createRuleSnapshot(rows, { source: 'supabase', loadedAt })
}

export async function loadOnlineAccountDecisions({ url, key, wxBizValues = [], fetchImpl = globalThis.fetch } = {}) {
  if (!wxBizValues.length) return {}
  if (!url || !key) throw new TypeError('--rules-from-supabase requires SUPABASE_URL and a server key')
  const values = wxBizValues.map(value => encodeURIComponent(value)).join(',')
  const response = await fetchImpl(`${String(url).replace(/\/+$/u, '')}/rest/v1/accounts?select=wx_biz,decision_status&wx_biz=in.(${values})`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
  })
  if (!response?.ok) throw onlineError('account decisions', response?.status)
  let rows
  try { rows = await response.json() } catch { throw onlineError('account decisions') }
  if (!Array.isArray(rows)) throw onlineError('account decisions')
  return Object.fromEntries(rows.filter(row => row?.wx_biz).map(row => [row.wx_biz, row.decision_status]))
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsMap(argv)
  const inputPath = args.input ? resolve(String(args.input)) : ''
  const dbPath = resolve(String(args.db || 'data/wx-media.sqlite'))
  const outputPath = args.output ? resolve(String(args.output)) : ''
  const input = inputPath ? JSON.parse(readFileSync(inputPath, 'utf8')) : {}
  const useOnlineRules = args['rules-from-supabase'] === true
  const supabaseUrl = args['supabase-url'] || input.supabaseUrl || process.env.SUPABASE_URL
  const supabaseKey = args['supabase-key'] || input.supabaseKey || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  const ruleSnapshot = useOnlineRules ? await loadOnlineRuleSnapshot({ url: supabaseUrl, key: supabaseKey }) : undefined
  const accountDecisions = useOnlineRules ? await loadOnlineAccountDecisions({ url: supabaseUrl, key: supabaseKey, wxBizValues: onlineAccountKeys(input) }) : undefined
  const db = openDatabase(dbPath)

  try {
    const report = runPipeline({
      db,
      accountRows: input.accountRows || input.accounts || [],
      articleRows: input.articleRows || input.articles || [],
      runDate: args.date || input.runDate || '',
      now: args.now || input.now || undefined,
      source: args.source || input.source || 'wxrank',
      ruleSnapshot,
      accountDecisions
    })
    let supabase = null
    if (args.supabase === true || input.supabase === true) {
      const writeSet = buildSupabaseWriteSet({
        accountRows: input.accountRows || input.accounts || [],
        articleRows: input.articleRows || input.articles || [],
        report,
        runDate: report.runDate,
        now: args.now || input.now || new Date().toISOString(),
        source: args.source || input.source || 'wxrank'
      })
      supabase = await createSupabaseRestSink({ url: supabaseUrl, key: supabaseKey }).write(writeSet)
    }
    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    }
    console.log(JSON.stringify({
      runDate: report.runDate,
      database: dbPath,
      output: outputPath || null,
      filterRules: report.filterRules,
      accounts: {
        rawCount: report.accounts.rawCount,
        uniqueCount: report.accounts.uniqueCount,
        duplicateCount: report.accounts.duplicateCount,
        invalidCount: report.accounts.invalidCount,
        created: report.accounts.created,
        updated: report.accounts.updated
      },
      articles: report.articles.statusCounts,
      hotwords: report.hotwords.count,
      supabase
    }, null, 2))
  } finally {
    db.close()
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'pipeline failed')
    process.exitCode = 1
  })
}
