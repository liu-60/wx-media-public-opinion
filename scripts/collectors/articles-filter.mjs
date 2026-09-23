import path from 'node:path'
import { openDatabase } from '../../src/db.mjs'
import { runPipeline } from '../../src/pipeline.mjs'
import { buildSupabaseWriteSet } from '../../src/supabase-sink.mjs'
import { readArtifact, runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'

async function readJson(input, index) {
  const reference = input.input_artifacts[index]
  if (!reference) { const error = new Error(`article input artifact ${index} is missing`); error.code = 'INPUT_MISSING'; throw error }
  return readArtifact(input.workdir, reference)
}

async function collect(input) {
  const started = Date.now()
  const accountValue = await readJson(input, 0)
  const articleValue = await readJson(input, 1)
  const accountRows = accountValue.rows || accountValue.accounts || accountValue
  const articleRows = articleValue.rows || articleValue.articles || articleValue
  if (!Array.isArray(accountRows) || !Array.isArray(articleRows)) { const error = new Error('filter input artifacts are invalid'); error.code = 'INVALID_DATA'; throw error }
  const strategy = input.strategy_snapshot_ref ? await readArtifact(input.workdir, input.strategy_snapshot_ref) : {}
  const ruleSnapshot = input.rule_snapshot_ref ? await readArtifact(input.workdir, input.rule_snapshot_ref) : undefined
  const accountsByBiz = new Map(accountRows.filter(row => row?.wx_biz).map(row => [row.wx_biz, row]))
  for (const row of strategy.approved_accounts || []) if (row?.wx_biz && !accountsByBiz.has(row.wx_biz)) accountsByBiz.set(row.wx_biz, row)
  const decisions = Object.fromEntries((strategy.account_decisions || strategy.approved_accounts || []).filter(row => row?.wx_biz).map(row => [row.wx_biz, { decision_status: row.decision_status ?? 1 }]))
  const effectiveAccounts = [...accountsByBiz.values()].map(row => ({ ...row, decision_status: decisions[row.wx_biz]?.decision_status ?? row.decision_status ?? 0, decision_required: true }))
  const db = openDatabase(path.join(input.workdir, 'articles-filter.sqlite'))
  try {
    const report = runPipeline({ db, accountRows: effectiveAccounts, articleRows, runDate: input.config.run_date || '', now: new Date().toISOString(), source: 'collector', ruleSnapshot, accountDecisions: decisions, persistHotwordsStage: false, includeHotwordRows: false })
    const reportArtifact = await writeArtifact(input.workdir, 'articles-filter-report.json', report)
    reportArtifact.artifact_type = 'debug_report'; reportArtifact.schema_version = '1'; reportArtifact.record_count = articleRows.length
    reportArtifact.kind = 'debug'; reportArtifact.default_visible = false
    const writeSet = buildSupabaseWriteSet({ accountRows: effectiveAccounts, articleRows, report, runDate: report.runDate, now: new Date().toISOString(), source: 'collector' })
    const filteredRows = (report.articles?.decisions || []).filter(row => row.status === 'SELECTED')
    const filteredArtifact = await writeArtifact(input.workdir, 'filtered-articles.json', { run_date: report.runDate, rows: filteredRows, generated_at: new Date().toISOString() })
    filteredArtifact.artifact_type = 'filtered_articles'; filteredArtifact.schema_version = '1'; filteredArtifact.record_count = filteredRows.length
    const writeSetArtifact = await writeArtifact(input.workdir, 'write-set.json', writeSet)
    writeSetArtifact.artifact_type = 'write_set'; writeSetArtifact.schema_version = '1'; writeSetArtifact.record_count = (writeSet.articles?.length || 0) + (writeSet.accounts?.length || 0) + (writeSet.hotwords?.length || 0)
    const selected = report.articles.statusCounts?.SELECTED || 0
    const filtered = articleRows.length - selected
    return { status: 'success', input_count: articleRows.length, output_count: selected, created_count: null, updated_count: null, filtered_count: filtered, request_count: 0, duration_ms: Date.now() - started, artifact: [filteredArtifact, writeSetArtifact], debug_artifacts: [reportArtifact], business_summary: { input_articles: articleRows.length, selected, filtered, write_set_records: writeSetArtifact.record_count }, message: 'article filter stage completed' }
  } finally { db.close() }
}

if (import.meta.main) runCollectorMain(collect)

export { collect }
