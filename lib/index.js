/**
 * dsh-balance-peek — Host half.
 *
 * Reads the DeepSeek wallet balance through DSH's own credential services,
 * accumulates today's spend from real per-step usage events, and publishes a
 * single read-only JSON route. The browser half (lib/client.js) renders the
 * two-line readout in the sidebar foot.
 *
 * Design notes
 * ------------
 * - Everything here is deliberately defensive. A cosmetic sidebar readout must
 *   never be able to break the harness, so services are resolved through
 *   `ctx.inject` / `ctx.get`, and every failure degrades to a status string the
 *   browser can show instead of throwing out of `apply`.
 * - Today's spend is measured from `session/event` usage, never from balance
 *   deltas: the balance endpoint sits behind a cache and can lag by minutes, so
 *   a delta-based number would be both late and wrong.
 * - All pricing is CNY per million tokens, off-peak first, peak second, as
 *   published on https://api-docs.deepseek.com/zh-cn/quick_start/pricing/.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'dsh-balance-peek'

// ---------------------------------------------------------------------------
// Pricing and the peak / off-peak windows
// ---------------------------------------------------------------------------

/**
 * [off-peak, peak] unit prices per million tokens, in CNY. Peak = 2x off-peak.
 * Source: official pricing table (deepseek-flash 0.02/1/4, deepseek-v4-pro
 * 0.15/4.5/13.5 off-peak).
 */
const PRICING = {
  'deepseek-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  // Legacy names are served by DeepSeek-V4.1-Flash and billed at Flash prices.
  'deepseek-v4-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-flash-vision-exp': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-pro': { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] },
  _default: { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
}

/** Beijing-time peak windows: Monday-Friday 09:00-12:00 and 14:00-18:00. */
const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]

/**
 * Public holidays (Beijing calendar days) billed entirely at off-peak rates.
 * Only days actually OFF work are listed: every make-up workday falls on a
 * weekend, and weekends are off-peak anyway.
 *
 * ⚠️ Append the next year once the State Council publishes the arrangement
 * (usually each November). Until then an unlisted holiday reads as an ordinary
 * peak weekday here, which is a display-only inaccuracy.
 */
