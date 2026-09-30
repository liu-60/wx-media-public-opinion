import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { openDatabase } from '../../src/db.mjs'
import { syncAccounts } from '../../src/account-sync.mjs'
import { readCollectorInput, runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'

async function readRows(input) {
  const references = (input.input_artifacts || []).filter(reference => reference.artifact_type === 'accounts' || /accounts\.json$/iu.test(reference.artifact_id || ''))
  if (!references.length) { const error = new Error('account input artifact is missing'); error.code = 'INPUT_MISSING'; throw error }
  const rows = []
  for (const reference of references) {
    const value = JSON.parse(await readFile(path.resolve(input.workdir, reference.artifact_id), 'utf8'))
    const current = value.rows || value.accounts || value
    if (Array.isArray(current)) rows.push(...current)
  }
  const merged = new Map()
  for (const row of rows) {
    const key = String(row?.wx_biz || row?.wxBiz || '').trim()
    if (!key) { merged.set(`invalid:${merged.size}`, row); continue }
    const existing = merged.get(key)
    if (!existing) merged.set(key, row)
    else for (const [field, value] of Object.entries(row)) if ((existing[field] === null || existing[field] === undefined || existing[field] === '') && value !== null && value !== undefined && value !== '') existing[field] = value
  }
  return [...merged.values()]
}

async function collect(input) {
  const started = Date.now()
  const rows = await readRows(input)
  if (!Array.isArray(rows)) { const error = new Error('account artifact rows are invalid'); error.code = 'INVALID_DATA'; throw error }
  const db = openDatabase(path.join(input.workdir, 'accounts-update.sqlite'))
  try {
    const report = syncAccounts(db, rows, { source: 'collector', now: new Date().toISOString() })
    const finalRows = db.prepare(`SELECT a.account_id, a.wx_biz, a.wx_name, a.verify, a.description, a.read_median, a.read_max, a.status, a.source, a.created_at, a.updated_at, a.last_sync_at,
      p.wx_user, p.avatar, p.wx_type, p.region, p.tags_json, p.last_pub_time, p.stat_date, p.pub_count, p.active_days, p.read_avg, p.read_median AS profile_read_median, p.read_max AS profile_read_max, p.wci_index
      FROM accounts a LEFT JOIN account_profiles p ON p.account_id = a.account_id ORDER BY a.wx_biz`).all()
    const artifact = await writeArtifact(input.workdir, input.config.output_name || 'accounts.json', { source: 'collector', schema_version: '1', rows: finalRows, generated_at: new Date().toISOString() })
    artifact.artifact_type = 'accounts'; artifact.schema_version = '1'; artifact.record_count = finalRows.length
    return { status: 'success', input_count: rows.length, output_count: finalRows.length, created_count: report.created, updated_count: report.updated, filtered_count: report.invalidCount, request_count: 0, duration_ms: Date.now() - started, artifact, business_summary: { fetched: report.rawCount, valid: report.uniqueCount, duplicate: report.duplicateCount, invalid: report.invalidCount, created: report.created, updated: report.updated, unchanged: report.unchanged }, message: 'accounts stage completed' }
  } finally { db.close() }
}

if (import.meta.main) runCollectorMain(collect)

export { collect }
