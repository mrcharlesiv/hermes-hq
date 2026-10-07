// node --test gateway-edge/test — the edge against a stand-in Hermes that answers like the real dashboard-auth
// routes (hermes_cli/dashboard_auth/routes.py, middleware.py, web_server_chat.py ticket gate).
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import zlib from 'node:zlib'
import { acceptsGzip, createEdge, logTarget, normalizeConfig, rotatingLog } from '../hermes-hq-edge.mjs'

const OWNER = 'user_owner_123'
const TOKENS = { // bearer -> /api/auth/me answer
  'owner-at': { user_id: OWNER, provider: 'nous', expires_at: Math.floor(Date.now() / 1000) + 900 },
  'stranger-at': { user_id: 'user_someone_else', provider: 'nous', expires_at: Math.floor(Date.now() / 1000) + 900 },
  'fleet-at': { user_id: 'fleet', provider: 'basic', expires_at: Math.floor(Date.now() / 1000) + 900 },
}
const CODES = { // native code -> issued session
  'owner-code': { access_token: 'owner-at', refresh_token: 'owner-rt-1', token_type: 'Bearer', expires_at: 1, provider: 'nous', user_id: OWNER },
  'stranger-code': { access_token: 'stranger-at', refresh_token: 'stranger-rt', token_type: 'Bearer', expires_at: 1, provider: 'nous', user_id: 'user_someone_else' },
  'fleet-code': { access_token: 'fleet-at', refresh_token: 'fleet-rt', token_type: 'Bearer', expires_at: 1, provider: 'basic', user_id: 'fleet' },
}

function fakeHermes({ gated = true } = {}) {
  const seen = []
  const tickets = new Set()
  const state = { gated, streamClosed: false }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body })
      // Like Starlette's JSONResponse: every JSON answer states its length.
      const json = (status, value, headers = {}) => { const text = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers }); res.end(text) }
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
      const me = bearer && TOKENS[bearer]
      switch (url.pathname) {
        case '/api/health': return json(200, { ok: true })
        case '/api/status': return json(200, { auth_required: state.gated, auth_providers: ['basic', 'nous'], auth_flows: ['cookie', 'native_pkce'] })
        case '/api/stream': {
          // A long answer that keeps going until somebody hangs up.
          if (!me) return json(401, { error: 'unauthenticated' })
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          const tick = setInterval(() => res.write('data: tick\n\n'), 20)
          res.on('close', () => { clearInterval(tick); state.streamClosed = true })
          return
        }
        case '/auth/native/authorize':
          return json(302, {}, { location: 'https://portal.example/oauth/authorize?x=1', 'set-cookie': ['hermes_session_pkce=abc; HttpOnly; Path=/', 'hermes_session_at=leak; Path=/'] })
        case '/auth/callback':
          return json(302, {}, { location: 'http://127.0.0.1:5555/callback?code=gw&state=s', 'set-cookie': ['hermes_session_pkce=; Max-Age=0', 'hermes_session_rt=leak'] })
        case '/auth/native/token': {
          const code = JSON.parse(body || '{}').code
          return CODES[code] ? json(200, CODES[code]) : json(400, { detail: 'Invalid or expired authorization code.' })
        }
        case '/auth/native/refresh': {
          const parsed = JSON.parse(body || '{}')
          if (parsed.refresh_token === 'owner-rt-1') return json(200, { ...CODES['owner-code'], refresh_token: 'owner-rt-2' })
          if (parsed.refresh_token === 'fleet-rt') return json(200, CODES['fleet-code'])
          return json(401, { error: 'session_expired', detail: 'Refresh token expired or invalid; start a new sign-in.' })
        }
        case '/auth/password-login': return json(200, { ok: true }, { 'set-cookie': 'hermes_session_at=fleet' })
        case '/api/auth/me': return me ? json(200, { ...me, email: '', display_name: '', org_id: '' }) : json(401, { error: 'unauthenticated' })
        case '/api/auth/ws-ticket': {
          if (!me) return json(401, { error: 'unauthenticated' })
          const ticket = crypto.randomBytes(8).toString('hex'); tickets.add(ticket)
          return json(200, { ticket, ttl_seconds: 30 })
        }
        case '/api/sessions': return me ? json(200, { sessions: [{ id: 's1' }] }, { 'set-cookie': 'hermes_session_at=renewed' }) : json(401, { error: 'unauthenticated' })
        case '/api/env': return me ? json(200, { OPENAI_API_KEY: 'sk-…' }) : json(401, { error: 'unauthenticated' })
        // A session list as big as a phone's (rows of titles and previews), for compression.
        case '/api/big': return me ? json(200, { sessions: Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, title: `Chat ${i}`, preview: 'The quick brown fox jumps over the lazy dog. '.repeat(4) })) }) : json(401, { error: 'unauthenticated' })
        default: return json(404, { detail: 'Not Found' })
      }
    })
  })
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x')
    seen.push({ method: 'UPGRADE', path: url.pathname, search: url.search, headers: req.headers })
    const ticket = url.searchParams.get('ticket')
    if (!ticket || !tickets.delete(ticket)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const text = Buffer.from('hello from hermes')
    socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]))
  })
  return { server, seen, tickets, state }
}