const HOLIDAY_VALLEY = new Set([
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

const BEIJING_OFFSET_MS = 8 * 3600 * 1000

/** Beijing calendar parts for one instant (read through UTC on a shifted clock). */
function beijingParts(ms) {
  const d = new Date(ms + BEIJING_OFFSET_MS)
  return {
    day: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(), // 0 Sunday .. 6 Saturday
  }
}

/** Beijing calendar day key (`YYYY-MM-DD`). */
export function beijingDay(ms = Date.now()) {
  return beijingParts(ms).day
}

/** The official price row for a model name. */
export function priceFor(model) {
  const m = String(model || '').toLowerCase()
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    if (m.includes(key)) return PRICING[key]
  }
  return PRICING._default
}

/** Whether one instant falls inside a peak window. */
export function isPeak(ms = Date.now()) {
  const { day, hour, weekday } = beijingParts(ms)
  if (weekday === 0 || weekday === 6) return false
  if (HOLIDAY_VALLEY.has(day)) return false
  return PEAK_HOURS.some(([start, end]) => hour >= start && hour < end)
}

/**
 * The next instant at which peak/off-peak flips, as epoch ms.
 * Walks minute by minute within an 8-day horizon: cheap, and immune to
 * off-by-one mistakes in a hand-written window table.
 */
export function nextSwitchAt(ms = Date.now()) {
  const current = isPeak(ms)
  const start = Math.floor(ms / 60000) * 60000
  for (let t = start + 60000; t <= start + 8 * 24 * 3600 * 1000; t += 60000) {
    if (isPeak(t) !== current) return t
  }
  return null
}

/** Cost in CNY for one step's usage. */
export function costOf(model, usage, atMs = Date.now()) {
  const p = priceFor(model)
  const idx = isPeak(atMs) ? 1 : 0
  const cache = Number(usage?.cacheReadTokens) || 0
  const input = Number(usage?.inputTokens) || 0
  const output = Number(usage?.outputTokens) || 0 // DSH already folds reasoning tokens in
  return (cache / 1e6) * p.hit[idx] + (input / 1e6) * p.miss[idx] + (output / 1e6) * p.out[idx]
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Durable per-day totals plus the last observed wallet balance.
 *
 * Two sources describe the same day, and they must not be added blindly:
 *
 *   `measured` — an absolute total replayed from the session logs. Authoritative,
 *                and complete: the logs hold every step the Host ever wrote.
 *   `live`     — steps seen on the `session/event` feed SINCE the last replay.
 *                Nothing more than latency cover for the newest few steps.
 *
 * A day's total is therefore `measured + live`, and each replay resets `live`
 * to the steps that arrived while it ran. Summing them without that reset — or
 * keeping a running maximum — would let the number ratchet upwards and never
 * come back down, which is exactly how a bad first reading poisons a day.
 *
 * Shape: `{ version, days: { 'YYYY-MM-DD': { measured, live, topUps } },
 * lastBalance, updatedAt }`
 */
function createLedger(file) {
  const emptyTotals = () => ({ cost: 0, tokens: 0, steps: 0 })
  const emptyDay = () => ({ measured: emptyTotals(), live: emptyTotals(), topUps: 0 })
  const empty = () => ({ version: 2, days: {}, lastBalance: null, updatedAt: null })
  let data = empty()
  let flushTimer = null

  /**
   * Migrate a stored row. A v1 row kept one accumulated total, so it is adopted
   * as the measured floor; the first replay of the day then replaces it with the
   * logs' own answer.
   */
  const adopt = (row) => {
    if (row && typeof row === 'object' && row.measured) return row
    return {
      measured: {
        cost: Number(row?.cost) || 0,
        tokens: Number(row?.tokens) || 0,
        steps: Number(row?.steps) || 0,
      },
      live: emptyTotals(),
      topUps: Number(row?.topUps) || 0,
    }
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') {
      data = { ...empty(), ...parsed }
      for (const day of Object.keys(data.days)) data.days[day] = adopt(data.days[day])
      // The rows are v2-shaped from here on, whatever the file claimed.
      data.version = 2
    }
  } catch {
    /* absent or unreadable: start empty rather than refuse to run */
  }

  const prune = () => {
    const cutoff = beijingDay(Date.now() - 400 * 24 * 3600 * 1000)
    for (const day of Object.keys(data.days)) {
      if (day < cutoff) delete data.days[day]
    }
  }

  const flush = () => {
    flushTimer = null
    try {
      prune()
      data.updatedAt = new Date().toISOString()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8')
      fs.renameSync(tmp, file)
    } catch {
      /* a read-only home must not stop the readout from working in memory */
    }
  }

  const row = (day) => data.days[day] ?? emptyDay()

  return {
    /** Deferred write: usage events arrive in bursts, so coalesce them. */
    schedule() {
      if (flushTimer !== null) return
      flushTimer = setTimeout(flush, 2000)
      if (typeof flushTimer.unref === 'function') flushTimer.unref()
    },
    flushNow: flush,
    /** `measured + live`, the number the sidebar shows. */
    day(day = beijingDay()) {
      const current = row(day)
      return {
        cost: current.measured.cost + current.live.cost,
        tokens: current.measured.tokens + current.live.tokens,
        steps: current.measured.steps + current.live.steps,
        measuredCost: current.measured.cost,
        measuredSteps: current.measured.steps,
        topUps: current.topUps,
      }
    },
    /** A step observed live; cleared by the next replay that includes it. */
    addStep(day, cost, tokens) {
      const current = row(day)
      current.live.cost += cost
      current.live.tokens += tokens
      current.live.steps += 1
      data.days[day] = current
      this.schedule()
    },
    addTopUp(day) {
      const current = row(day)
      current.topUps += 1
      data.days[day] = current
      this.schedule()
    },
    /**
     * Replace one day's measured totals with the replay's, carrying over the
     * steps that arrived while the replay ran.
     *
     * @param measured - `{ cost, tokens, steps }` from {@link measureDay}
     * @param live - live totals sampled BEFORE the replay started
     * @returns whether the stored totals moved
     */
    observeDay(day, measured, live) {
      const current = row(day)
      const before = current.measured
      const changed =
        before.cost !== measured.cost ||
        before.tokens !== measured.tokens ||
        before.steps !== measured.steps ||
        current.live.cost !== live.cost ||
        current.live.tokens !== live.tokens ||
        current.live.steps !== live.steps
      if (!changed) return false
      current.measured = { cost: measured.cost, tokens: measured.tokens, steps: measured.steps }
      current.live = { cost: live.cost, tokens: live.tokens, steps: live.steps }
      data.days[day] = current
      this.schedule()
      return true
    },
    /** Zero the live counters; only a replay should call this. */
    resetLive(day = beijingDay()) {
      const current = row(day)
      current.live = emptyTotals()
      data.days[day] = current
    },
    /** The live counters on their own, to hand back to {@link observeDay}. */
    liveTotals(day = beijingDay()) {
      return { ...row(day).live }
    },
    get lastBalance() {
      return data.lastBalance
    },
    set lastBalance(value) {
      data.lastBalance = value
      this.schedule()
    },
    snapshot() {
      return { days: { ...data.days }, lastBalance: data.lastBalance }
    },
  }
}

// ---------------------------------------------------------------------------
// Session-log replay
// ---------------------------------------------------------------------------

/**
 * DSH writes each session as `session.v<N>.jsonl.zstd` inside
 * `<sessions root>/<workspace>/<session-id>/`. The extension is misleading: the
 * file is a sequence of INDEPENDENT zstd frames, one per appended line, so a
 * single `zstdDecompressSync` over the whole file returns only the first frame
 * (the session header) — which reads as "no usage at all".
 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** Decode every frame of one session log into its JSONL lines. */
function decodeSessionLog(file) {
  const buf = fs.readFileSync(file)
  const offsets = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
      offsets.push(i)
    }
  }
  if (offsets.length === 0) return []
  const lines = []
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try {
      const text = zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8')
      for (const line of text.split('\n')) if (line.trim() !== '') lines.push(line)
    } catch {
      /* one damaged frame must not discard the rest of the session */
    }
  }
  return lines
}

