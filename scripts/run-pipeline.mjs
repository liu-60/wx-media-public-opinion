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

const args = argumentsMap(process.argv.slice(2))
const inputPath = args.input ? resolve(String(args.input)) : ''
const dbPath = resolve(String(args.db || 'data/wx-media.sqlite'))
const outputPath = args.output ? resolve(String(args.output)) : ''
const input = inputPath ? JSON.parse(readFileSync(inputPath, 'utf8')) : {}
const db = openDatabase(dbPath)

try {
  const report = runPipeline({
    db,
    accountRows: input.accountRows || input.accounts || [],
    articleRows: input.articleRows || input.articles || [],
    runDate: args.date || input.runDate || '',
    now: args.now || input.now || undefined,
    source: args.source || input.source || 'wxrank'
  })
  let supabase = null
  if (args.supabase === true || input.supabase === true) {
    const supabaseUrl = args['supabase-url'] || input.supabaseUrl || process.env.SUPABASE_URL
    const supabaseKey = args['supabase-key'] || input.supabaseKey || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
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
