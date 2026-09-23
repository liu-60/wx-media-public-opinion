export function argumentsMap(argv = []) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!String(item).startsWith('--')) continue
    const name = String(item).slice(2)
    const next = argv[index + 1]
    result[name] = !next || String(next).startsWith('--') ? true : next
  }
  return result
}

export function jsonArgument(value, fallback = {}) {
  if (value === undefined || value === true || value === '') return fallback
  return JSON.parse(String(value))
}