/** Every session directory beneath a sessions root, at any depth. */
function sessionDirsUnder(root, depth = 0) {
  if (depth > 3) return []
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = path.join(root, entry.name)
    let names
    try {
      names = fs.readdirSync(full)
    } catch {
      continue
    }
    if (names.some((n) => /^session\.v\d+\.jsonl/.test(n))) found.push(full)
    else found.push(...sessionDirsUnder(full, depth + 1))
  }
  return found
}

/**
 * Sum one Beijing day of usage by replaying the session logs.
 *
 * This is the authority behind "today's spend": the logs carry every step with
 * its own timestamp, so a step is priced at the rate in force when it actually
 * ran, and steps that happened before this plugin loaded are included.
 *
 * @returns `{ cost, tokens, steps }`; all zero when the root is unreadable.
 */
export function measureDay(sessionsRoot, day = beijingDay()) {
  const totals = { cost: 0, tokens: 0, steps: 0 }
  for (const dir of sessionDirsUnder(sessionsRoot)) {
    let logName
    try {
      logName = fs
        .readdirSync(dir)
        .filter((f) => /^session\.v\d+\.jsonl\.zstd$/.test(f))
        .sort()
        .at(-1)
    } catch {
      continue
    }
    if (logName === undefined) continue

    for (const line of decodeSessionLog(path.join(dir, logName))) {
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record?.type !== 'assistant/message') continue
      const usage = record.data?.usage
      if (!usage || typeof usage !== 'object') continue
      const atMs = Number(record.time)
      if (!Number.isFinite(atMs) || beijingDay(atMs) !== day) continue
      totals.cost += costOf(record.data?.message?.source?.model, usage, atMs)
      totals.steps += 1
      totals.tokens +=
        (Number(usage.inputTokens) || 0) +
        (Number(usage.cacheReadTokens) || 0) +
        (Number(usage.cacheWriteTokens) || 0) +
        (Number(usage.outputTokens) || 0)
    }
  }
  return totals
}