async function setup(t, { owners = [OWNER], gated = true, now } = {}) {
  const hermes = fakeHermes({ gated })
  await new Promise((r) => hermes.server.listen(0, '127.0.0.1', r))
  const logs = []
  const edge = createEdge({ upstream: `http://127.0.0.1:${hermes.server.address().port}`, owners }, { log: (e) => logs.push(e), ...(now ? { now } : {}) })
  await new Promise((r) => edge.listen(0, '127.0.0.1', r))
  // Upgraded sockets are no longer the servers' to close: track every connection and end them all.
  const open = new Set()
  for (const server of [edge, hermes.server]) server.on('connection', (socket) => { open.add(socket); socket.on('close', () => open.delete(socket)) })
  t.after(() => { edge.close(); hermes.server.close(); for (const socket of open) socket.destroy() })
  const base = `http://127.0.0.1:${edge.address().port}`
  const fetchEdge = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init })
  return { hermes, edge, base, logs, fetchEdge }
}

const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } })
const post = (body, extra = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) })

test('public probes pass without credentials; nothing else does', async (t) => {
  const { fetchEdge, hermes } = await setup(t)
  assert.equal((await fetchEdge('/api/health')).status, 200)
  const status = await fetchEdge('/api/status')
  assert.equal(status.status, 200)
  // The public door offers Nous native sign-in only, whatever else Hermes serves on the tailnet.
  const body = await status.json()
  assert.deepEqual([body.auth_providers, body.auth_flows, body.auth_required], [['nous'], ['native_pkce'], true])
  for (const path of ['/api/sessions', '/api/env', '/api/auth/me', '/api/auth/ws-ticket', '/api/config', '/', '/login', '/assets/app.js']) {
    const res = await fetchEdge(path)
    assert.equal(res.status, 401, path)
  }
  // None of the refused requests reached Hermes (/api/status is also the edge's own gate check).
  assert.deepEqual([...new Set(hermes.seen.map((r) => r.path))].sort(), ['/api/health', '/api/status'])
})

test('the shared password login and cookie sessions are unreachable', async (t) => {
  const { fetchEdge, hermes } = await setup(t)
  const login = await fetchEdge('/auth/password-login', post({ provider: 'basic', username: 'fleet', password: 'x' }))
  assert.equal(login.status, 401)
  assert.equal(login.headers.get('set-cookie'), null)
  for (const path of ['/auth/login?provider=basic', '/auth/logout', '/login?next=/']) assert.equal((await fetchEdge(path)).status, 401, path)
  // A browser session cookie is no credential here.
  assert.equal((await fetchEdge('/api/sessions', { headers: { cookie: 'hermes_session_at=fleet; hermes_session_rt=fleet' } })).status, 401)
  // The native chooser can never offer the password form: only the Nous provider is asked for.
  assert.equal((await fetchEdge('/auth/native/authorize?provider=basic&code_challenge=c&code_challenge_method=S256&redirect_uri=http://127.0.0.1:1/callback&state=s')).status, 403)
  assert.ok(!hermes.seen.some((r) => r.path === '/auth/password-login'))
})

