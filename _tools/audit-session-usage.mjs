/**
 * Independent audit of one day's DeepSeek spend, read straight from the DSH
 * session logs instead of the plugin's live ledger.
 *
 * Why this exists: the plugin only sees usage events that happen while it is
 * loaded, so a day that began before DSH started is undercounted. The session
 * logs are the durable record of every step, so they are the authority for
 * "what did today actually cost".
 *
 * Format notes (verified against DSH 0.2.0-rc.2):
 *   - `session.v<N>.jsonl.zstd` is NOT one zstd stream: it is a sequence of
 *     independent zstd frames, one per appended line. A plain
 *     `zstdDecompressSync` on the whole file returns only the first frame (the
 *     session header), which silently yields "no usage found".
 *   - Each line is `{ type, seq, time, data }`; `time` is epoch milliseconds.
 *   - Usage lives at `data.usage` as
 *     `{ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, totalTokens }`.
 *     `inputTokens` is the cache-MISS portion; cached reads are separate.
 *
 * Usage: node audit-session-usage.mjs <sessions-root> [YYYY-MM-DD]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import path from 'node:path'

const BEIJING_OFFSET_MS = 8 * 3600 * 1000
const beijingDay = (ms) => new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10)

/** Official CNY per million tokens: [off-peak, peak] for hit / miss / output. */
const PRICING = {
  'deepseek-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-flash-vision-exp': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-pro': { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] },
  _default: { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
}
const PEAK_HOURS = [[9, 12], [14, 18]]
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
])

function isPeak(ms) {
  const d = new Date(ms + BEIJING_OFFSET_MS)
  if ([0, 6].includes(d.getUTCDay())) return false
  if (HOLIDAYS.has(d.toISOString().slice(0, 10))) return false
  const hour = d.getUTCHours()
  return PEAK_HOURS.some(([a, b]) => hour >= a && hour < b)
}

function priceFor(model) {
  const m = String(model ?? '').toLowerCase()
  for (const key of Object.keys(PRICING)) {
    if (key !== '_default' && m.includes(key)) return PRICING[key]
  }
  return PRICING._default
}

/** Split a multi-frame zstd session log into its decoded lines. */
function decodeSessionLog(file) {
  const buf = readFileSync(file)
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
  const offsets = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offsets.push(i)
  }
  if (offsets.length === 0) return []
  const lines = []
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try {
      const text = zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8')
      for (const line of text.split('\n')) if (line.trim() !== '') lines.push(line)
    } catch {
      /* one unreadable frame must not lose the rest of the log */
    }
  }
  return lines
}

const root = process.argv[2]
const day = process.argv[3] ?? beijingDay(Date.now())
if (!root) {
  console.error('usage: node audit-session-usage.mjs <sessions-root> [YYYY-MM-DD]')
  process.exit(2)
}

const totals = {
  steps: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0,
  cost: 0, byModel: {}, bySession: {}, peakCost: 0, offPeakCost: 0,
}
const firstAt = { value: Infinity }
const lastAt = { value: 0 }

/** Walk every session directory under the root (one level of workspace dirs). */
function sessionDirs(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (!statSync(full).isDirectory()) continue
    if (readdirSync(full).some((f) => /^session\.v\d+\.jsonl/.test(f))) out.push(full)
    else out.push(...sessionDirs(full))
  }
  return out
}

for (const dir of sessionDirs(root)) {
  const logName = readdirSync(dir).filter((f) => /^session\.v\d+\.jsonl\.zstd$/.test(f)).sort().at(-1)
  if (logName === undefined) continue
  let stepsHere = 0
  for (const line of decodeSessionLog(path.join(dir, logName))) {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.type !== 'assistant/message') continue
    const usage = record.data?.usage
    if (!usage || typeof usage !== 'object') continue
    const atMs = Number(record.time)
    if (!Number.isFinite(atMs) || beijingDay(atMs) !== day) continue

    const model = record.data?.message?.source?.model ?? '(unknown)'
    const input = Number(usage.inputTokens) || 0
    const cache = Number(usage.cacheReadTokens) || 0
    const cacheWrite = Number(usage.cacheWriteTokens) || 0
    const output = Number(usage.outputTokens) || 0
    const p = priceFor(model)
    const idx = isPeak(atMs) ? 1 : 0
    const cost = (cache / 1e6) * p.hit[idx] + (input / 1e6) * p.miss[idx] + (output / 1e6) * p.out[idx]

    totals.steps += 1
    stepsHere += 1
    totals.input += input
    totals.cacheRead += cache
    totals.cacheWrite += cacheWrite
    totals.output += output
    totals.cost += cost
    if (idx === 1) totals.peakCost += cost
    else totals.offPeakCost += cost
    totals.byModel[model] = (totals.byModel[model] ?? 0) + cost
    firstAt.value = Math.min(firstAt.value, atMs)
    lastAt.value = Math.max(lastAt.value, atMs)
  }
  if (stepsHere > 0) totals.bySession[path.basename(dir)] = stepsHere
}

console.log(`day (Beijing): ${day}`)
console.log(`sessions root: ${root}`)
console.log(`\nsteps (assistant messages): ${totals.steps}`)
console.log(`  inputTokens (cache miss): ${totals.input.toLocaleString('en-US')}`)
console.log(`  cacheReadTokens:          ${totals.cacheRead.toLocaleString('en-US')}`)
console.log(`  cacheWriteTokens:         ${totals.cacheWrite.toLocaleString('en-US')}`)
console.log(`  outputTokens:             ${totals.output.toLocaleString('en-US')}`)
console.log(`  sum of all four:          ${(totals.input + totals.cacheRead + totals.cacheWrite + totals.output).toLocaleString('en-US')}`)
console.log(`\ncost at official rates: ¥${totals.cost.toFixed(4)}`)
console.log(`  peak:     ¥${totals.peakCost.toFixed(4)}`)
console.log(`  off-peak: ¥${totals.offPeakCost.toFixed(4)}`)
if (Number.isFinite(firstAt.value)) {
  console.log(`\nfirst step: ${new Date(firstAt.value).toISOString()}`)
  console.log(`last step:  ${new Date(lastAt.value).toISOString()}`)
}
console.log('\nby model:')
for (const [model, cost] of Object.entries(totals.byModel).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${model.padEnd(34)} ¥${cost.toFixed(4)}`)
}
console.log('\nby session:')
for (const [session, steps] of Object.entries(totals.bySession).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${steps.toString().padStart(4)} steps  ${session}`)
}
