/**
 * Verifies the browser half without a browser: it builds the same
 * `window.__ModuleLoader__` facade the shell installs, evaluates lib/client.js
 * against a stub React, and asserts the registration contract the slot system
 * depends on.
 *
 * Usage: node _tools/verify-balance-client.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.join(here, '..')
const file = path.join(pkgRoot, 'lib', 'client.js')
const source = readFileSync(file, 'utf8')
const pkg = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))

const registrations = new Map()

/** Minimal React stand-in: enough for the plugin's createElement calls. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useEffect: (fn) => {
    // Run the effect body once so the polling wiring is exercised; the cleanup
    // it returns is discarded.
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanup()
  },
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
}

const sandbox = {
  window: {
    __ModuleLoader__: {
      load(registration) {
        if (registrations.has(registration.id)) throw new Error(`duplicate registration ${registration.id}`)
        registrations.set(registration.id, registration)
      },
    },
  },
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: async () => ({ json: async () => ({ ok: true, balance: 1, currency: 'CNY', today: { cost: 0, steps: 0 } }) }),
  Date,
  Math,
  Number,
  String,
  Array,
  Object,
  JSON,
  Promise,
  Set,
  Symbol,
  Error,
}

vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

const checks = []
const check = (label, pass) => checks.push([label, Boolean(pass)])

check('registers exactly one module row', registrations.size === 1)
const registration = registrations.values().next().value
check('row id matches the package name resolved by the host', registration?.id === pkg.name)
check('factory is a function of require', typeof registration?.factory === 'function')

const requireStub = (id) => {
  if (id === 'react') return React
  throw new Error(`unexpected module request: ${id}`)
}
const exports = registration.factory(requireStub)

check('exports inject', Array.isArray(exports.inject) && exports.inject.includes('slots'))
check('exports apply', typeof exports.apply === 'function')

// Drive apply() against a stub slots service and capture the registration.
let captured = null
const ctx = {
  slots: {
    inject(name, callback) {
      check('injects the sidebar footer slot', name === 'sidebar.footer.action')
      callback()
    },
    register(options, component) {
      captured = { options, component }
      return () => {}
    },
  },
}
exports.apply(ctx)

check('registered the expected slot', captured?.options?.name === 'sidebar.footer.action')
check('used a plugin-private cell id', captured?.options?.id === 'dsh-balance-peek')
check('declared an order', typeof captured?.options?.order === 'number')
check('label is a thunk (locale-independent)', typeof captured?.options?.label === 'function')
check('component is the readout function', typeof captured?.component === 'function')

// Render the wide and rail variants; the element tree must be text-only.
const wide = captured.component({ wide: true })
const rail = captured.component({ wide: false })
check('wide variant renders a button', wide?.type === 'button')
check('rail variant renders a button', rail?.type === 'button')
check('rail variant stays compact', rail.children.length === 2)
check('wide variant renders two lines', wide.children.filter(Boolean).length >= 2)
check('no image or svg nodes in the tree', !JSON.stringify(wide).includes('"img"') && !JSON.stringify(wide).includes('"svg"'))

let failed = 0
for (const [label, pass] of checks) {
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
}
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
