/**
 * Creates the public GitHub repository and pushes `main`, using the token Git
 * Credential Manager already holds for github.com.
 *
 * The token is read through `git credential fill`, kept in memory, and never
 * printed. Progress goes to stderr; stdout carries only the final URL.
 *
 * Usage: node _tools/publish-github.mjs [--private]
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..')
const OWNER = 'QWHYQ114514-cell'
const REPO = 'dsh-balance-peek'
const TOPIC = 'dsh-plugin'
const privateRepo = process.argv.includes('--private')
const DESCRIPTION =
  "DeepSeek Harness plugin: minimal two-line balance, today's spend and peak/off-peak readout at the sidebar foot."

const log = (message) => process.stderr.write(`${message}\n`)

/** The stored github.com credential, or null when there is none. */
function githubToken() {
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    const match = /^password=(.+)$/m.exec(out)
    return match ? match[1].trim() : null
  } catch (err) {
    log(`git credential fill failed: ${err.message}`)
    return null
  }
}

const token = githubToken()
if (token === null) {
  log('no stored GitHub credential; nothing was created')
  process.exit(2)
}
log(`using stored credential for github.com (${token.length} chars)`)

const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-balance-peek-publish',
  'x-github-api-version': '2022-11-28',
}

async function api(method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON error page */
  }
  return { status: res.status, json, text }
}

// 1. Who is this token?
const who = await api('GET', '/user')
if (who.status !== 200) {
  log(`GET /user failed: HTTP ${who.status} ${who.text.slice(0, 200)}`)
  process.exit(1)
}
log(`authenticated as ${who.json.login}`)
if (who.json.login.toLowerCase() !== OWNER.toLowerCase()) {
  log(`WARNING: token belongs to ${who.json.login}, expected ${OWNER}`)
}

// 2. Create the repository (idempotent: an existing one is reused).
let created = await api('POST', '/user/repos', {
  name: REPO,
  description: DESCRIPTION,
  private: privateRepo,
  has_issues: true,
  has_wiki: false,
  has_projects: false,
  auto_init: false,
})
if (created.status === 201) {
  log(`created repository (${privateRepo ? 'private' : 'public'})`)
} else if (created.status === 422 && /already exists/i.test(created.text)) {
  log('repository already exists, reusing it')
  created = { json: { full_name: `${OWNER}/${REPO}`, html_url: `https://github.com/${OWNER}/${REPO}` } }
} else {
  log(`POST /user/repos failed: HTTP ${created.status} ${created.text.slice(0, 300)}`)
  process.exit(1)
}

// 3. Discovery topic — the ecosystem's only built-in discovery channel.
const topics = await api('PUT', `/repos/${OWNER}/${REPO}/topics`, { names: [TOPIC, 'deepseek-harness', 'balance'] })
log(topics.status === 200 ? `topics set: ${topics.json.names.join(', ')}` : `topics failed: HTTP ${topics.status}`)

// 4. Add the remote (auth comes from the credential helper, so no secret in the URL).
try {
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${OWNER}/${REPO}.git`], { cwd: repoRoot, stdio: 'pipe' })
} catch {
  log('origin already configured')
}

// 5. Push main.
try {
  const push = execFileSync('git', ['push', '-u', 'origin', 'main'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  log(push.trim())
} catch (err) {
  log(`push failed: ${err.stderr?.toString() ?? err.message}`)
  process.exit(1)
}

process.stdout.write(`${created.json.html_url ?? ''}\n`)
