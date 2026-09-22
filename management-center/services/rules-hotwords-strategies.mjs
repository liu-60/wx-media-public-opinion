import {
  buildRuleGroupDiff,
  createRulesService,
  FIELD_DICTIONARY,
  RULE_COLUMNS,
  RULE_FIELDS,
  RULE_GROUPS,
  RULE_FIELD_DICTIONARY
} from './rules.mjs'
import {
  canonicalHotwordMerge,
  createHotwordsStrategiesService,
  HOTWORD_FIELDS,
  STRATEGY_FIELDS,
  STRATEGY_REQUEST_TYPES,
  WX_TYPE_TARGETS,
  mergeHotwordRow
} from './hotwords-strategies.mjs'

export function createRulesHotwordsStrategiesService({ client, now } = {}) {
  return Object.freeze({
    ...createRulesService({ client, now }),
    ...createHotwordsStrategiesService({ client, now })
  })
}

export {
  buildRuleGroupDiff,
  canonicalHotwordMerge,
  FIELD_DICTIONARY,
  HOTWORD_FIELDS,
  mergeHotwordRow,
  RULE_COLUMNS,
  RULE_FIELDS,
  RULE_FIELD_DICTIONARY,
  RULE_GROUPS,
  STRATEGY_FIELDS,
  STRATEGY_REQUEST_TYPES,
  WX_TYPE_TARGETS
}
