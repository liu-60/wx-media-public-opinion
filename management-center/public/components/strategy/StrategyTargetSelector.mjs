const ROW_HEIGHT = 52
const WINDOW_BUFFER = 6

export function createRequestGeneration() {
  let current = 0
  return {
    next: () => ++current,
    current: () => current,
    isCurrent: token => token === current
  }
}

function text(value) {
  return value === null || value === undefined ? '' : String(value)
}

function tokenFor(value) {
  return encodeURIComponent(text(value))
}

function schedule(fn, wait = 300) {
  let timer = null
  const wrapped = (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => { timer = null; fn(...args) }, wait)
  }
  wrapped.cancel = () => { clearTimeout(timer); timer = null }
  return wrapped
}

function cloneTargets(value) {
  return Array.isArray(value) ? value.map(item => item && typeof item === 'object' ? structuredClone(item) : item) : []
}

export function mountStrategyTargetSelector(root, {
  label = '',
  hint = '',
  selected = [],
  staticOptions = [],
  remote = false,
  loadOnEmpty = false,
  optionLoader = null,
  optionKey = item => item?.key ?? item?.id ?? item?.name,
  targetKey = target => target?.key ?? target?.id ?? target,
  filterOptions = () => true,
  targetFromOption = item => item,
  renderOption = item => text(item?.name ?? item),
  renderChip = target => text(target?.name ?? target),
  placeholder = '搜索并选择',
  emptyText = '暂无候选项',
  searchHint = '',
  onChange = () => {},
  onOptions = () => {}
} = {}) {
  if (!root) throw new TypeError('Strategy target selector root is required')

  const state = {
    selected: cloneTargets(selected),
    options: [...staticOptions],
    filteredOptions: [...staticOptions],
    query: '',
    page: 1,
    hasNext: false,
    loading: false,
    expanded: false,
    cache: new Map(),
    inflight: new Map(),
    destroyed: false
  }
  const requestGeneration = createRequestGeneration()

  root.innerHTML = `<div class="strategy-selector">
    <div class="strategy-selector-head"><div><span class="form-label">${label}</span>${hint ? `<span class="strategy-selector-hint">${hint}</span>` : ''}</div><span class="strategy-selected-count" data-selected-count>0 个已选</span></div>
    <div class="strategy-selector-toolbar">
      <input class="strategy-search" data-selector-search type="search" placeholder="${placeholder}" autocomplete="off" aria-label="${label}搜索">
      <button class="button button-small button-ghost" type="button" data-selector-select-all>全选</button>
      <button class="button button-small button-ghost" type="button" data-selector-clear>清空</button>
    </div>
    ${searchHint ? `<div class="strategy-search-hint" data-search-hint>${searchHint}</div>` : ''}
    <div class="strategy-selected" data-selected-chips aria-live="polite"></div>
    <div class="strategy-options" data-option-list role="listbox" aria-label="${label}候选项" tabindex="0"><div class="strategy-options-spacer" data-options-spacer></div><div class="strategy-options-window" data-options-window></div></div>
    <div class="strategy-selector-status" data-selector-status></div>
  </div>`

  const searchInput = root.querySelector('[data-selector-search]')
  const selectedHost = root.querySelector('[data-selected-chips]')
  const list = root.querySelector('[data-option-list]')
  const spacer = root.querySelector('[data-options-spacer]')
  const optionWindow = root.querySelector('[data-options-window]')
  const status = root.querySelector('[data-selector-status]')
  const count = root.querySelector('[data-selected-count]')
  const searchHintNode = root.querySelector('[data-search-hint]')

  function selectedKeys() {
    return new Set(state.selected.map(target => text(targetKey(target))))
  }

  function currentOptions() {
    const available = state.options.filter(filterOptions)
    if (remote) return available
    const query = state.query.trim().toLocaleLowerCase()
    return query ? available.filter(item => text(renderOption(item)).toLocaleLowerCase().includes(query)) : available
  }

  function renderSelected() {
    const maxVisible = state.expanded ? state.selected.length : 10
    const visible = state.selected.slice(0, maxVisible)
    const hidden = Math.max(0, state.selected.length - visible.length)
    selectedHost.innerHTML = visible.length
      ? `${visible.map(target => `<span class="strategy-chip">${renderChip(target)}<button type="button" data-remove-target="${tokenFor(targetKey(target))}" aria-label="删除已选目标">×</button></span>`).join('')}${hidden ? `<button class="strategy-chip-more" data-expand-selected type="button">另外 ${hidden} 个</button>` : ''}`
      : '<span class="muted">暂未选择</span>'
    count.textContent = `${state.selected.length} 个已选`
  }

  function renderWindow() {
    state.filteredOptions = currentOptions()
    const options = state.filteredOptions
    const selected = selectedKeys()
    const viewportHeight = list.clientHeight || 220
    const start = Math.max(0, Math.floor(list.scrollTop / ROW_HEIGHT) - WINDOW_BUFFER)
    const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + WINDOW_BUFFER * 2
    const end = Math.min(options.length, start + visibleCount)
    spacer.style.height = `${Math.max(options.length, 1) * ROW_HEIGHT}px`
    optionWindow.style.transform = `translateY(${start * ROW_HEIGHT}px)`
    optionWindow.innerHTML = options.slice(start, end).map(item => {
      const key = tokenFor(optionKey(item))
      const active = selected.has(text(optionKey(item)))
      return `<button type="button" class="strategy-option ${active ? 'selected' : ''}" data-option-key="${key}" role="option" aria-selected="${active}">${renderOption(item)}<span class="strategy-option-check">${active ? '✓' : ''}</span></button>`
    }).join('') || `<div class="strategy-options-empty">${state.loading ? '加载中…' : emptyText}</div>`
    if (!state.loading && remote && state.query.trim() && !options.length) status.textContent = '没有找到匹配项'
    else status.textContent = state.loading ? '加载中…' : (state.hasNext ? '向下滚动加载更多' : '')
  }

  function render() {
    if (state.destroyed) return
    renderSelected()
    renderWindow()
  }

  function emitChange() {
    render()
    onChange(cloneTargets(state.selected))
  }

  function optionByToken(token) {
    return state.options.find(item => tokenFor(optionKey(item)) === token)
  }

  function toggleOption(item) {
    if (!item) return
    const key = text(optionKey(item))
    const index = state.selected.findIndex(target => text(targetKey(target)) === key)
    if (index >= 0) state.selected.splice(index, 1)
    else state.selected.push(targetFromOption(item))
    emitChange()
  }

  function clearSelected() {
    if (!state.selected.length) return
    state.selected = []
    emitChange()
  }

  function selectAllVisible() {
    const selected = selectedKeys()
    for (const item of state.filteredOptions) if (!selected.has(text(optionKey(item)))) state.selected.push(targetFromOption(item))
    emitChange()
  }

  async function loadPage(query, page, { append = false, generation = requestGeneration.current() } = {}) {
    if (!optionLoader || state.destroyed || !requestGeneration.isCurrent(generation)) return
    const normalizedQuery = text(query).trim()
    const key = `${normalizedQuery}\u0000${page}`
    if (state.cache.has(key)) {
      const result = state.cache.get(key)
      if (!requestGeneration.isCurrent(generation)) return
      state.options = append ? mergeOptions(state.options, result.items || []) : [...(result.items || [])]
      state.page = result.page ?? page
      state.hasNext = hasMore(result)
      onOptions(result.items || [])
      render()
      return
    }
    if (state.inflight.has(key)) return state.inflight.get(key)
    state.loading = true
    render()
    const promise = Promise.resolve(optionLoader(normalizedQuery, page)).then(result => {
      if (state.destroyed) return
      state.cache.set(key, result)
      if (!requestGeneration.isCurrent(generation)) return
      state.options = append ? mergeOptions(state.options, result.items || []) : [...(result.items || [])]
      state.page = result.page ?? page
      state.hasNext = hasMore(result)
      onOptions(result.items || [])
    }).catch(error => {
      if (!state.destroyed && requestGeneration.isCurrent(generation)) status.textContent = error?.message || '候选项加载失败'
    }).finally(() => {
      if (!state.destroyed && requestGeneration.isCurrent(generation)) {
        state.loading = false
        render()
      }
    })
    state.inflight.set(key, promise)
    try { await promise } finally { state.inflight.delete(key) }
  }

  function mergeOptions(current, next) {
    const seen = new Set(current.map(item => text(optionKey(item))))
    return [...current, ...next.filter(item => !seen.has(text(optionKey(item))))]
  }

  function hasMore(result) {
    const pageSize = Number(result?.pageSize) || 50
    return Number.isFinite(Number(result?.total)) ? Number(result.total) > Number(result.page || 1) * pageSize : (result?.items?.length || 0) >= pageSize
  }

  const search = schedule(async () => {
    const generation = requestGeneration.next()
    state.query = searchInput.value.trim()
    state.page = 1
    state.hasNext = false
    state.options = remote ? [] : [...staticOptions]
    if (remote && (state.query || loadOnEmpty)) await loadPage(state.query, 1, { generation })
    else render()
  }, 300)

  searchInput.addEventListener('input', search)
  root.querySelector('[data-selector-select-all]').addEventListener('click', selectAllVisible)
  root.querySelector('[data-selector-clear]').addEventListener('click', clearSelected)
  selectedHost.addEventListener('click', event => {
    const remove = event.target.closest('[data-remove-target]')
    if (remove) {
      const key = decodeURIComponent(remove.dataset.removeTarget)
      state.selected = state.selected.filter(target => text(targetKey(target)) !== key)
      emitChange()
      return
    }
    if (event.target.closest('[data-expand-selected]')) {
      state.expanded = true
      renderSelected()
    }
  })
  list.addEventListener('click', event => toggleOption(optionByToken(event.target.closest('[data-option-key]')?.dataset.optionKey)))
  list.addEventListener('scroll', () => {
    renderWindow()
    if (remote && state.hasNext && !state.loading && list.scrollTop + list.clientHeight >= list.scrollHeight - ROW_HEIGHT * 2) loadPage(state.query, state.page + 1, { append: true })
  })

  onOptions(state.options)
  render()
  if (remote && loadOnEmpty) loadPage('', 1)

  return {
    getValue: () => cloneTargets(state.selected),
    setValue: (value, { emit = false } = {}) => { state.selected = cloneTargets(value); render(); if (emit) onChange(cloneTargets(state.selected)) },
    addOptions: values => { state.options = mergeOptions(state.options, Array.isArray(values) ? values : []); render() },
    refresh: () => { const generation = requestGeneration.next(); state.cache.clear(); state.options = remote ? [] : [...staticOptions]; state.page = 1; state.hasNext = false; if (!remote || state.query || loadOnEmpty) return loadPage(state.query, 1, { generation }); render() },
    destroy: () => { requestGeneration.next(); state.destroyed = true; search.cancel(); root.replaceChildren() }
  }
}