// ---------------------------------------------------------------------------
// Host plugin
// ---------------------------------------------------------------------------

/** How long a fetched balance stays fresh. */
const BALANCE_TTL_MS = 25_000
/** Balance sampling cadence while a browser is watching. */
const SAMPLE_INTERVAL_MS = 60_000
/** Stop background sampling this long after the last browser poll. */
const SAMPLE_IDLE_MS = 10 * 60_000
/** How long a log replay stays authoritative before it is worth repeating. */
const BACKFILL_TTL_MS = 5 * 60_000

function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

/** Send one JSON body with the headers a polled readout wants. */
function sendJson(res, body, status = 200) {
  const text = JSON.stringify(body)
  if (res.headersSent) return
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(text)),
  })
  res.end(text)
}

export default {
  name,

  /**
   * Deliberately no object-level `inject`: that would hold `apply` back until
   * every service is up. The two dependencies are awaited in their own child
   * scopes instead, so a host without a Web server simply mounts nothing.
   */
  apply(root) {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const ledgerFile = path.join(home, 'dsh-balance-peek', 'ledger.json')
    const ledger = createLedger(ledgerFile)
    root.effect(() => () => ledger.flushNow())

    /**
     * Where DSH keeps session logs. The profile composes
     * `session-persistence-jsonl` with `dshHomePath('sessions')`, so the home
     * default is always right unless that entry is reconfigured; set
     * `DSH_BALANCE_PEEK_SESSIONS` (or `DSH_HOME`) to point somewhere else.
     *
     * Deliberately NOT a plugin config field: Cordis calls `apply(ctx)` with one
     * argument unless a `Config` schema is declared, so a second parameter would
     * silently never arrive.
     */
    const sessionsRoot = process.env.DSH_BALANCE_PEEK_SESSIONS || path.join(home, 'sessions')

    const state = {
      balance: null, // { amount, currency, source, at }
      balanceError: null,
      lastPoll: 0,
      sampling: false,
      lastBackfill: 0,
      backfillError: null,
    }

    /**
     * Bring the ledger up to what the session logs already know.
     *
     * The live `session/event` feed only covers steps taken while this plugin
     * was loaded, so a day that started earlier would undercount — badly, since
     * a single DSH launch can begin hours after the day did. Replaying the logs
     * closes that gap, and `observeDay` takes the larger of the two so nothing
     * is counted twice.
     *
     * @param force - ignore the freshness window
     * @returns whether the day's totals moved
     */
    const backfill = (force = false) => {
      if (!force && Date.now() - state.lastBackfill < BACKFILL_TTL_MS) return false
      state.lastBackfill = Date.now()
      const day = beijingDay()
      // Snapshot the live counters, then clear them: whatever the replay picks
      // up from the log is no longer "live", and whatever landed during the
      // replay accumulates into the freshly cleared counter. Each step is
      // therefore counted exactly once — never twice, never lost.
      const live = ledger.liveTotals(day)
      ledger.resetLive(day)
      try {
        const measured = measureDay(sessionsRoot, day)
        state.backfillError = null
        return ledger.observeDay(day, measured, live)
      } catch (err) {
        // A read-only or relocated sessions directory must not break the readout.
        state.backfillError = String(err?.message || err).slice(0, 160)
        return false
      }
    }

    // Reconcile with the logs as soon as the plugin mounts, not on first poll:
    // the sidebar should show the day's real total from its first paint.
    backfill(true)
    const backfillTimer = setInterval(() => backfill(), BACKFILL_TTL_MS)
    if (typeof backfillTimer.unref === 'function') backfillTimer.unref()
    root.effect(() => () => clearInterval(backfillTimer))

    // -- today's spend, measured from real usage events ---------------------
    root.inject(['sessions'], (ctx) => {
      ctx.effect(
        () =>
          ctx.on('session/event', (_session, event) => {
            try {
              if (!event || event.type !== 'assistant/message') return
              const usage = event.data?.usage
              if (!usage || typeof usage !== 'object') return
              const model = event.data?.message?.source?.model
              const tokens =
                (Number(usage.inputTokens) || 0) +
                (Number(usage.cacheReadTokens) || 0) +
                (Number(usage.cacheWriteTokens) || 0) +
                (Number(usage.outputTokens) || 0)
              const cost = costOf(model, usage)
              if (!(cost > 0)) return
              ledger.addStep(beijingDay(), cost, tokens)
            } catch {
              /* a malformed event must never escape into the session log path */
            }
          }),
        'dsh-balance-peek: usage ledger',
      )
    })

    // -- credential resolution ---------------------------------------------
    const accountClient = () => ({
      version: process.env.DSH_CLIENT_VERSION || '0.2.0',
      locale: 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    })

    /** The signed-in DeepSeek account's wallet, when there is one. */
    const accountBalance = async () => {
      try {
        const account = root.get('deepseekAccount')
        if (!account || typeof account.getBalance !== 'function') return null
        const result = await account.getBalance(accountClient())
        const wallets = result?.status === 'ready' ? result.value : null
        if (!Array.isArray(wallets) || wallets.length === 0) return null
        const pick = wallets.find((w) => w?.currency === 'CNY') ?? wallets[0]
        const amount = Number(pick?.balance)
        if (!Number.isFinite(amount)) return null
        return { amount, currency: String(pick?.currency || 'CNY'), source: 'account', at: Date.now() }
      } catch {
        return null
      }
    }

    /** Wallet balance: the API key first, then the signed-in account. */
    const fetchBalance = async () => {
      let key
      try {
        key = await root.get('credentials')?.resolve('DEEPSEEK_API_KEY')
      } catch {
        key = undefined
      }

      if (key?.value !== undefined) {
        try {
          const res = await fetch('https://api.deepseek.com/user/balance', {
            headers: { Authorization: `Bearer ${key.value}` },
            signal: AbortSignal.timeout(10_000),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          const info = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : null
          const amount = Number(info?.total_balance ?? data?.total_balance)
          if (!Number.isFinite(amount)) throw new Error('余额接口返回结构异常')
          return { amount, currency: String(info?.currency || 'CNY'), source: 'apikey', at: Date.now() }
        } catch (err) {
          state.balanceError = `余额接口请求失败：${String(err?.message || err).slice(0, 160)}`
        }
      }

      const account = await accountBalance()
      if (account) {
        state.balanceError = null
        return account
      }
      if (key?.value === undefined && state.balanceError === null) {
        state.balanceError = '未配置 DEEPSEEK_API_KEY，且未登录 DeepSeek 账号'
      }
      return null
    }

    /** Refresh the cached balance, honouring the TTL unless forced. */
    const ensureBalance = async (force = false) => {
      if (!force && state.balance && Date.now() - state.balance.at < BALANCE_TTL_MS) return state.balance
      const next = await fetchBalance()
      if (!next) return state.balance
      // A wallet that grew is a top-up, not negative spend.
      if (state.balance && next.amount - state.balance.amount > 0.01) ledger.addTopUp(beijingDay())
      state.balance = next
      ledger.lastBalance = next.amount
      return next
    }

    // -- background sampling while a browser watches ------------------------
    const tick = async () => {
      if (Date.now() - state.lastPoll > SAMPLE_IDLE_MS) {
        state.sampling = false
        return
      }
      try {
        await ensureBalance()
      } catch {
        /* keep sampling */
      }
      const timer = setTimeout(() => void tick(), SAMPLE_INTERVAL_MS)
      if (typeof timer.unref === 'function') timer.unref()
    }

    const snapshot = async (force) => {
      state.lastPoll = Date.now()
      if (!state.sampling) {
        state.sampling = true
        void tick()
      }
      // A forced refresh (the user clicked the readout) also re-reads the logs,
      // so the number never lags behind what the session has already spent.
      backfill(force)
      try {
        await ensureBalance(force)
      } catch (err) {
        state.balanceError = String(err?.message || err).slice(0, 160)
      }
      const now = Date.now()
      const today = ledger.day(beijingDay(now))
      return {
        ok: true,
        balance: state.balance ? state.balance.amount : null,
        currency: state.balance?.currency ?? 'CNY',
        balanceSource: state.balance?.source ?? null,
        balanceAt: state.balance?.at ?? null,
        balanceError: state.balanceError,
        today: { cost: today.cost, tokens: today.tokens, steps: today.steps, topUps: today.topUps },
        backfill: {
          at: state.lastBackfill,
          error: state.backfillError,
          sessionsRoot,
        },
        period: {
          peak: isPeak(now),
          nextSwitchAt: nextSwitchAt(now),
          peakHours: PEAK_HOURS,
        },
        ledger: ledger.snapshot(),
        serverTime: now,
      }
    }

    // -- the read-only route ------------------------------------------------
    root.inject(['webServer'], (ctx) => {
      /** Same-origin + loopback fence: the wallet is the operator's, not the LAN's. */
      const rejected = (req, res) => {
        try {
          const headers = req?.headers ?? {}
          const hostUrl = new URL(`http://${String(headers.host || '')}`)
          const trusted = String(process.env.DSH_BALANCE_TRUSTED_HOSTS || '')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
          if (!isLoopbackHostname(hostUrl.hostname) && !trusted.includes(hostUrl.host.toLowerCase())) {
            sendJson(res, { ok: false, error: 'forbidden host' }, 403)
            return true
          }
          if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
            sendJson(res, { ok: false, error: 'cross-site request' }, 403)
            return true
          }
          const origin = headers.origin
          if (typeof origin === 'string' && origin && origin !== 'null') {
            if (new URL(origin).host.toLowerCase() !== hostUrl.host.toLowerCase()) {
              sendJson(res, { ok: false, error: 'origin mismatch' }, 403)
              return true
            }
          }
          // Defer to the host fence when it exists; keep working when it does not.
          const fence = ctx.get('connection')
          if (fence && typeof fence.requestRejection === 'function') {
            const code = fence.requestRejection(req)
            if (code) {
              sendJson(res, { ok: false, error: 'untrusted request' }, code)
              return true
            }
          }
          return false
        } catch {
          sendJson(res, { ok: false, error: 'bad request' }, 403)
          return true
        }
      }

      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'exact',
            path: '/dsh-balance/state.json',
            handler: async (req, res) => {
              if (rejected(req, res)) return
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                sendJson(res, { ok: false, error: 'method not allowed' }, 405)
                return
              }
              const force = new URL(req.url || '/', 'http://localhost').searchParams.get('refresh') === '1'
              try {
                sendJson(res, await snapshot(force))
              } catch (err) {
                sendJson(res, { ok: false, error: String(err?.message || err).slice(0, 200) })
              }
            },
          }),
        'dsh-balance-peek: state route',
      )
    })
  },
}