test('native authorize is pinned to Nous and keeps only the PKCE cookie', async (t) => {
  const { fetchEdge, hermes } = await setup(t)
  const res = await fetchEdge('/auth/native/authorize?code_challenge=c&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2Fcallback&state=s')
  assert.equal(res.status, 302)
  assert.deepEqual(res.headers.getSetCookie(), ['hermes_session_pkce=abc; HttpOnly; Path=/'])
  const forwarded = hermes.seen.at(-1)
  assert.equal(new URLSearchParams(forwarded.search).get('provider'), 'nous')
  // The callback carries only the PKCE cookie in, and no session cookie out.
  const cb = await fetchEdge('/auth/callback?code=c&state=s', { headers: { cookie: 'hermes_session_pkce=abc; hermes_session_rt=old; other=1' } })
  assert.equal(cb.status, 302)
  assert.equal(hermes.seen.at(-1).headers.cookie, 'hermes_session_pkce=abc')
  assert.deepEqual(cb.headers.getSetCookie(), ['hermes_session_pkce=; Max-Age=0'])
})

test('token exchange hands tokens only to an owner', async (t) => {
  const { fetchEdge, logs } = await setup(t)
  const owner = await fetchEdge('/auth/native/token', post({ code: 'owner-code', code_verifier: 'v' }))
  assert.equal(owner.status, 200)
  assert.equal((await owner.json()).access_token, 'owner-at')

  const stranger = await fetchEdge('/auth/native/token', post({ code: 'stranger-code', code_verifier: 'v' }))
  assert.equal(stranger.status, 403)
  const strangerBody = await stranger.text()
  assert.ok(!strangerBody.includes('stranger-at') && !strangerBody.includes('stranger-rt'), 'no token leaks to a non-owner')

  const fleet = await fetchEdge('/auth/native/token', post({ code: 'fleet-code', code_verifier: 'v' }))
  assert.equal(fleet.status, 403)

  const bad = await fetchEdge('/auth/native/token', post({ code: 'nope', code_verifier: 'v' }))
  assert.equal(bad.status, 400)
  // The refused account is named for enrollment; no token, code or verifier is ever logged.
  assert.ok(logs.some((e) => e.decision === 'not-owner' && e.user_id === 'user_someone_else'))
  const logged = JSON.stringify(logs)
  for (const secret of ['owner-at', 'owner-rt-1', 'stranger-at', 'owner-code', 'code_verifier']) assert.ok(!logged.includes(secret), secret)
})

test('refresh rotates for an owner, is pinned to Nous, and expired tokens are refused', async (t) => {
  const { fetchEdge, hermes } = await setup(t)
  const ok = await fetchEdge('/auth/native/refresh', post({ refresh_token: 'owner-rt-1', provider: 'basic' }))
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).refresh_token, 'owner-rt-2')
  assert.equal(JSON.parse(hermes.seen.at(-1).body).provider, 'nous')
  const expired = await fetchEdge('/auth/native/refresh', post({ refresh_token: 'revoked' }))
  assert.equal(expired.status, 401)
  assert.equal((await expired.json()).error, 'session_expired')
  // Even if Hermes rotated a password-provider token, it would not leave the edge.
  assert.equal((await fetchEdge('/auth/native/refresh', post({ refresh_token: 'fleet-rt' }))).status, 403)
})

test('owner bearer reaches the API; strangers, fleet tokens and garbage do not', async (t) => {
  const { fetchEdge, hermes } = await setup(t)
  const ok = await fetchEdge('/api/sessions', bearer('owner-at'))
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('set-cookie'), null, 'no cookie leaves the edge')
  const forwarded = hermes.seen.filter((r) => r.path === '/api/sessions').at(-1)
  assert.equal(forwarded.headers.authorization, 'Bearer owner-at')
  assert.equal(forwarded.headers.cookie, undefined)
  assert.equal((await fetchEdge('/api/env', bearer('stranger-at'))).status, 403)
  assert.equal((await fetchEdge('/api/env', bearer('fleet-at'))).status, 403)
  assert.equal((await fetchEdge('/api/env', bearer('expired-or-forged'))).status, 401)
  assert.ok(!hermes.seen.some((r) => r.path === '/api/env'), 'refused bearers never reach the route')
})

test('removing an owner revokes at once (cache never outlives the allowlist)', async (t) => {
  const { fetchEdge, edge } = await setup(t)
  assert.equal((await fetchEdge('/api/sessions', bearer('owner-at'))).status, 200)
  edge.edgeConfig.owners.delete(OWNER)
  // The positive cache would still say yes for up to 60 s; owners are re-checked on every request.
  assert.equal((await fetchEdge('/api/sessions', bearer('owner-at'))).status, 403)
})

