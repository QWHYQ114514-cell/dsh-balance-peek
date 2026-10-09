/**
 * Waits for a just-published npm version to leave the registry's processing
 * queue and become publicly installable.
 *
 * A brand-new package name answers `202 Accepted` on publish; the registry then
 * serves a `0.0.0-stage` placeholder until scanning finishes. This polls until
 * the real version shows up in the packument (or the deadline passes).
 *
 * Usage: node _tools/wait-for-npm.mjs <name> <version> [timeoutMinutes]
 */
const [name, version, timeoutMinutes = '10'] = process.argv.slice(2)
if (!name || !version) {
  console.error('usage: node wait-for-npm.mjs <name> <version> [timeoutMinutes]')
  process.exit(2)
}

const deadline = Date.now() + Number(timeoutMinutes) * 60_000
const started = Date.now()
let attempt = 0

const stamp = () => new Date().toISOString().slice(11, 19)

while (Date.now() < deadline) {
  attempt++
  let state = 'unreachable'
  let live = false
  try {
    const res = await fetch(`https://registry.npmjs.org/${name}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    })
    if (res.status === 200) {
      const doc = await res.json()
      const versions = Object.keys(doc.versions ?? {})
      live = versions.includes(version)
      state = live
        ? `LIVE (${versions.join(', ')})`
        : `processing — versions=[${versions.join(', ')}] latest=${doc['dist-tags']?.latest ?? '?'}`
    } else {
      state = `HTTP ${res.status}`
    }
  } catch (err) {
    state = `fetch failed: ${err.message}`
  }

  console.log(`[${stamp()}] attempt ${attempt}: ${state}`)
  if (live) {
    const tarball = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`
    const head = await fetch(tarball, { method: 'HEAD' })
    console.log(`[${stamp()}] tarball HEAD -> ${head.status} (${head.headers.get('content-length')} bytes)`)
    console.log(`LIVE: ${name}@${version}`)
    console.log(`https://www.npmjs.com/package/${name}`)
    console.log(`elapsed: ${Math.round((Date.now() - started) / 1000)}s`)
    process.exit(0)
  }

  await new Promise((resolve) => setTimeout(resolve, 45_000))
}

console.log(`TIMEOUT after ${timeoutMinutes} minutes: ${name}@${version} is still not live`)
process.exit(1)
