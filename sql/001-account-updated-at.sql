BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE public.accounts AS account
SET updated_at = COALESCE(profile.collected_at, now())
FROM public.account_profiles AS profile
WHERE profile.account_id = account.account_id
  AND account.updated_at IS NULL;

UPDATE public.accounts
SET updated_at = now()
WHERE updated_at IS NULL;

ALTER TABLE public.accounts
  ALTER COLUMN updated_at SET DEFAULT now();

ALTER TABLE public.accounts
  ALTER COLUMN updated_at SET NOT NULL;

COMMENT ON COLUMN public.accounts.updated_at IS
  '账号身份或同步状态最近一次更新的时间；历史数据优先回填 account_profiles.collected_at';

COMMIT;
