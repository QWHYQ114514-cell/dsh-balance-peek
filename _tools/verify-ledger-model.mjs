/**
 * Regression test for the day-total model.
 *
 * The bug this pins down: an earlier release treated the session-log replay as
 * a MONOTONIC FLOOR (`max(stored, measured)`). A single bad reading — a day that
 * started before the plugin loaded, or the old live-only counter — then poisoned
 * the ledger permanently, because nothing could ever lower it again.
 *
 * The model now: `measured` is the authoritative absolute total from replaying
 * the session logs; `live` holds only the steps seen since that replay; the
 * displayed value is their sum, and a replay RESETS `live`. A wrong historical
 * value must therefore be corrected by the next replay, not preserved.
 *
 * Usage: node _tools/verify-ledger-model.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const plugin = await import(pathToFileURL(path.join(here, '..', 'lib', 'index.js')).href)
const { measureDay, beijingDay } = plugin

/** The real Host home, captured before a scratch home replaces it. */
const realHome = process.env.DSH_HOME ?? ''
const sessionsRoot = path.join(realHome, 'sessions')
const day = beijingDay()
const truth = measureDay(sessionsRoot, day)
console.log(`day: ${day}`)
console.log(`authoritative replay of the real logs: cost=¥${truth.cost.toFixed(4)} steps=${truth.steps} tokens=${truth.tokens}`)

if (truth.steps === 0) {
  console.log('\nSKIP: no session activity today, so there is nothing to reconcile against.')
  process.exit(0)
}

const checks = []
const check = (label, pass) => checks.push([label, Boolean(pass)])

/**
 * Mount the plugin against a throwaway home, then read back its state.
 *
 * The scratch home lives INSIDE the workspace on purpose: a sandboxed run
 * cannot write to the system temp directory, and the ledger deliberately
 * swallows write failures — so a scratch home outside the sandbox would read
 * back as "nothing was written" and look like a code bug.
 */
async function mountWithLedger(seed) {
  const home = mkdtempSync(path.join(here, '..', '.tmp-ledger-test-'))
  // Mirror the plugin's own layout: <home>/dsh-balance-peek/ledger.json
  mkdirSync(path.join(home, 'dsh-balance-peek'), { recursive: true })
  writeFileSync(path.join(home, 'dsh-balance-peek', 'ledger.json'), JSON.stringify(seed), 'utf8')
  // The plugin takes its home from DSH_HOME — the same switch the real Host
  // uses — so the scratch home redirects both the ledger and the session root.
  process.env.DSH_HOME = home
  // The session logs stay where the Host wrote them; only the ledger moves.
  process.env.DSH_BALANCE_PEEK_SESSIONS = path.join(realHome, 'sessions')
  const routes = new Map()
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return () => dispose?.()
    },
    on() {
      return () => {}
    },
    get() {
      return undefined
    },
    inject(_deps, callback) {
      callback(ctx)
      return () => {}
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  plugin.default.apply(ctx)
  // One forced poll, which is also the path a user's click takes.
  const route = routes.get('/dsh-balance/state.json')
  const req = { method: 'GET', url: '/dsh-balance/state.json?refresh=1', headers: { host: '127.0.0.1:0' } }
  let body = ''
  const res = {
    headersSent: false,
    writeHead() {
      this.headersSent = true
    },
    end(text) {
      body = text ?? ''
    },
  }
  await route.handler(req, res)
  const fromRoute = JSON.parse(body)
  // The ledger flushes on a 2s debounce, so give the write a moment before
  // reading it back: the in-memory total and the durable one must agree.
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const fromDisk = JSON.parse(readFileSync(path.join(home, 'dsh-balance-peek', 'ledger.json'), 'utf8'))
  if (fromDisk.days?.[day] === undefined) {
    console.log(`  [debug] disk day keys: ${JSON.stringify(Object.keys(fromDisk.days ?? {}))}, version=${fromDisk.version}, expected day=${day}`)
  }
  rmSync(home, { recursive: true, force: true })
  return { fromRoute, row: fromDisk.days[day], version: fromDisk.version }
}

// 1. A poisoned v1 ledger (the ratchet) must be corrected downwards.
const poisoned = await mountWithLedger({
  version: 1,
  days: { [day]: { cost: truth.cost + 5, tokens: truth.tokens, steps: truth.steps + 40, topUps: 0 } },
  lastBalance: 7.26,
})
console.log(`\npoisoned seed: cost=¥${(truth.cost + 5).toFixed(4)} steps=${truth.steps + 40}`)
console.log(`after mount  : cost=¥${poisoned.fromRoute.today.cost.toFixed(4)} steps=${poisoned.fromRoute.today.steps}`)
check('migrated to ledger version 2', poisoned.version === 2)
check('inflated cost corrected down to the replay', Math.abs(poisoned.fromRoute.today.cost - truth.cost) < 0.02)
check('inflated steps corrected down to the replay', poisoned.fromRoute.today.steps >= truth.steps && poisoned.fromRoute.today.steps <= truth.steps + 2)
check('measured holds the replay', Math.abs(poisoned.row.measured.cost - truth.cost) < 0.02)
check('live is only the uncovered tail', poisoned.row.live.steps <= 2)

// 2. An understated ledger must be raised to the replay.
const understated = await mountWithLedger({
  version: 1,
  days: { [day]: { cost: 0.17, tokens: 1000, steps: 5, topUps: 0 } },
  lastBalance: 7.26,
})
console.log(`\nunderstated seed: cost=¥0.1700 steps=5 (the reported bug)`)
console.log(`after mount     : cost=¥${understated.fromRoute.today.cost.toFixed(4)} steps=${understated.fromRoute.today.steps}`)
check('understated cost raised to the replay', understated.fromRoute.today.cost >= truth.cost - 0.001)
check('understated steps raised to the replay', understated.fromRoute.today.steps >= truth.steps)

// 3. Replaying twice in a row must be idempotent, not additive.
const stable = await mountWithLedger({
  version: 2,
  days: { [day]: { measured: truth, live: { cost: 0, tokens: 0, steps: 0 }, topUps: 0 } },
  lastBalance: 7.26,
})
console.log(`\nstable seed: measured == replay`)
console.log(`after mount: cost=¥${stable.fromRoute.today.cost.toFixed(4)} steps=${stable.fromRoute.today.steps}`)
check('a correct ledger stays correct (no drift)', Math.abs(stable.fromRoute.today.cost - truth.cost) < 0.02)
check('no double-count from a second replay', stable.fromRoute.today.steps <= truth.steps + 2)

let failed = 0
console.log('')
for (const [label, pass] of checks) {
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
}
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
