ALTER TABLE public.filter_rules
  DROP CONSTRAINT IF EXISTS filter_rules_scope_check,
  DROP CONSTRAINT IF EXISTS filter_rules_field_scope_check,
  DROP CONSTRAINT IF EXISTS filter_rules_operator_check,
  DROP CONSTRAINT IF EXISTS filter_rules_value_check;

ALTER TABLE public.filter_rules
  ADD CONSTRAINT filter_rules_scope_check
    CHECK (scope IN ('account', 'article', 'hotword')),
  ADD CONSTRAINT filter_rules_field_scope_check
    CHECK (
      (scope = 'account' AND field_name IN ('name', 'verification', 'description', 'read_median'))
      OR (scope = 'article' AND field_name IN ('title', 'read_count', 'like_count', 'comment_count'))
      OR (scope = 'hotword' AND field_name = 'hotword')
    ),
  ADD CONSTRAINT filter_rules_operator_check
    CHECK (
      (scope = 'hotword' AND operator IN ('exact', 'contains'))
      OR (scope IN ('account', 'article') AND operator IN ('contains', 'not_contains', 'eq', 'gt', 'gte', 'lt', 'lte'))
    ),
  ADD CONSTRAINT filter_rules_value_check
    CHECK (
      (operator IN ('contains', 'not_contains') AND value_text IS NOT NULL AND value_number IS NULL)
      OR (operator IN ('gt', 'gte', 'lt', 'lte') AND value_text IS NULL AND value_number IS NOT NULL)
      OR (operator = 'eq' AND ((value_text IS NOT NULL AND value_number IS NULL) OR (value_text IS NULL AND value_number IS NOT NULL)))
      OR (operator = 'exact' AND value_text IS NOT NULL AND value_number IS NULL)
    );

INSERT INTO public.filter_rules(scope, field_name, operator, value_text, value_number, enabled, remark)
SELECT 'hotword', 'hotword', 'exact', seed.value_text, NULL, TRUE, '热词最终结果精确过滤（初始化）'
FROM (VALUES ('中国'), ('书记')) AS seed(value_text)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.filter_rules existing
  WHERE existing.scope = 'hotword'
    AND existing.field_name = 'hotword'
    AND existing.operator = 'exact'
    AND existing.value_text = seed.value_text
);
