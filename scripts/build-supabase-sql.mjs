import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildSupabaseWriteSet } from '../src/supabase-sink.mjs'

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

function jsonFile(filePath) {
  return JSON.parse(readFileSync(resolve(filePath), 'utf8'))
}

function listFromResponse(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.body?.data?.list)) return value.body.data.list
  if (Array.isArray(value?.data?.list)) return value.data.list
  if (Array.isArray(value?.rawJSON?.data?.list)) return value.rawJSON.data.list
  return []
}

function rowsFromSnapshot(value, kind) {
  if (kind === 'accounts' && value && typeof value === 'object' && !Array.isArray(value)) {
    const rows = [...listFromResponse(value.rank), ...listFromResponse(value.search_default)]
    if (rows.length) return rows
  }
  return listFromResponse(value)
}

function sqlString(value) {
  if (value === undefined || value === null) return 'NULL'
  return `'${String(value).replaceAll("'", "''")}'`
}

function jsonb(value) {
  return `${sqlString(JSON.stringify(value))}::jsonb`
}

function accountSql(writeSet) {
  const accountRows = writeSet.accounts.map(item => item.account)
  const profileRows = writeSet.accounts.map(item => item.profile)
  const accountInput = `SELECT * FROM jsonb_to_recordset(${jsonb(accountRows)}) AS x(
    wx_biz text, wx_name text, verify text, description text,
    read_median integer, read_max integer, updated_at timestamptz
  )`
  const profileInput = `SELECT * FROM jsonb_to_recordset(${jsonb(profileRows)}) AS x(
    wx_biz text, wx_user text, avatar text, wx_type text, region text, tags jsonb,
    last_pub_time timestamptz, pub_count integer, active_days smallint,
    read_avg integer, read_median integer, read_max integer, burst_count integer,
    burst_rate numeric, look_avg integer, look_median integer, look_max integer,
    like_avg integer, like_median integer, like_max integer, share_avg integer,
    share_median integer, share_max integer, comment_avg integer, comment_median integer,
    comment_max integer, ori_count integer, collected_at timestamptz
  )`
  return `BEGIN;
WITH input AS (${accountInput})
INSERT INTO public.accounts(wx_biz, wx_name, verify, description, read_median, read_max, updated_at)
SELECT wx_biz, wx_name, verify, description, read_median, read_max, updated_at
FROM input
ON CONFLICT(wx_biz) DO UPDATE SET
  wx_name = COALESCE(EXCLUDED.wx_name, public.accounts.wx_name),
  verify = COALESCE(EXCLUDED.verify, public.accounts.verify),
  description = COALESCE(EXCLUDED.description, public.accounts.description),
  read_median = COALESCE(EXCLUDED.read_median, public.accounts.read_median),
  read_max = COALESCE(EXCLUDED.read_max, public.accounts.read_max),
  updated_at = COALESCE(EXCLUDED.updated_at, public.accounts.updated_at);

WITH input AS (${profileInput})
INSERT INTO public.account_profiles(
  account_id, wx_user, avatar, wx_type, region, tags, last_pub_time, pub_count, active_days,
  read_avg, read_median, read_max, burst_count, burst_rate, look_avg, look_median, look_max,
  like_avg, like_median, like_max, share_avg, share_median, share_max,
  comment_avg, comment_median, comment_max, ori_count, collected_at
)
SELECT a.account_id, i.wx_user, i.avatar, i.wx_type, i.region, i.tags, i.last_pub_time,
  i.pub_count, i.active_days, i.read_avg, i.read_median, i.read_max, i.burst_count,
  i.burst_rate, i.look_avg, i.look_median, i.look_max, i.like_avg, i.like_median, i.like_max,
  i.share_avg, i.share_median, i.share_max, i.comment_avg, i.comment_median, i.comment_max,
  i.ori_count, i.collected_at
FROM input i
JOIN public.accounts a ON a.wx_biz = i.wx_biz
ON CONFLICT(account_id) DO UPDATE SET
  wx_user = COALESCE(EXCLUDED.wx_user, public.account_profiles.wx_user),
  avatar = COALESCE(EXCLUDED.avatar, public.account_profiles.avatar),
  wx_type = COALESCE(EXCLUDED.wx_type, public.account_profiles.wx_type),
  region = COALESCE(EXCLUDED.region, public.account_profiles.region),
  tags = COALESCE(EXCLUDED.tags, public.account_profiles.tags),
  last_pub_time = COALESCE(EXCLUDED.last_pub_time, public.account_profiles.last_pub_time),
  pub_count = COALESCE(EXCLUDED.pub_count, public.account_profiles.pub_count),
  active_days = COALESCE(EXCLUDED.active_days, public.account_profiles.active_days),
  read_avg = COALESCE(EXCLUDED.read_avg, public.account_profiles.read_avg),
  read_median = COALESCE(EXCLUDED.read_median, public.account_profiles.read_median),
  read_max = COALESCE(EXCLUDED.read_max, public.account_profiles.read_max),
  burst_count = COALESCE(EXCLUDED.burst_count, public.account_profiles.burst_count),
  burst_rate = COALESCE(EXCLUDED.burst_rate, public.account_profiles.burst_rate),
  look_avg = COALESCE(EXCLUDED.look_avg, public.account_profiles.look_avg),
  look_median = COALESCE(EXCLUDED.look_median, public.account_profiles.look_median),
  look_max = COALESCE(EXCLUDED.look_max, public.account_profiles.look_max),
  like_avg = COALESCE(EXCLUDED.like_avg, public.account_profiles.like_avg),
  like_median = COALESCE(EXCLUDED.like_median, public.account_profiles.like_median),
  like_max = COALESCE(EXCLUDED.like_max, public.account_profiles.like_max),
  share_avg = COALESCE(EXCLUDED.share_avg, public.account_profiles.share_avg),
  share_median = COALESCE(EXCLUDED.share_median, public.account_profiles.share_median),
  share_max = COALESCE(EXCLUDED.share_max, public.account_profiles.share_max),
  comment_avg = COALESCE(EXCLUDED.comment_avg, public.account_profiles.comment_avg),
  comment_median = COALESCE(EXCLUDED.comment_median, public.account_profiles.comment_median),
  comment_max = COALESCE(EXCLUDED.comment_max, public.account_profiles.comment_max),
  ori_count = COALESCE(EXCLUDED.ori_count, public.account_profiles.ori_count),
  collected_at = EXCLUDED.collected_at;
COMMIT;
SELECT count(*)::bigint AS account_rows_written
FROM public.accounts a
WHERE a.wx_biz IN (SELECT wx_biz FROM jsonb_to_recordset(${jsonb(accountRows)}) AS x(wx_biz text));`
}

