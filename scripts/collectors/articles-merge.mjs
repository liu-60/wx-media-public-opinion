import { readArtifact, runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'
import { mergeCanonicalArticles } from '../../src/collection-canonical.mjs'

async function collect(input) {
  const started = Date.now()
  const refs = Array.isArray(input.input_artifacts) ? input.input_artifacts.filter(Boolean) : []
  if (!refs.length) { const error = new Error('article merge input artifacts are missing'); error.code = 'INPUT_MISSING'; throw error }
  const rows = []
  for (const ref of refs) {
    const value = await readArtifact(input.workdir, ref)
    const part = Array.isArray(value) ? value : value.rows || value.articles || []
    if (!Array.isArray(part)) { const error = new Error(`article artifact ${ref.artifact_id} is invalid`); error.code = 'OUTPUT_SCHEMA_INVALID'; throw error }
    rows.push(...part)
  }
  const result = mergeCanonicalArticles(rows)
  const outputName = input.config.output_name || 'all-normalized-articles.json'
  const artifact = await writeArtifact(input.workdir, outputName, { rows: result.rows, generated_at: new Date().toISOString(), input_count: rows.length, duplicate_count: result.duplicate_report.duplicate_count })
  artifact.artifact_type = 'articles'; artifact.schema_version = '1'; artifact.record_count = result.rows.length
  const duplicateArtifact = await writeArtifact(input.workdir, input.config.duplicate_name || 'duplicate-report.json', result.duplicate_report)
  duplicateArtifact.artifact_type = 'debug_report'; duplicateArtifact.schema_version = '1'; duplicateArtifact.record_count = result.duplicate_report.duplicate_count
  const invalidArtifact = await writeArtifact(input.workdir, input.config.invalid_name || 'invalid-articles.json', { rows: result.invalid })
  invalidArtifact.artifact_type = 'exceptions'; invalidArtifact.schema_version = '1'; invalidArtifact.record_count = result.invalid.length
  const sourceArtifact = await writeArtifact(input.workdir, input.config.source_summary_name || 'source-summary.json', result.source_summary)
  sourceArtifact.artifact_type = 'debug_report'; sourceArtifact.schema_version = '1'; sourceArtifact.record_count = Object.keys(result.source_summary).length
  return { status: result.invalid.length ? 'partial' : 'success', input_count: rows.length, output_count: result.rows.length, created_count: null, updated_count: null, filtered_count: result.duplicate_report.duplicate_count + result.invalid.length, request_count: 0, duration_ms: Date.now() - started, artifact, debug_artifacts: [duplicateArtifact, invalidArtifact, sourceArtifact].map(item => ({ ...item, kind: 'debug', default_visible: false })), error_code: result.invalid.length ? 'NORMALIZE_FAILED' : undefined, message: `merged ${result.rows.length} canonical article(s)`, business_summary: { input_count: rows.length, normalized: result.rows.length, duplicate_count: result.duplicate_report.duplicate_count, invalid_count: result.invalid.length, source_summary: result.source_summary } }
}

if (import.meta.main) runCollectorMain(collect)

export { collect }