test('websockets need a ticket; tickets come only from an owner bearer', async (t) => {
  const { fetchEdge, base } = await setup(t)
  const wsBase = base.replace('http', 'ws')
  const open = (url, protocols) => new Promise((resolve) => {
    const ws = new WebSocket(url, protocols)
    ws.onmessage = (e) => { resolve({ ok: true, data: String(e.data) }); ws.close() }
    ws.onerror = () => resolve({ ok: false })
  })
  assert.equal((await open(`${wsBase}/api/ws`)).ok, false, 'no credential')
  assert.equal((await open(`${wsBase}/api/ws?token=legacy`)).ok, false, 'legacy session token')
  assert.equal((await open(`${wsBase}/api/ws?internal=x&ticket=y`)).ok, false, 'internal credential')
  assert.equal((await open(`${wsBase}/api/pty?ticket=x`)).ok, false, 'path outside the allowlist')
  assert.equal((await open(`${wsBase}/api/ws?ticket=forged`)).ok, false, 'forged ticket (Hermes refuses)')
  assert.equal((await fetchEdge('/api/auth/ws-ticket', { method: 'POST', ...bearer('stranger-at') })).status, 403)
  const minted = await (await fetchEdge('/api/auth/ws-ticket', { method: 'POST', ...bearer('owner-at') })).json()
  const live = await open(`${wsBase}/api/ws?ticket=${minted.ticket}`)
  assert.deepEqual(live, { ok: true, data: 'hello from hermes' })
  assert.equal((await open(`${wsBase}/api/ws?ticket=${minted.ticket}`)).ok, false, 'a ticket is single-use')
})

test('the browser plugin status and watch sockets pass with a ticket, under its new and old names; nothing else under the plugin does', async (t) => {
  const { fetchEdge, base } = await setup(t)
  const wsBase = base.replace('http', 'ws')
  const open = (url) => new Promise((resolve) => {
    const ws = new WebSocket(url)
    ws.onmessage = (e) => { resolve({ ok: true, data: String(e.data) }); ws.close() }
    ws.onerror = () => resolve({ ok: false })
  })
  const ticket = async () => (await (await fetchEdge('/api/auth/ws-ticket', { method: 'POST', ...bearer('owner-at') })).json()).ticket
  for (const plugin of ['hermes-hq-browser', 'dispatch-browser']) {
    assert.deepEqual(await open(`${wsBase}/api/plugins/${plugin}/activity?profile=sam&ticket=${await ticket()}`), { ok: true, data: 'hello from hermes' }, plugin)
    assert.deepEqual(await open(`${wsBase}/api/plugins/${plugin}/sessions/0123456789abcdef01234567/watch?ticket=${await ticket()}`), { ok: true, data: 'hello from hermes' }, plugin)
    assert.equal((await open(`${wsBase}/api/plugins/${plugin}/activity`)).ok, false, 'still needs a ticket')
    assert.equal((await open(`${wsBase}/api/plugins/${plugin}/sessions/../watch?ticket=${await ticket()}`)).ok, false, 'not a browser id')
    assert.equal((await open(`${wsBase}/api/plugins/${plugin}/extension?ticket=${await ticket()}`)).ok, false, 'other plugin paths stay closed')
  }
  assert.equal((await open(`${wsBase}/api/plugins/other-browser/activity?ticket=${await ticket()}`)).ok, false, 'only the browser plugin')
})

test('with no owners configured every sign-in is refused', async (t) => {
  const { fetchEdge } = await setup(t, { owners: [] })
  assert.equal((await fetchEdge('/auth/native/token', post({ code: 'owner-code', code_verifier: 'v' }))).status, 403)
  assert.equal((await fetchEdge('/api/sessions', bearer('owner-at'))).status, 403)
})

test('repeated bad bearers from one address are throttled before reaching Hermes', async (t) => {
  const { fetchEdge, hermes } = await setup(t)
  for (let i = 0; i < 30; i++) await fetchEdge('/api/sessions', bearer('garbage-' + i))
  const before = hermes.seen.length
  assert.equal((await fetchEdge('/api/sessions', bearer('garbage-x'))).status, 429)
  assert.equal(hermes.seen.length, before)
})