function articleSql(writeSet) {
  const rows = writeSet.articles
  const input = `SELECT * FROM jsonb_to_recordset(${jsonb(rows)}) AS x(
    wx_biz text, article_sn text, idx smallint, title text, article_url text,
    published_at timestamptz, read_num integer, read_num_capped boolean,
    like_num integer, look_num integer, share_num integer, comment_num integer,
    is_original boolean, source_code smallint
  )`
  return `BEGIN;
WITH input AS (${input})
INSERT INTO public.articles(
  account_id, article_sn, idx, title, article_url, published_at, read_num, read_num_capped,
  like_num, look_num, share_num, comment_num, is_original, source_code
)
SELECT a.account_id, i.article_sn, i.idx, i.title, i.article_url, i.published_at, i.read_num,
  i.read_num_capped, i.like_num, i.look_num, i.share_num, i.comment_num, i.is_original, i.source_code
FROM input i
JOIN public.accounts a ON a.wx_biz = i.wx_biz
ON CONFLICT(account_id, article_sn) DO UPDATE SET
  idx = EXCLUDED.idx,
  title = EXCLUDED.title,
  article_url = EXCLUDED.article_url,
  published_at = EXCLUDED.published_at,
  read_num = EXCLUDED.read_num,
  read_num_capped = EXCLUDED.read_num_capped,
  like_num = EXCLUDED.like_num,
  look_num = EXCLUDED.look_num,
  share_num = EXCLUDED.share_num,
  comment_num = EXCLUDED.comment_num,
  is_original = EXCLUDED.is_original,
  source_code = EXCLUDED.source_code,
  updated_at = now();
COMMIT;
SELECT count(*)::bigint AS article_rows_written
FROM public.articles a
JOIN public.accounts ac ON ac.account_id = a.account_id
WHERE a.article_sn IN (SELECT article_sn FROM jsonb_to_recordset(${jsonb(rows)}) AS x(article_sn text));`
}

