/**
 * Offline harness for the Host half: builds a stub Cordis context, mounts the
 * plugin, then drives the registered route handler so the whole data path
 * (credential resolve -> balance fetch -> JSON body) is exercised without the
 * browser.
 *
 * The peak/off-peak rules are asserted directly as well, so a wrong window table
 * fails here rather than in someone's sidebar.
 *
 * Usage: node _tools/verify-balance-host.mjs
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const plugin = await import(pathToFileURL(path.join(here, '..', 'lib', 'index.js')).href)
const { isPeak, nextSwitchAt } = plugin

const routes = new Map()

const ctx = {
  effect(fn) {
    const dispose = fn()
    return () => dispose?.()
  },
  on() {
    return () => {}
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
console.log('routes:', [...routes.keys()])

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
const res = fakeResponse()
await route.handler(req, res)

console.log('\nHTTP', res.status)
console.log('content-type:', res.headers?.['Content-Type'])
const body = JSON.parse(res.body)
console.log(JSON.stringify(body, null, 2))

// 2026-10-09 is a Friday, right after the National Day holiday week.
const bj = (y, mo, d, hh, mm = 0) => Date.UTC(y, mo - 1, d, hh - 8, mm)

const checks = [
  ['ok flag', body.ok === true],
  ['currency is a string', typeof body.currency === 'string'],
  ['balance is a number or null', body.balance === null || typeof body.balance === 'number'],
  ['no spend fields leak into the payload', body.today === undefined && body.ledger === undefined],
  ['period.peak is boolean', typeof body.period?.peak === 'boolean'],
  ['period.nextSwitchAt is a number', typeof body.period?.nextSwitchAt === 'number'],
  ['peakHours is 2 windows', Array.isArray(body.period?.peakHours) && body.period.peakHours.length === 2],
  ['serverTime is a number', typeof body.serverTime === 'number'],

  ['peak: Fri 10:00', isPeak(bj(2026, 10, 9, 10)) === true],
  ['valley: Fri 12:00', isPeak(bj(2026, 10, 9, 12)) === false],
  ['peak: Fri 14:00', isPeak(bj(2026, 10, 9, 14)) === true],
  ['valley: Fri 18:00', isPeak(bj(2026, 10, 9, 18)) === false],
  ['valley: Sat 10:00', isPeak(bj(2026, 10, 10, 10)) === false],
  ['valley: holiday Thu 2026-10-01 10:00', isPeak(bj(2026, 10, 1, 10)) === false],
  ['peak: Thu 2026-10-08 09:00', isPeak(bj(2026, 10, 8, 9)) === true],
  [
    'next switch from Fri 20:00 is Mon 09:00',
    new Date(nextSwitchAt(bj(2026, 10, 9, 20))).toISOString() === new Date(bj(2026, 10, 12, 9)).toISOString(),
  ],
  [
    'next switch from Fri 10:30 is 12:00',
    new Date(nextSwitchAt(bj(2026, 10, 9, 10, 30))).toISOString() === new Date(bj(2026, 10, 9, 12)).toISOString(),
  ],
]

let failed = 0
console.log('')
for (const [label, pass] of checks) {
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
}

// A second request must be answered consistently.
const res2 = fakeResponse()
await route.handler(req, res2)
const body2 = JSON.parse(res2.body)
console.log(
  body2.balanceError === body.balanceError && body2.period.peak === body.period.peak
    ? 'PASS  second request stable'
    : 'FAIL  second request drifted',
)

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