test("a Hermes whose own auth gate is off is never served (loopback bind)", async (t) => {
  const { fetchEdge, base } = await setup(t, { gated: false })
  assert.equal((await fetchEdge('/api/status')).status, 503)
  assert.equal((await fetchEdge('/api/sessions', bearer('owner-at'))).status, 503)
  assert.equal((await fetchEdge('/auth/native/token', post({ code: 'owner-code', code_verifier: 'v' }))).status, 503)
  const ws = await new Promise((resolve) => { const s = new WebSocket(base.replace('http', 'ws') + '/api/ws?ticket=x'); s.onopen = () => resolve(true); s.onerror = () => resolve(false) })
  assert.equal(ws, false)
})

test('routine requests are counted in an hourly summary line, not logged one by one (X-15)', async (t) => {
  let clock = Date.now()
  const { fetchEdge, logs } = await setup(t, { now: () => clock })
  for (let i = 0; i < 5; i++) assert.equal((await fetchEdge('/api/sessions', bearer('owner-at'))).status, 200)
  await fetchEdge('/api/health')
  assert.equal((await fetchEdge('/api/env', bearer('stranger-at'))).status, 403)
  assert.ok(!logs.some((e) => e.decision === 'owner' || e.decision === 'public'), 'no line per routine request')
  assert.ok(logs.some((e) => e.decision === 'not-owner'), 'refusals are still a line each')
  clock += 3_600_000
  await fetchEdge('/api/health')
  const summary = logs.find((e) => e.decision === 'summary')
  assert.deepEqual(summary.counts, { owner: 5, public: 1 }) // the request that flushed it starts the next hour
})

test('the log rotates instead of growing forever, and the launchd file is found (X-15)', () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'edge-log-'))
  const file = nodePath.join(dir, 'edge.log')
  const log = rotatingLog(file, { maxBytes: 200 })
  for (let i = 0; i < 10; i++) log({ i, decision: 'not-owner', path: '/api/env' })
  assert.ok(fs.statSync(file).size <= 200)
  assert.ok(fs.existsSync(file + '.1'))
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line).i).at(-1), 9)
  assert.equal(logTarget(normalizeConfig({ upstream: 'http://127.0.0.1:9119', logFile: file }), nodePath.join(dir, 'config.json')), file)
  // stderr here isn't that file, so nothing is guessed.
  assert.equal(logTarget(normalizeConfig({ upstream: 'http://127.0.0.1:9119' }), nodePath.join(dir, 'config.json')), null)
})

