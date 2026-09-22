import { mountStrategyTargetSelector } from './StrategyTargetSelector.mjs'

export function mountWxTypeMultiSelect(root, { label, hint, selected, options = [], onChange, onOptions, filterOptions } = {}) {
  const staticOptions = options.map(name => ({ key: name, name }))
  return mountStrategyTargetSelector(root, {
    label,
    hint,
    selected,
    staticOptions,
    placeholder: '搜索公众号分类',
    optionKey: item => item.key,
    targetKey: target => target,
    filterOptions,
    targetFromOption: item => item.key,
    renderOption: item => `<span class="strategy-option-main"><span class="type-option-icon">◇</span><span class="strategy-option-copy"><strong>${item.name}</strong></span></span>`,
    renderChip: target => `<span>${target}</span>`,
    onChange,
    onOptions
  })
}
