/**
 * Cheap structural audit for the hand-repaired client bundle: every line's
 * double-quote count must be even (catches a quote swallowed by the encoding
 * accident), and the file must parse.
 *
 * Usage: node _tools/audit-client-quotes.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, '..', 'lib', 'client.js')
const text = readFileSync(file, 'utf8')

let bad = 0
text.split(/\r?\n/).forEach((line, index) => {
  const quotes = (line.match(/(?<!\\)"/g) ?? []).length
  if (quotes % 2 !== 0) {
    console.log(`odd quote count at L${index + 1}: ${line.trim()}`)
    bad++
  }
})
console.log(bad === 0 ? 'quote balance OK' : `${bad} suspicious line(s)`)

// Parse without executing: a syntax error here is the real failure signal.
try {
  new vm.Script(text, { filename: 'client.js' })
  console.log('parse OK')
} catch (err) {
  console.log(`parse FAILED: ${err.message}`)
  process.exitCode = 1
}
