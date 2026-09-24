import { mountStrategyTargetSelector } from './StrategyTargetSelector.mjs'

function numberText(value) {
  const number = Number(value)
  return Number.isFinite(number) ? new Intl.NumberFormat('zh-CN').format(number) : '—'
}

function accountName(value) {
  return String(value?.name ?? value?.wx_name ?? '未命名公众号')
}

function accountTargetKey(target) {
  return String(target?.account_id ?? target?.id ?? '')
}

function avatarMarkup(item, { esc, safeUrl, sizeClass = '' }) {
  const name = accountName(item)
  const url = safeUrl(item?.avatar)
  return url
    ? `<img class="strategy-avatar ${sizeClass}" src="${esc(url)}" alt="" loading="lazy">`
    : `<span class="strategy-avatar avatar-placeholder ${sizeClass}" aria-hidden="true">${esc(name.slice(0, 1) || '公')}</span>`
}

export function accountTargetFromOption(item) {
  return {
    account_id: Number(item.id),
    wx_biz: item.key,
    wx_name: item.name,
    avatar: item.avatar ?? null,
    ...(item.activeDays === null || item.activeDays === undefined ? {} : { active_days: Number(item.activeDays) }),
    ...(item.medianReading === null || item.medianReading === undefined ? {} : { read_median: Number(item.medianReading) })
  }
}

export function mountAccountMultiSelect(root, {
  label,
  hint,
  selected,
  optionLoader,
  onChange,
  onOptions,
  filterOptions,
  esc = value => String(value ?? ''),
  safeUrl = value => value
} = {}) {
  return mountStrategyTargetSelector(root, {
    label,
    hint,
    selected,
    remote: true,
    loadOnEmpty: false,
    optionLoader,
    placeholder: '搜索公众号名称',
    searchHint: '输入名称后搜索，结果按需加载',
    optionKey: item => item?.id,
    targetKey: accountTargetKey,
    filterOptions,
    targetFromOption: accountTargetFromOption,
    renderOption: item => `<span class="strategy-option-main">${avatarMarkup(item, { esc, safeUrl })}<span class="strategy-option-copy"><strong>${esc(accountName(item))}</strong><small>活跃天数 ${esc(item.activeDays === null || item.activeDays === undefined ? '—' : `${numberText(item.activeDays)} 天`)}</small></span></span>`,
    renderChip: target => `<span class="strategy-chip-main">${avatarMarkup({ name: target?.wx_name, avatar: target?.avatar }, { esc, safeUrl, sizeClass: 'strategy-avatar-small' })}<span>${esc(accountName(target))}</span></span>`,
    onChange,
    onOptions
  })
}

export function accountTargetPresentation(target, accountOptions = new Map()) {
  const option = accountOptions.get(String(target?.account_id))
  return option || {
    id: target?.account_id,
    key: target?.wx_biz,
    name: target?.wx_name || '未命名公众号',
    avatar: target?.avatar || null,
    activeDays: target?.active_days ?? null,
    medianReading: target?.read_median ?? null
  }
}
