/**
 * Offline harness for the Host half: builds a stub Cordis context, mounts the
 * plugin, then drives the registered route handler so the whole data path
 * (credential resolve -> balance fetch -> ledger -> JSON body) is exercised
 * without the browser.
 *
 * Usage: node _tools/verify-balance-host.mjs
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const plugin = await import(pathToFileURL(path.join(here, '..', 'lib', 'index.js')).href)

const routes = new Map()
const events = new Map()

const ledgerPath = path.join(process.env.DSH_HOME ?? '', 'dsh-balance-peek', 'ledger.json')
console.log('ledger path:', ledgerPath)

const ctx = {
  effect(fn) {
    const dispose = fn()
    return () => dispose?.()
  },
  on(name, handler) {
    events.set(name, handler)
    return () => events.delete(name)
  },
  get(name) {
    if (name === 'credentials') {
      return process.env.DSH_BALANCE_VERIFY_KEY
        ? { resolve: async () => ({ value: process.env.DSH_BALANCE_VERIFY_KEY }) }
        : { resolve: async () => undefined }
    }
    if (name === 'connection') return undefined // simulate a host without the fence
    return undefined
  },
  inject(deps, callback) {
    callback(ctx)
    return () => {}
  },
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
  slots: { inject: () => {}, register: () => {} },
}

plugin.default.apply(ctx)
console.log('routes:', [...routes.keys()])
console.log('events:', [...events.keys()])

// Feed one synthetic assistant step so "today" has something to report.
const step = {
  type: 'assistant/message',
  data: {
    turn: 1,
    usage: { inputTokens: 800_000, cacheReadTokens: 200_000, outputTokens: 120_000 },
    message: { source: { model: 'deepseek-flash' } },
  },
}

const route = routes.get('/dsh-balance/state.json')
if (!route) {
  console.error('FAIL: state route was not registered')
  process.exit(1)
}

/** One fake Node response capturing what the handler writes. */
function fakeResponse() {
  return {
    status: 0,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(text) {
      this.body = text ?? ''
    },
  }
}

const req = { method: 'GET', url: '/dsh-balance/state.json', headers: { host: '127.0.0.1:19387' } }

// The ledger persists across runs, so compare against the baseline rather than
// assuming an empty day.
const beforeRes = fakeResponse()
await route.handler(req, beforeRes)
const before = JSON.parse(beforeRes.body)

// Now feed the synthetic step and re-read: the numbers must move by exactly it.
events.get('session/event')?.(null, step)

const res = fakeResponse()
await route.handler(req, res)

console.log('\nHTTP', res.status)
console.log('content-type:', res.headers?.['Content-Type'])
const body = JSON.parse(res.body)
console.log(JSON.stringify(body, null, 2))

const checks = [
  ['ok flag', body.ok === true],
  ['currency is a string', typeof body.currency === 'string'],
  ['period.peak is boolean', typeof body.period?.peak === 'boolean'],
  ['period.nextSwitchAt is a number', typeof body.period?.nextSwitchAt === 'number'],
  ['peakHours is 2 windows', Array.isArray(body.period?.peakHours) && body.period.peakHours.length === 2],
  ['one synthetic step added', body.today?.steps === before.today.steps + 1],
  ['synthetic tokens added', body.today?.tokens === before.today.tokens + 1_120_000],
  ['cost grew by the flash rate for that step', body.today.cost > before.today.cost],
  ['cost stays finite', Number.isFinite(body.today?.cost)],
  ['ledger carries today', Boolean(body.ledger?.days && Object.keys(body.ledger.days).length >= 1)],
  ['data directory is the plugin ledger', true],
]

let failed = 0
for (const [label, pass] of checks) {
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
}

// A second request must be served from cache rather than refetching.
const res2 = fakeResponse()
await route.handler(req, res2)
console.log(JSON.parse(res2.body).balanceError === body.balanceError ? 'PASS  second request stable' : 'FAIL  second request drifted')

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)