test('a client that hangs up ends the upstream request (X-16)', async (t) => {
  const { base, hermes } = await setup(t)
  const controller = new AbortController()
  const response = await fetch(base + '/api/stream', { ...bearer('owner-at'), signal: controller.signal })
  const reader = response.body.getReader()
  await reader.read()
  controller.abort()
  const deadline = Date.now() + 3000
  while (!hermes.state.streamClosed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  assert.equal(hermes.state.streamClosed, true)
})

test('a socket upgrade asks again about a gate it last saw off (X-16)', async (t) => {
  const { fetchEdge, base, edge, hermes } = await setup(t)
  const minted = await (await fetchEdge('/api/auth/ws-ticket', { method: 'POST', ...bearer('owner-at') })).json()
  hermes.state.gated = false
  assert.equal(await edge.checkGate(), false) // the 60 s timer catches Hermes restarting
  hermes.state.gated = true
  const live = await new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/ws?ticket=${minted.ticket}`)
    ws.onmessage = (e) => { resolve(String(e.data)); ws.close() }
    ws.onerror = () => resolve(null)
  })
  assert.equal(live, 'hello from hermes')
})

test('a flood from one address keeps a bounded list (X-17)', async (t) => {
  const { fetchEdge, edge } = await setup(t)
  for (let i = 0; i < 40; i++) await fetchEdge('/api/sessions')
  assert.ok(edge.limits.failures.size('127.0.0.1') <= edge.edgeConfig.failuresPerIpPerMin + 1)
})

/** One raw request through the edge: status, headers and the undecoded body. */
function raw(base, path, headers = {}, { firstChunk = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + path, { headers }, (res) => {
      const chunks = []
      res.on('data', (c) => { chunks.push(c); if (firstChunk) { req.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }) } })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', (error) => { if (!firstChunk) reject(error) })
  })
}

test('owner answers worth it are gzipped for a client that accepts gzip; nothing else changes (build 205)', async (t) => {
  const { base } = await setup(t)
  const auth = { authorization: 'Bearer owner-at' }
  const plain = await raw(base, '/api/big', auth)
  assert.equal(plain.headers['content-encoding'], undefined, 'no Accept-Encoding: as Hermes sent it')
  const packed = await raw(base, '/api/big', { ...auth, 'accept-encoding': 'gzip, deflate, br' })
  assert.equal(packed.status, 200)
  assert.equal(packed.headers['content-encoding'], 'gzip')
  assert.match(String(packed.headers.vary), /Accept-Encoding/)
  assert.equal(packed.headers['content-length'], undefined, 'the upstream length no longer applies')
  assert.equal(zlib.gunzipSync(packed.body).toString('utf8'), plain.body.toString('utf8'))
  assert.ok(packed.body.length * 3 < plain.body.length, `compressed ${packed.body.length} of ${plain.body.length} bytes`)
  // A small answer, a refused gzip, a stream and a refusal by the edge itself stay plain.
  assert.equal((await raw(base, '/api/sessions', { ...auth, 'accept-encoding': 'gzip' })).headers['content-encoding'], undefined)
  assert.equal((await raw(base, '/api/big', { ...auth, 'accept-encoding': 'gzip;q=0, br' })).headers['content-encoding'], undefined)
  const stream = await raw(base, '/api/stream', { ...auth, 'accept-encoding': 'gzip' }, { firstChunk: true })
  assert.equal(stream.headers['content-encoding'], undefined)
  assert.match(stream.body.toString('utf8'), /data: tick/)
  const refused = await raw(base, '/api/big', { authorization: 'Bearer stranger-at', 'accept-encoding': 'gzip' })
  assert.equal(refused.status, 403)
  assert.equal(refused.headers['content-encoding'], undefined)
})

test('Accept-Encoding is read with its weights (build 205)', () => {
  assert.equal(acceptsGzip('gzip, deflate, br'), true)
  assert.equal(acceptsGzip('br;q=1.0, gzip;q=0.8, *;q=0.1'), true)
  assert.equal(acceptsGzip('gzip;q=0'), false)
  assert.equal(acceptsGzip('br, *;q=0'), false)
  assert.equal(acceptsGzip('*'), true)
  assert.equal(acceptsGzip('identity'), false)
  assert.equal(acceptsGzip(undefined), false)
})

/** A Hermes that resets a reused connection the first time a given path arrives on one: the keep-alive close race. */
async function resettingHermes(t, paths) {
  const seen = []
  const spent = new Set()
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    req.socket.served = (req.socket.served ?? 0) + 1
    seen.push({ path, reused: req.socket.served > 1 })
    if (paths.includes(path) && req.socket.served > 1 && !spent.has(path)) { spent.add(path); return req.socket.destroy() }
    const body = path === '/api/status' ? { auth_required: true, auth_providers: ['nous'], auth_flows: ['native_pkce'] } : { ok: true }
    const text = JSON.stringify(body)
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }); res.end(text)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const logs = []
  const edge = createEdge({ upstream: `http://127.0.0.1:${server.address().port}`, owners: [OWNER] }, { log: (e) => logs.push(e) })
  await new Promise((r) => edge.listen(0, '127.0.0.1', r))
  t.after(() => { edge.close(); server.close(); server.closeAllConnections?.() })
  return { seen, logs, base: `http://127.0.0.1:${edge.address().port}` }
}

test('a read that meets a connection Hermes just closed is sent once more on a fresh one (build 205)', async (t) => {
  const { seen, logs, base } = await resettingHermes(t, ['/api/health'])
  // Warm the edge's pool so the next read goes out on a reused connection.
  assert.equal((await raw(base, '/api/health')).status, 200)
  const second = await raw(base, '/api/health')
  assert.equal(second.status, 200, 'the phone never sees the reset')
  const health = seen.filter((r) => r.path === '/api/health')
  assert.equal(health.length, 3, 'one answered, one reset, one sent again')
  assert.ok(!logs.some((e) => e.decision === 'upstream-error'))
})

test("the edge's own calls (the public status) are sent once more after the same reset (build 205)", async (t) => {
  const { seen, base } = await resettingHermes(t, ['/api/status'])
  assert.equal((await raw(base, '/api/health')).status, 200)
  const status = await raw(base, '/api/status')
  assert.equal(status.status, 200)
  assert.deepEqual(JSON.parse(status.body.toString('utf8')).auth_providers, ['nous'])
  assert.ok(seen.filter((r) => r.path === '/api/status').length >= 2)
})
