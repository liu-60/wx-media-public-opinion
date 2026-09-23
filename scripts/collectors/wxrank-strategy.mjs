import { createWxRankStrategyRequest } from '../../src/collector-adapters/wxrank-strategy.mjs'
import { runCollectorMain } from '../../src/runner/script-runtime.mjs'

async function collect() {
  createWxRankStrategyRequest()
}

if (import.meta.main) runCollectorMain(collect)

export { collect }
