#!/usr/bin/env node
// Dispatch edge: the only door from a public URL (Tailscale Funnel) to a Mac-hosted Hermes gateway.
//
// Hermes's Nous provider accepts any token Portal mints for this dashboard's client id; it never asks *which*
// Nous account signed in, and the same process also runs the shared username/password login. This process
// sits between Funnel and Hermes and lets through only:
//   - the public probes Dispatch reads before sign-in (/api/health, /api/status);
//   - the RFC 8252 native sign-in, pinned to the Nous provider (/auth/native/authorize, /auth/callback);
//   - the native token and refresh answers, and only when they name an owner's Nous account;
//   - requests carrying an owner's Nous bearer token (checked with Hermes's own /api/auth/me);
//   - WebSocket upgrades carrying a single-use ticket (only an owner's bearer can mint one through here).
// No cookie session, no password login, no session token: cookies are stripped both ways except the one-shot
// PKCE cookie of a sign-in in progress. Nothing secret is ever logged (no query strings, headers or bodies).
//
// No dependencies: node >= 20. Usage: node dispatch-edge.mjs <config.json>   (see README.md)

import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import nodePath from 'node:path'
import { pathToFileURL } from 'node:url'

const PUBLIC_GET = new Set(['/api/health', '/api/status'])
const TOKEN_ROUTES = new Set(['/auth/native/token', '/auth/native/refresh'])
// Dispatch Browser's status list and one bot browser's live view (gateway-plugin/dispatch-browser), like the Bot Screen.
const WS_PATHS = [/^\/api\/ws$/, /^\/api\/display\/ws$/, /^\/api\/audio\/[A-Za-z0-9_\-/]+$/,
  /^\/api\/plugins\/dispatch-browser\/activity$/, /^\/api\/plugins\/dispatch-browser\/sessions\/[0-9a-f]{24}\/watch$/]
const PKCE_COOKIE = /^(__Host-|__Secure-)?hermes_session_pkce$/
// Client headers never forwarded: hop-by-hop, ambient credentials, and anything that claims a client identity.
const DROP_REQUEST = new Set(['host', 'cookie', 'authorization', 'connection', 'keep-alive', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'upgrade', 'forwarded', 'x-real-ip'])
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'set-cookie'])
const MAX_AUTH_BODY = 16 * 1024
const AUTH_CACHE_MS = 60_000
// An upstream that hasn't started answering by then is given up (a stream, once answering, runs as long as it lasts).
const UPSTREAM_ANSWER_MS = 300_000
// Decisions that are the edge working as meant: counted and logged once an hour, not a line per request.
const ROUTINE = new Set(['owner', 'public', 'ws-relayed'])
const SUMMARY_MS = 3_600_000
const LOG_MAX_BYTES = 5 * 1024 * 1024

export function loadConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  return normalizeConfig(raw)
}

export function normalizeConfig(raw) {
  const upstream = new URL(raw.upstream)
  // The gateway's own local address: the edge and Hermes share this Mac, and TLS is Funnel's job.
  if (upstream.protocol !== 'http:') throw new Error("upstream must be the gateway's local http:// address")
  const owners = (raw.owners ?? []).map(String).filter(Boolean)
  return {
    listenHost: raw.listen?.host ?? '127.0.0.1',
    listenPort: Number(raw.listen?.port ?? 9139),
    logFile: raw.logFile ? String(raw.logFile) : null,
    upstream,
    owners: new Set(owners),
    provider: raw.provider ?? 'nous',
    authorizePerIpPer10Min: Number(raw.authorizePerIpPer10Min ?? 12),
    failuresPerIpPerMin: Number(raw.failuresPerIpPerMin ?? 30),
  }
}

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex')

/** A sliding-window counter per key. Each key keeps at most max + 1 times, however hard it's hit (a flood
 *  costs the same memory and work as being one over the limit). */
function limiter(windowMs, max, now) {
  const hits = new Map()
  return {
    hit(key) {
      const t = now(), list = (hits.get(key) ?? []).filter((at) => t - at < windowMs)
      list.push(t); hits.set(key, list.length > max + 1 ? list.slice(-(max + 1)) : list)
      if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((at) => t - at < windowMs)) hits.delete(k)
      return list.length > max
    },
    size(key) { return hits.get(key)?.length ?? 0 },
    over(key) { return (hits.get(key) ?? []).filter((at) => now() - at < windowMs).length >= max },
  }
}

