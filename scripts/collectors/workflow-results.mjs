import { readArtifact, runCollectorMain, writeArtifact } from '../../src/runner/script-runtime.mjs'

function actionRows(created = [], updated = [], deleted = []) {
  return [
    ...created.map(row => ({ ...row, change_type: 'created' })),
    ...updated.map(row => ({ ...row, change_type: 'updated' })),
    ...deleted.map(row => ({ ...row, change_type: 'deleted' }))
  ]
}

function envelope({ rows, created, updated, deleted = 0, runId }) {
  return {
    schema_version: 'workflow-change-result-v1',
    run_id: runId || null,
    generated_at: new Date().toISOString(),
    counts: {
      created,
      updated,
      deleted,
      total: rows.length,
      unchanged: 0
    },
    rows
  }
}

async function collect(input) {
  const started = Date.now()
  const reference = input.input_artifacts?.find(item => item.artifact_type === 'write_set')
  if (!reference) { const error = new Error('workflow change result requires a frozen write set'); error.code = 'INPUT_MISSING'; throw error }
  const frozen = await readArtifact(input.workdir, reference)
  const accounts = actionRows(frozen.accounts_create || [], frozen.accounts_update || [])
  const articles = actionRows(frozen.articles_create || [], frozen.articles_update || [])
  const changes = frozen.hotword_changes || {}
  const hotwords = actionRows(changes.created || [], changes.updated || [], changes.deleted || [])
  const generatedAt = new Date().toISOString()
  const accountValue = envelope({ rows: accounts, created: (frozen.accounts_create || []).length, updated: (frozen.accounts_update || []).length, runId: input.run_id })
  const articleValue = envelope({ rows: articles, created: (frozen.articles_create || []).length, updated: (frozen.articles_update || []).length, runId: input.run_id })
  const hotwordValue = envelope({ rows: hotwords, created: (changes.created || []).length, updated: (changes.updated || []).length, deleted: (changes.deleted || []).length, runId: input.run_id })
  for (const value of [accountValue, articleValue, hotwordValue]) value.generated_at = generatedAt
  const accountsArtifact = await writeArtifact(input.workdir, 'accounts.json', accountValue)
  accountsArtifact.artifact_type = 'accounts'; accountsArtifact.schema_version = '1'; accountsArtifact.record_count = accounts.length; accountsArtifact.change_counts = accountValue.counts
  const articlesArtifact = await writeArtifact(input.workdir, 'articles.json', articleValue)
  articlesArtifact.artifact_type = 'articles'; articlesArtifact.schema_version = '1'; articlesArtifact.record_count = articles.length; articlesArtifact.change_counts = articleValue.counts
  const hotwordsArtifact = await writeArtifact(input.workdir, 'hotwords.json', hotwordValue)
  hotwordsArtifact.artifact_type = 'hotwords'; hotwordsArtifact.schema_version = '1'; hotwordsArtifact.record_count = hotwords.length; hotwordsArtifact.change_counts = hotwordValue.counts
  const totalCreated = accountValue.counts.created + articleValue.counts.created + hotwordValue.counts.created
  const totalUpdated = accountValue.counts.updated + articleValue.counts.updated + hotwordValue.counts.updated
  return {
    status: 'success', input_count: (frozen.accounts?.length || 0) + (frozen.articles?.length || 0) + ((changes.created || []).length + (changes.updated || []).length),
    output_count: accounts.length + articles.length + hotwords.length,
    created_count: totalCreated, updated_count: totalUpdated, filtered_count: 0, request_count: 0,
    duration_ms: Date.now() - started,
    artifact: [accountsArtifact, articlesArtifact, hotwordsArtifact],
    message: '工作流新增、更新与删除结果已汇总为三类业务 JSON',
    business_summary: {
      accounts: accountValue.counts,
      articles: articleValue.counts,
      hotwords: hotwordValue.counts,
      total: { created: totalCreated, updated: totalUpdated, changed: totalCreated + totalUpdated + hotwordValue.counts.deleted, records: accounts.length + articles.length + hotwords.length }
    }
  }
}

if (import.meta.main) runCollectorMain(collect)

export { collect }
