# Changelog

All notable changes to this plugin are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
