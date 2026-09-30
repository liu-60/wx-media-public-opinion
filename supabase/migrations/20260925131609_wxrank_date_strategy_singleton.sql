create unique index if not exists collection_strategy_groups_date_singleton_idx
  on public.collection_strategy_groups (request_type)
  where request_type = 'date';
