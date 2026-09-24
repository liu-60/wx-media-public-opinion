import { buildNextRequestPreviewModel, formatMetric } from '../../strategy-ui.mjs'

function avatarMarkup(target, esc, safeUrl) {
  const name = String(target?.name || '公')
  const url = safeUrl(target?.avatar)
  return url
    ? `<img class="strategy-avatar strategy-avatar-preview" src="${esc(url)}" alt="" loading="lazy">`
    : `<span class="strategy-avatar strategy-avatar-preview avatar-placeholder" aria-hidden="true">${esc(name.slice(0, 1))}</span>`
}

function targetMarkup(target, { esc, safeUrl }) {
  const activeDays = target?.activeDays === null || target?.activeDays === undefined ? '' : `<small>活跃天数 ${esc(formatMetric(target.activeDays))} 天</small>`
  return `<span class="strategy-preview-target">${avatarMarkup(target, esc, safeUrl)}<span><strong>${esc(target?.name || '未命名对象')}</strong>${activeDays}</span></span>`
}

export function mountNextRequestPreview(root, {
  getState,
  requestTypeConfig,
  requestTypeLabel,
  getRequestTypeConfig = () => requestTypeConfig,
  getRequestTypeLabel = () => requestTypeLabel || requestTypeConfig?.label,
  presentTarget,
  esc = value => String(value ?? ''),
  safeUrl = value => value
} = {}) {
  if (!root) throw new TypeError('Next request preview root is required')
  let expanded = false

  function render() {
    const state = getState()
    const config = getRequestTypeConfig() || {}
    const model = buildNextRequestPreviewModel({
      ...state,
      requestTypeLabel: getRequestTypeLabel() || config.label,
      presentTarget
    })
    const targets = expanded ? state.activeTargets.map(target => ({ raw: target, ...presentTarget(target) })) : model.visibleTargets
    const targetLabel = config.activeLabel || '下次采集目标'
    const targetUnit = config.targetUnit || '对象'
    const targetBlock = model.targetCount
      ? `<div class="strategy-preview-row strategy-preview-row-wide"><span>${esc(targetLabel)}</span><div class="strategy-preview-targets">${targets.map(target => targetMarkup(target, { esc, safeUrl })).join('')}${!expanded && model.hiddenTargetCount ? `<button type="button" class="strategy-preview-more" data-preview-expand>另外 ${model.hiddenTargetCount} 个</button>` : ''}</div><small class="strategy-preview-count">${model.targetCount} 个${esc(targetUnit)}</small></div>`
      : ''
    const dateBlock = model.date ? `<div class="strategy-preview-row"><span>采集日期</span><strong>${esc(model.date)}</strong></div>` : ''
    const monthBlock = model.month ? `<div class="strategy-preview-row"><span>采集月份</span><strong>${esc(model.month)}</strong></div>` : ''
    root.innerHTML = `<section class="strategy-preview" aria-label="下次请求预览"><div class="strategy-preview-head"><div><span class="eyebrow">请求预览</span><h3>下次请求预览</h3></div><span class="pill pill-blue">实时计算</span></div><div class="strategy-preview-grid"><div class="strategy-preview-row"><span>采集方式</span><strong>${esc(model.method)}</strong></div>${targetBlock}${dateBlock}${monthBlock}<div class="strategy-preview-row"><span>阅读范围</span><strong>${esc(model.readingRange)}</strong></div><div class="strategy-preview-row"><span>请求页数</span><strong>${esc(model.pages)}</strong></div><div class="strategy-preview-row"><span>预计请求</span><strong class="strategy-preview-emphasis">${esc(model.expectedRequestsLabel)}</strong></div><div class="strategy-preview-row"><span>当前轮次</span><strong>第 ${esc(model.cycleNo)} 轮</strong></div></div></section>`
  }

  root.addEventListener('click', event => {
    if (!event.target.closest('[data-preview-expand]')) return
    expanded = true
    render()
  })

  render()
  return { render, collapse: () => { expanded = false; render() } }
}
