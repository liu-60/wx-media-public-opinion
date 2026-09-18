-- 文章采集发现全新 wx_biz 后，在同一事务中执行。
-- 只有确认 accounts 是本次刚插入的账号时才执行此段；已有账号不要因文章采集刷新 collected_at。
INSERT INTO public.account_profiles (
  account_id,
  wx_type,
  region,
  read_median,
  read_max,
  collected_at
)
VALUES (
  :account_id,
  :wx_type,
  :region,
  :read_median,
  :read_max,
  now()
)
ON CONFLICT (account_id) DO UPDATE SET
  wx_type = COALESCE(EXCLUDED.wx_type, account_profiles.wx_type),
  region = COALESCE(EXCLUDED.region, account_profiles.region),
  read_median = COALESCE(EXCLUDED.read_median, account_profiles.read_median),
  read_max = COALESCE(EXCLUDED.read_max, account_profiles.read_max),
  collected_at = now();
