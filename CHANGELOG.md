# Changelog

All notable changes to this plugin are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-10-10

### Removed

- **Today's spend.** The readout is now balance plus the current price window.
  Measuring a day correctly needed a replay of every session log (a day usually
  starts before DSH does), and even then it could not see API calls made outside
  DSH with the same key — so the number was structurally low and easy to
  misread. Balance is the official figure and needs none of that machinery.
- Consequently gone: the per-day ledger, the session-log replay and its zstd
  frame splitting, the `session/event` usage listener, the model price table,
  `measureDay` / `costOf` / `priceFor` / `beijingDay`, and the two tools that
  supported them. The Host half dropped from 736 to about 280 lines and the
  plugin now writes no files at all.

### Added

- The expanded detail now names where the number came from (API key vs signed-in
  account) and when it was fetched.

## [1.0.1] - 2026-10-10

### Fixed

- **Today's spend only counted steps taken after the plugin loaded.** A day that
  began before DSH started was undercounted — a real day measured ¥1.49 against
  a reported ¥0.17. The plugin now replays the day's session logs
  (`session.v*.jsonl.zstd`) at mount, every five minutes, and on every manual
  refresh, so the readout covers the whole Beijing calendar day.
- **A wrong reading poisoned the day permanently.** The stored total was treated
  as a monotonic floor (`max(stored, measured)`), so nothing could ever lower it.
  A day's row now separates `measured` (the authoritative replay) from `live`
  (steps since that replay); the displayed value is their sum and each replay
  resets `live`, which makes a bad value self-correcting. Existing v1 ledgers are
  adopted as the measured floor and replaced by the first replay.

### Added

- `_tools/audit-session-usage.mjs` — independently totals a day straight from the
  session logs, for checking the plugin against the official dashboard.
- `_tools/verify-ledger-model.mjs` — regression test proving an inflated ledger
  is corrected downwards, an understated one is raised, and a second replay is
  idempotent rather than additive.

### Notes

- Session logs are a sequence of independent zstd frames (one per appended line),
  not one stream: decompressing the whole file yields only the session header.
  Both the plugin and the audit tool split frames first.

## [1.0.0] - 2026-10-02

First public release.

### Added

- Sidebar-foot readout in `sidebar.footer.action`: balance and today's spend on
  two text lines, collapsing to a two-cell readout in the 56px rail.
- Peak / off-peak marker with a live countdown, computed in the browser from the
  official Beijing-time windows (weekdays 09:00–12:00 and 14:00–18:00) with the
  2026 public-holiday list.
- Today's spend measured from real per-step `session/event` usage, priced at the
  rate in force at that step's instant, persisted per Beijing day to
  `$DSH_HOME/dsh-balance-peek/ledger.json`.
- Wallet balance from the official `/user/balance` endpoint through DSH's own
  `credentials` service, falling back to the signed-in account wallet.
- Click to force a refresh and expand the day's details (requests, tokens,
  top-ups, balance timestamp).
- One read-only route, `GET /dsh-balance/state.json`, behind a loopback /
  same-origin fence that defers to DSH's `connection.requestRejection`.

### Notes

- No build step: `lib/index.js` (Host) and `lib/client.js` (browser) are the
  shipped sources.
- Holiday list requires an annual update once the State Council publishes the
  next year's arrangement.
