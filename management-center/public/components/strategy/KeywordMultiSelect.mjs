import { mountStrategyTargetSelector } from './StrategyTargetSelector.mjs'

export function mountKeywordMultiSelect(root, { label, hint, selected, optionLoader, onChange, onOptions, filterOptions, esc = value => String(value ?? '') } = {}) {
  return mountStrategyTargetSelector(root, {
    label,
    hint,
    selected,
    remote: true,
    loadOnEmpty: true,
    optionLoader,
    placeholder: '搜索热词',
    optionKey: item => item?.name,
    targetKey: target => target,
    filterOptions,
    targetFromOption: item => item.name,
    renderOption: item => `<span class="strategy-option-main"><span class="keyword-option-icon">✦</span><span class="strategy-option-copy"><strong>${esc(item.name)}</strong><small>相关文章 ${esc(item.articleCount ?? '—')}</small></span></span>`,
    renderChip: target => `<span>${esc(target)}</span>`,
    onChange,
    onOptions
  })
}