function hotwordSql(writeSet) {
  const input = `SELECT * FROM jsonb_to_recordset(${jsonb(writeSet.hotwords)}) AS x(
    hotword text, aliases jsonb, stat_date date, article_count smallint,
    article_keys jsonb, article_url text
  )`
  return `BEGIN;
WITH input AS (${input})
INSERT INTO public.hotwords(hotword, aliases, stat_date, article_count, article_keys, article_url)
SELECT i.hotword,
  COALESCE((SELECT array_agg(value) FROM jsonb_array_elements_text(i.aliases)), '{}'::text[]),
  i.stat_date, i.article_count,
  COALESCE((SELECT array_agg(value) FROM jsonb_array_elements_text(i.article_keys)), '{}'::text[]),
  i.article_url
FROM input i
WHERE i.article_count >= 2
ON CONFLICT(hotword, stat_date) DO UPDATE SET
  aliases = EXCLUDED.aliases,
  article_count = EXCLUDED.article_count,
  article_keys = EXCLUDED.article_keys,
  article_url = EXCLUDED.article_url;
COMMIT;
SELECT count(*)::bigint AS hotword_rows_written
FROM public.hotwords
WHERE stat_date = ${sqlString(writeSet.metadata.runDate)}::date;`
}

function jobSql(writeSet) {
  const job = writeSet.job
  const steps = writeSet.steps
  const stepInput = `SELECT * FROM jsonb_to_recordset(${jsonb(steps)}) AS x(
    step_name text, step_order smallint, status text, cursor jsonb,
    processed_count integer, success_count integer, fail_count integer, error text,
    started_at timestamptz, finished_at timestamptz, created_at timestamptz, updated_at timestamptz
  )`
  return `BEGIN;
WITH inserted AS (
  INSERT INTO public.jobs(job_type, status, current_step, params, success_count, fail_count, started_at, finished_at, created_at, updated_at)
  VALUES(${sqlString(job.job_type)}, ${sqlString(job.status)}, ${sqlString(job.current_step)}, ${jsonb(job.params)}, ${job.success_count}, ${job.fail_count}, ${sqlString(job.started_at)}, ${sqlString(job.finished_at)}, ${sqlString(job.created_at)}, ${sqlString(job.updated_at)})
  RETURNING id
), input AS (${stepInput})
INSERT INTO public.job_steps(job_id, step_name, step_order, status, cursor, processed_count, success_count, fail_count, error, started_at, finished_at, created_at, updated_at)
SELECT inserted.id, i.step_name, i.step_order, i.status, i.cursor, i.processed_count, i.success_count, i.fail_count, i.error, i.started_at, i.finished_at, i.created_at, i.updated_at
FROM inserted CROSS JOIN input i;
COMMIT;
SELECT id, job_type, status, current_step, success_count, fail_count, created_at
FROM public.jobs
ORDER BY id DESC LIMIT 1;`
}

const args = argumentsMap(process.argv.slice(2))
const part = args.part
if (!['accounts', 'articles', 'hotwords', 'job'].includes(part)) throw new Error('--part must be accounts, articles, hotwords, or job')
const accountSnapshot = jsonFile(args['accounts-file'])
const articleSnapshot = jsonFile(args['articles-file'])
const report = jsonFile(args.report)
const accountRows = rowsFromSnapshot(accountSnapshot, 'accounts')
const articleRows = rowsFromSnapshot(articleSnapshot, 'articles')
const writeSet = buildSupabaseWriteSet({
  accountRows,
  articleRows,
  report,
  runDate: report.runDate,
  now: args.now || accountSnapshot.fetched_at || new Date().toISOString(),
  source: args.source || 'wxrank-snapshot'
})

const sql = part === 'accounts'
  ? accountSql(writeSet)
  : part === 'articles'
    ? articleSql(writeSet)
    : part === 'hotwords'
      ? hotwordSql(writeSet)
      : jobSql(writeSet)
process.stdout.write(sql)
