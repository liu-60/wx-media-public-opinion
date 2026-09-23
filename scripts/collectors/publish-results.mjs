import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createSupabaseRestSink } from '../../src/supabase-sink.mjs'
import { createSupabaseClient } from '../../management-center/services/supabase.mjs'
import { runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'

async function collect(input) {
  const started = Date.now()
  const reference = input.input_artifacts[0]
  if (!reference) { const error = new Error('write-set artifact is missing'); error.code = 'INPUT_MISSING'; throw error }
  const writeSet = JSON.parse(await readFile(path.resolve(input.workdir, reference.artifact_id), 'utf8'))
  const mode = input.config.publish_stage === 'preview' ? 'preview' : input.config.publish_stage === 'commit' ? 'commit' : input.publish_mode || input.config.publish_mode || 'preview'
  if (mode !== 'commit') {
    const counts = { accounts: writeSet.accounts?.length || 0, articles: writeSet.articles?.length || 0, hotwords: writeSet.hotwords?.length || 0, accounts_create: writeSet.accounts_create?.length || 0, accounts_update: writeSet.accounts_update?.length || 0, articles_create: writeSet.articles_create?.length || 0, articles_update: writeSet.articles_update?.length || 0, duplicate_skip: writeSet.preflight?.duplicate_skip || 0, exceptions: writeSet.exceptions?.length || 0 }
    const artifact = await writeArtifact(input.workdir, input.config.output_name || 'publish-result.json', { mode: 'preview', write_set: counts, frozen_preflight: writeSet.preflight || null, exceptions: writeSet.exceptions || [], generated_at: new Date().toISOString() })
    artifact.artifact_type = 'publish_result'; artifact.schema_version = '1'; artifact.record_count = writeSet.articles?.length ?? null
    return { status: writeSet.exceptions?.length ? 'failed' : 'success', input_count: writeSet.articles?.length ?? null, output_count: writeSet.articles?.length ?? null, created_count: writeSet.articles_create?.length ?? 0, updated_count: writeSet.articles_update?.length ?? 0, filtered_count: writeSet.preflight?.duplicate_skip ?? 0, request_count: 0, duration_ms: Date.now() - started, artifact, error_code: writeSet.exceptions?.length ? 'PUBLISH_CONFLICT' : undefined, message: writeSet.exceptions?.length ? 'publish preview found conflicts' : 'publish preview only; no business table was written', business_summary: counts }
  }
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) { const error = new Error('Supabase server key is required for commit'); error.code = 'AUTH_REQUIRED'; throw error }
  const client = createSupabaseClient({ url, key })
  const before = await client.summary()
  const result = await createSupabaseRestSink({ url, key }).write(writeSet)
  const after = await client.summary()
  const databaseNet = Object.fromEntries(Object.keys(after).map(table => [table, Number(after[table] ?? 0) - Number(before[table] ?? 0)]))
  const artifact = await writeArtifact(input.workdir, input.config.output_name || 'publish-result.json', { mode: 'commit', result, database_before: before, database_after: after, database_net: databaseNet, generated_at: new Date().toISOString() })
  artifact.artifact_type = 'publish_result'; artifact.schema_version = '1'; artifact.record_count = result.articleCount ?? null
  return { status: 'success', input_count: writeSet.articles?.length ?? null, output_count: result.articleCount ?? null, created_count: result.articleCount ?? 0, updated_count: result.accountCount ?? 0, filtered_count: writeSet.preflight?.duplicate_skip ?? 0, request_count: null, duration_ms: Date.now() - started, artifact, message: 'publish completed with database readback', business_summary: { sink: result, database_before: before, database_after: after, database_net: databaseNet } }
}

if (import.meta.main) runCollectorMain(collect)

export { collect }
