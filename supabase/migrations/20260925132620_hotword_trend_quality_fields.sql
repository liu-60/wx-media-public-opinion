alter table public.hotwords
  add column if not exists trend_state text,
  add column if not exists trend_score numeric,
  add column if not exists consecutive_days integer,
  add column if not exists daily_growth integer,
  add column if not exists quality_valid boolean,
  add column if not exists quality_type text,
  add column if not exists quality_confidence numeric,
  add column if not exists quality_reason text,
  add column if not exists quality_checked_at timestamptz;

alter table public.hotwords
  add constraint hotwords_trend_state_check
  check (trend_state is null or trend_state in ('rising', 'stable', 'falling', 'new'));

create index if not exists hotwords_stat_date_trend_idx
  on public.hotwords (stat_date desc, trend_state, trend_score desc);
