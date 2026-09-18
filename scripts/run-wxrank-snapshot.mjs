import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { openDatabase } from '../src/db.mjs'
import { runPipeline } from '../src/pipeline.mjs'
import { buildSupabaseWriteSet, createSupabaseRestSink } from '../src/supabase-sink.mjs'

function argumentsMap(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    const name = item.slice(2)
    result[name] = argv[index + 1]?.startsWith('--') ? true : argv[++index]
  }
  return result
}

function readJson(filePath) {
  return JSON.parse(readFileSync(resolve(filePath), 'utf8'))
}

function listFromResponse(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.body?.data?.list)) return value.body.data.list
  if (Array.isArray(value?.data?.list)) return value.data.list
  if (Array.isArray(value?.rawJSON?.data?.list)) return value.rawJSON.data.list
  if (Array.isArray(value?.list)) return value.list
  return []
}

function rowsFromSnapshot(value, kind) {
  if (kind === 'accounts' && value && typeof value === 'object' && !Array.isArray(value)) {
    const rows = [...listFromResponse(value.rank), ...listFromResponse(value.search_default)]
    if (rows.length) return rows
  }
  return listFromResponse(value)
}

function snapshotDate(value) {
  return value?.body?.data?.stat_date || value?.data?.stat_date || value?.rawJSON?.data?.stat_date || ''
}

function snapshotFetchedAt(value) {
  return value?.fetched_at || value?.fetchedAt || new Date().toISOString()
}

const args = argumentsMap(process.argv.slice(2))
const accountPath = args['accounts-file']
const articlePath = args['articles-file']
if (!accountPath || !articlePath) throw new Error('--accounts-file and --articles-file are required')

const accountSnapshot = readJson(accountPath)
const articleSnapshot = readJson(articlePath)
const accountRows = rowsFromSnapshot(accountSnapshot, 'accounts')
const articleRows = rowsFromSnapshot(articleSnapshot, 'articles')
const now = args.now || snapshotFetchedAt(accountSnapshot)
const runDate = args.date || snapshotDate(articleSnapshot) || snapshotDate(accountSnapshot) || now
const source = args.source || 'wxrank-snapshot'
const dbPath = resolve(String(args.db || 'data/wxrank-snapshot.sqlite'))
const outputPath = args.output ? resolve(String(args.output)) : ''
const db = openDatabase(dbPath)

try {
  const report = runPipeline({ db, accountRows, articleRows, runDate, now, source })
  let supabase = null
  if (args.supabase === true) {
    const supabaseUrl = args['supabase-url'] || process.env.SUPABASE_URL
    const supabaseKey = args['supabase-key'] || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
    const writeSet = buildSupabaseWriteSet({ accountRows, articleRows, report, runDate, now, source })
    supabase = await createSupabaseRestSink({ url: supabaseUrl, key: supabaseKey }).write(writeSet)
  }
  const output = { ...report, supabase }
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  }
  console.log(JSON.stringify({
    runDate: report.runDate,
    database: dbPath,
    accountRows: accountRows.length,
    articleRows: articleRows.length,
    articles: report.articles.statusCounts,
    hotwords: report.hotwords.count,
    output: outputPath || null,
    supabase
  }, null, 2))
} finally {
  db.close()
}