export function createEdge(config, { log = defaultLog, now = () => Date.now() } = {}) {
  const cfg = config.upstream instanceof URL ? config : normalizeConfig(config)
  const upstreamHost = cfg.upstream.host // Hermes refuses any Host but its bound or declared public one.
  const client = http
  const verified = new Map() // sha256(bearer) -> {userId, until}
  const authorizeLimit = limiter(10 * 60_000, cfg.authorizePerIpPer10Min, now)
  // Defence in depth: Hermes's own gate must stay on (a non-loopback bind). A Hermes bound to 127.0.0.1 checks
  // nothing, so the edge would be the only lock: it serves nothing until /api/status says auth_required again.
  let gated = null // null: not yet known
  async function checkGate() {
    const answer = await call('GET', '/api/status')
    let status = null
    try { status = JSON.parse(answer.body.toString('utf8')) } catch {}
    const next = answer.status === 200 && status?.auth_required === true
    if (next !== gated) log({ t: new Date(now()).toISOString(), decision: next ? 'upstream-gated' : 'upstream-gate-off', status: answer.status })
    gated = next
    return gated
  }
  const failureLimit = limiter(60_000, cfg.failuresPerIpPerMin, now)

  function clientIp(req) {
    const peer = req.socket.remoteAddress ?? ''
    const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
    // Funnel connects from loopback and names the real client; anyone else is the client.
    const forwarded = loopback ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : ''
    return forwarded || peer
  }

  // Routine decisions are counted, and logged as one summary line an hour; everything else is a line of its own.
  let routine = {}, routineSince = now()
  function flushRoutine() {
    if (Object.keys(routine).length) log({ t: new Date(now()).toISOString(), decision: 'summary', since: new Date(routineSince).toISOString(), counts: routine })
    routine = {}; routineSince = now()
  }
  function record(req, status, decision, extra = {}) {
    if (now() - routineSince >= SUMMARY_MS) flushRoutine()
    if (ROUTINE.has(decision)) { routine[decision] = (routine[decision] ?? 0) + 1; return }
    log({ t: new Date(now()).toISOString(), ip: clientIp(req), method: req.method, path: pathOf(req.url), status, decision, ...extra })
  }

  function forwardHeaders(req, { bearer = null, cookies = null } = {}) {
    const headers = {}
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase()
      if (DROP_REQUEST.has(lower) || lower.startsWith('x-forwarded-') || lower.startsWith('tailscale-')) continue
      headers[lower] = value
    }
    headers.host = upstreamHost
    if (bearer) headers.authorization = `Bearer ${bearer}`
    if (cookies) headers.cookie = cookies
    return headers
  }

  function responseHeaders(upstream, { keepCookie = () => false } = {}) {
    const headers = {}
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (!DROP_RESPONSE.has(name.toLowerCase())) headers[name] = value
    }
    const cookies = [].concat(upstream.headers['set-cookie'] ?? []).filter((line) => keepCookie(line.split('=')[0].trim()))
    if (cookies.length) headers['set-cookie'] = cookies
    return headers
  }

  function send(res, status, body, extraHeaders = {}) {
    if (res.headersSent) return res.end()
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...extraHeaders })
    res.end(text)
  }

  /** Streams the request to Hermes and its answer back (no cookies either way unless `keepCookie` allows). The
   *  upstream request ends with the client's: a phone that went away doesn't leave Hermes streaming to nobody. */
  function proxy(req, res, { path = req.url, bearer = null, cookies = null, keepCookie, decision }) {
    let answered = false
    const upstreamReq = client.request({ protocol: cfg.upstream.protocol, hostname: cfg.upstream.hostname, port: cfg.upstream.port,
      method: req.method, path, headers: forwardHeaders(req, { bearer, cookies }) }, (upstreamRes) => {
      answered = true
      clearTimeout(waiting)
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders(upstreamRes, { keepCookie }))
      upstreamRes.on('error', () => res.destroy())
      upstreamRes.pipe(res)
      record(req, upstreamRes.statusCode, decision)
    })
    const waiting = setTimeout(() => {
      upstreamReq.destroy()
      send(res, 504, { error: 'upstream_timeout' }); record(req, 504, 'upstream-timeout')
    }, UPSTREAM_ANSWER_MS)
    waiting.unref?.()
    upstreamReq.on('error', () => {
      clearTimeout(waiting)
      if (res.writableEnded) return
      if (answered) return res.destroy()
      send(res, 502, { error: 'upstream_unreachable' }); record(req, 502, 'upstream-error')
    })
    res.on('close', () => { clearTimeout(waiting); if (!res.writableFinished) upstreamReq.destroy() })
    req.pipe(upstreamReq)
  }

  /** One buffered call to Hermes (auth checks and the token routes). */
  function call(method, path, { headers = {}, body = null } = {}) {
    return new Promise((resolve) => {
      const upstreamReq = client.request({ protocol: cfg.upstream.protocol, hostname: cfg.upstream.hostname, port: cfg.upstream.port,
        method, path, headers: { host: upstreamHost, accept: 'application/json', ...headers, ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) } }, (upstreamRes) => {
        const chunks = []
        upstreamRes.on('data', (c) => chunks.push(c))
        upstreamRes.on('end', () => resolve({ status: upstreamRes.statusCode ?? 502, headers: upstreamRes.headers, body: Buffer.concat(chunks) }))
        upstreamRes.on('error', () => resolve({ status: 502, headers: {}, body: Buffer.alloc(0) }))
      })
      upstreamReq.setTimeout(15_000, () => upstreamReq.destroy())
      upstreamReq.on('error', () => resolve({ status: 502, headers: {}, body: Buffer.alloc(0) }))
      if (body) upstreamReq.write(body)
      upstreamReq.end()
    })
  }

  /** {ok, userId} for an owner's live Nous token; {status, error} otherwise. Hermes checks signature, aud, iss and expiry. */
  async function checkBearer(token) {
    const key = sha(token)
    const cached = verified.get(key)
    if (cached && cached.until > now() && cfg.owners.has(cached.userId)) return { ok: true, userId: cached.userId }
    verified.delete(key)
    const answer = await call('GET', '/api/auth/me', { headers: { authorization: `Bearer ${token}` } })
    if (answer.status === 503 || answer.status === 502) return { status: 503, error: 'auth_unavailable' }
    if (answer.status !== 200) return { status: 401, error: 'unauthenticated' }
    let me
    try { me = JSON.parse(answer.body.toString('utf8')) } catch { return { status: 401, error: 'unauthenticated' } }
    if (me.provider !== cfg.provider || !cfg.owners.has(String(me.user_id))) return { status: 403, error: 'not_authorized', userId: String(me.user_id ?? ''), provider: me.provider }
    const expiresAt = Number(me.expires_at) * 1000
    verified.set(key, { userId: String(me.user_id), until: Math.min(now() + AUTH_CACHE_MS, Number.isFinite(expiresAt) ? expiresAt : now()) })
    if (verified.size > 1000) for (const [k, v] of verified) if (v.until <= now()) verified.delete(k)
    return { ok: true, userId: String(me.user_id) }
  }

  function readBody(req, limit) {
    return new Promise((resolve) => {
      const chunks = []; let size = 0
      req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); resolve(null) } else chunks.push(c) })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', () => resolve(null))
    })
  }

  async function tokenRoute(req, res, path) {
    const raw = await readBody(req, MAX_AUTH_BODY)
    if (raw === null) return send(res, 413, { error: 'too_large' })
    let body
    try { body = JSON.parse(raw.toString('utf8') || '{}') } catch { return send(res, 400, { error: 'bad_request' }) }
    // A refresh is only ever asked of the Nous provider: never the password provider's opaque tokens.
    if (path === '/auth/native/refresh') body.provider = cfg.provider
    const answer = await call('POST', path, { body: JSON.stringify(body) })
    if (answer.status !== 200) {
      record(req, answer.status, 'token-refused')
      return send(res, answer.status, safeError(answer))
    }
    let payload
    try { payload = JSON.parse(answer.body.toString('utf8')) } catch { record(req, 502, 'token-bad-answer'); return send(res, 502, { error: 'bad_upstream_answer' }) }
    if (payload.provider !== cfg.provider || !cfg.owners.has(String(payload.user_id))) {
      // The tokens are dropped here and never reach the client; the Nous account id is not a secret.
      record(req, 403, 'not-owner', { provider: payload.provider, user_id: String(payload.user_id ?? '') })
      return send(res, 403, { error: 'not_authorized', detail: "This Nous account isn't allowed on this gateway." })
    }
    record(req, 200, 'token-issued', { user_id: String(payload.user_id) })
    send(res, 200, payload)
  }

  /** Hermes's public status, saying what this door offers: only Nous native sign-in. Dispatch's sign-in form reads it
   *  to show Sign in with Nous alone, never password fields the edge would refuse. */
  async function publicStatus(req, res) {
    const answer = await call('GET', '/api/status')
    let status
    try { status = JSON.parse(answer.body.toString('utf8')) } catch { record(req, 502, 'status-bad-answer'); return send(res, 502, { error: 'bad_upstream_answer' }) }
    if (answer.status === 200 && status && typeof status === 'object') {
      const providers = Array.isArray(status.auth_providers) ? status.auth_providers : []
      status.auth_providers = providers.includes(cfg.provider) ? [cfg.provider] : []
      status.auth_flows = status.auth_providers.length ? ['native_pkce'] : []
    }
    record(req, answer.status, 'public')
    send(res, answer.status, status, { 'cache-control': 'no-store' })
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://edge.invalid')
    const path = url.pathname
    const ip = clientIp(req)
    try {
      if (gated !== true && !(await checkGate())) { record(req, 503, 'upstream-gate-off'); return send(res, 503, { error: 'gateway_auth_gate_off' }) }
      if (req.method === 'GET' && path === '/api/status' && !url.search) return await publicStatus(req, res)
      if (req.method === 'GET' && PUBLIC_GET.has(path) && !url.search) return proxy(req, res, { decision: 'public' })

      if (req.method === 'GET' && path === '/auth/native/authorize') {
        const provider = url.searchParams.get('provider')
        if (provider && provider !== cfg.provider) { record(req, 403, 'provider-blocked'); return send(res, 403, { error: 'provider_not_allowed' }) }
        if (authorizeLimit.hit(ip)) { record(req, 429, 'rate-limited'); return send(res, 429, { error: 'rate_limited' }) }
        url.searchParams.set('provider', cfg.provider) // never the chooser that offers the password form
        return proxy(req, res, { path: url.pathname + url.search, keepCookie: (name) => PKCE_COOKIE.test(name), decision: 'authorize' })
      }

      if (req.method === 'GET' && path === '/auth/callback') {
        const pkce = String(req.headers.cookie ?? '').split(';').map((s) => s.trim()).filter((c) => PKCE_COOKIE.test(c.split('=')[0])).join('; ')
        return proxy(req, res, { cookies: pkce || null, keepCookie: (name) => PKCE_COOKIE.test(name), decision: 'callback' })
      }

      if (req.method === 'POST' && TOKEN_ROUTES.has(path)) {
        if (failureLimit.over(ip)) { record(req, 429, 'rate-limited'); return send(res, 429, { error: 'rate_limited' }) }
        return await tokenRoute(req, res, path)
      }

      const auth = String(req.headers.authorization ?? '')
      const bearer = /^Bearer\s+(\S+)$/i.exec(auth)?.[1]
      if (!bearer || path.startsWith('/auth/') || path === '/login') {
        failureLimit.hit(ip)
        record(req, 401, bearer ? 'route-blocked' : 'no-bearer')
        return send(res, 401, { error: 'unauthenticated' })
      }
      if (failureLimit.over(ip)) { record(req, 429, 'rate-limited'); return send(res, 429, { error: 'rate_limited' }) }
      const check = await checkBearer(bearer)
      if (!check.ok) {
        failureLimit.hit(ip)
        record(req, check.status, check.status === 403 ? 'not-owner' : 'bad-bearer', check.userId ? { user_id: check.userId, provider: check.provider } : {})
        return send(res, check.status, { error: check.error })
      }
      return proxy(req, res, { bearer, decision: 'owner' })
    } catch {
      record(req, 500, 'edge-error')
      send(res, 500, { error: 'edge_error' })
    }
  })

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://edge.invalid')
    const deny = (status, decision) => {
      record(req, status, decision)
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    // A gate seen off (or not yet) is asked again, as HTTP requests do: a Hermes restart doesn't refuse sockets until the next tick.
    socket.on('error', () => socket.destroy())
    if (gated !== true && !(await checkGate().catch(() => false))) return deny(503, 'upstream-gate-off')
    if (!WS_PATHS.some((re) => re.test(url.pathname))) return deny(404, 'ws-path-blocked')
    // Session tokens and the server-internal credential never come from outside; a ticket is the only credential.
    if (url.searchParams.has('token') || url.searchParams.has('internal')) return deny(401, 'ws-credential-blocked')
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
    const hasTicket = url.searchParams.get('ticket') || url.searchParams.get('display_ticket') || /ticket/i.test(protocols)
    if (!hasTicket) return deny(401, 'ws-no-ticket')
    const upstream = net.connect({ host: cfg.upstream.hostname, port: Number(cfg.upstream.port || 80) }, () => {
      const headers = forwardHeaders(req)
      headers.connection = 'Upgrade'; headers.upgrade = req.headers.upgrade ?? 'websocket'
      const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`, ...Object.entries(headers).flatMap(([k, v]) => [].concat(v).map((one) => `${k}: ${one}`))]
      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(socket); socket.pipe(upstream)
      record(req, 'relayed', 'ws-relayed') // Hermes answers the handshake: it consumes the ticket or refuses it
    })
    const close = () => { upstream.destroy(); socket.destroy() }
    upstream.on('error', close); socket.on('error', close)
    upstream.on('close', () => socket.destroy()); socket.on('close', () => upstream.destroy())
  })

  const gateTimer = setInterval(() => { checkGate().catch(() => { gated = false }) }, 60_000)
  gateTimer.unref?.()
  checkGate().catch(() => { gated = false })
  server.on('close', () => { clearInterval(gateTimer); flushRoutine() })
  server.checkGate = checkGate
  server.limits = { authorize: authorizeLimit, failures: failureLimit }
  server.edgeConfig = cfg
  return server
}

function pathOf(raw) { try { return new URL(raw, 'http://edge.invalid').pathname } catch { return '?' } }

/** A refused token answer, reduced to Hermes's error code; never echoes the request. */
function safeError(answer) {
  try {
    const body = JSON.parse(answer.body.toString('utf8'))
    return { error: typeof body.error === 'string' ? body.error : (answer.status === 401 ? 'session_expired' : 'refused'),
      detail: typeof body.detail === 'string' && body.detail.length < 200 ? body.detail : undefined }
  } catch { return { error: answer.status === 401 ? 'session_expired' : 'refused' } }
}

function defaultLog(entry) { process.stderr.write(JSON.stringify(entry) + '\n') }

/** Appends JSON lines to `file`, moving it to `file.1` (replacing the last one) when it reaches `maxBytes`: the log
 *  of an always-on LaunchAgent can't grow forever. */
export function rotatingLog(file, { maxBytes = LOG_MAX_BYTES } = {}) {
  let size = 0
  try { size = fs.statSync(file).size } catch {}
  return (entry) => {
    const line = JSON.stringify(entry) + '\n'
    try {
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) { fs.renameSync(file, file + '.1'); size = 0 }
      fs.appendFileSync(file, line, { mode: 0o600 })
      size += Buffer.byteLength(line)
    } catch { process.stderr.write(line) }
  }
}

/** Where the log goes: the config's `logFile`, or the file launchd sends stderr to when it's edge.log beside the
 *  config (com.dispatch.edge.plist and dispatch-connect set it up that way), written by name so it can rotate. */
export function logTarget(cfg, configFile) {
  if (cfg.logFile) return cfg.logFile
  const beside = nodePath.join(nodePath.dirname(configFile), 'edge.log')
  try {
    const err = fs.fstatSync(2), file = fs.statSync(beside)
    if (err.isFile() && err.ino === file.ino && err.dev === file.dev) return beside
  } catch {}
  return null
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2]
  if (!file) { console.error('usage: node dispatch-edge.mjs <config.json>'); process.exit(64) }
  const cfg = loadConfig(file)
  if (!['127.0.0.1', '::1'].includes(cfg.listenHost)) { console.error('refusing to listen beyond loopback: Funnel is the public side'); process.exit(78) }
  if (cfg.owners.size === 0) console.error('dispatch-edge: no owners configured — every sign-in will be refused (its Nous account id is logged so you can add it)')
  const logFile = logTarget(cfg, file)
  createEdge(cfg, logFile ? { log: rotatingLog(logFile) } : {}).listen(cfg.listenPort, cfg.listenHost, () => {
    console.error(`dispatch-edge: listening on http://${cfg.listenHost}:${cfg.listenPort} → ${cfg.upstream.origin} (${cfg.owners.size} owner${cfg.owners.size === 1 ? '' : 's'})`)
  })
}
