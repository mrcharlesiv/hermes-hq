// node --test gateway-edge/test — dispatch-connect against a simulated computer: a fresh one, a finished one, and
// each thing a person has to fix first. Nothing here runs a real command.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setup, off, nousAccount, hermesBackends, choosePort, publicUrl, connectLink } from '../dispatch-connect.mjs'

const HOME = '/Users/new'
const jwt = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'x'.repeat(120)].join('.')
const EDGE_SOURCE = fs.readFileSync(fileURLToPath(new URL('../dispatch-edge.mjs', import.meta.url)), 'utf8')

/** A computer: files, processes, Tailscale and Hermes as the tool would find them, and a record of what it did. */
function machine({ hermes = true, running = true, nous = true, tailscale = 'running', https = true, funnelAllowed = true, serve = {}, env = '', launchAgent = true, platform = 'darwin', hermesStarts = true } = {}) {
  const files = new Map(), ran = [], logs = [], loaded = new Set()
  let backendNous = env.includes('OAUTH_CLIENT_ID'), funnel = { ...serve }
  const label = (target) => target.split('/').pop().replace(/\.plist$/, '')
  if (nous) files.set(`${HOME}/.hermes/auth.json`, JSON.stringify({ providers: { nous: { access_token: jwt({ sub: 'user_owner', iss: 'https://portal.nousresearch.com' }) } } }))
  files.set(`${HOME}/.hermes/.env`, env)
  if (launchAgent) files.set(`${HOME}/Library/LaunchAgents/ai.hermes.serve.plist`, '<key>Label</key><string>ai.hermes.serve</string><string>/x/bin/hermes</string><string>serve</string><string>9119</string>')
  const deps = {
    home: HOME, uid: 501, node: '/usr/local/bin/node', platform, path: '/opt/homebrew/bin:/usr/bin:/bin',
    which: (name) => (name === 'hermes' && hermes ? '/x/bin/hermes' : name === 'tailscale' && tailscale ? '/x/bin/tailscale' : ''),
    exists: (p) => files.has(p) || p.endsWith('dispatch-edge.mjs') && !p.startsWith(HOME),
    read: (p) => { if (p.endsWith('dispatch-edge.mjs') && !p.startsWith(HOME)) return EDGE_SOURCE; if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) },
    write: (p, text) => files.set(p, text),
    copy: (from, to) => files.set(to, EDGE_SOURCE),
    remove: (p) => files.delete(p),
    sleep: async () => {},
    log: (line = '') => logs.push(line),
    fetchJson: async (url) => {
      if (url.includes(':9119/api/status')) return running ? { status: 200, body: { auth_required: backendNous, auth_providers: backendNous ? ['nous'] : [], auth_flows: backendNous ? ['cookie', 'native_pkce'] : ['cookie'] } } : { status: 0, body: null }
      if (url.includes(':9139/api/status')) return loaded.has('com.dispatch.edge') ? { status: 200, body: {} } : { status: 0, body: null }
      return { status: 0, body: null }
    },
    run: (cmd, args) => {
      ran.push([cmd, ...args].join(' '))
      if (cmd === '/bin/ps') return { status: 0, stdout: running ? "python3 -c sys.argv = ['/x/bin/hermes', 'serve', '--host', '127.0.0.1', '--port', '9119']\n/x/bin/claude --hermes-thing serve\n" : '' }
      if (cmd === '/bin/sh') return { status: 0, stdout: [...files.keys()].filter((k) => k.includes('LaunchAgents/')).join('\n') }
      if (cmd === '/usr/sbin/scutil') return { status: 0, stdout: 'New Mac\n' }
      if (cmd.endsWith('hermes') && args[0] === 'auth') { files.set(`${HOME}/.hermes/auth.json`, JSON.stringify({ nous: { access_token: jwt({ sub: 'user_owner', iss: 'https://portal.nousresearch.com' }) } })); return { status: 0 } }
      if (cmd.endsWith('hermes') && args[0] === 'dashboard') { files.set(`${HOME}/.hermes/.env`, `HERMES_DASHBOARD_OAUTH_CLIENT_ID=agent:abc\nHERMES_DASHBOARD_PUBLIC_URL=${args[5].replace('/auth/callback', '')}\n`); return { status: 0 } }
      if (cmd === '/bin/launchctl' && args[0] === 'kickstart') { backendNous = files.get(`${HOME}/.hermes/.env`).includes('OAUTH_CLIENT_ID'); return { status: 0 } }
      if (cmd === '/bin/launchctl' && args[0] === 'print') return { status: loaded.has(label(args[1])) ? 0 : 113 }
      if (cmd === '/bin/launchctl' && args[0] === 'bootstrap') {
        loaded.add(label(args[2]))
        // The background Hermes answers once launchd starts it (hermesStarts: false, a Hermes that never comes up).
        if (label(args[2]) === 'com.dispatch.hermes') running = hermesStarts
        return { status: 0 }
      }
      if (cmd === '/bin/launchctl' && args[0] === 'bootout') { loaded.delete(label(args[1])); if (label(args[1]) === 'com.dispatch.hermes') running = false; return { status: 0 } }
      if (cmd.endsWith('tailscale') && args[0] === 'status') return { status: 0, stdout: JSON.stringify({ BackendState: tailscale === 'running' ? 'Running' : 'NeedsLogin', CertDomains: https ? ['new-mac.tail1.ts.net'] : [], Self: { DNSName: 'new-mac.tail1.ts.net.', Capabilities: funnelAllowed ? ['https://tailscale.com/cap/funnel-ports?ports=443,8443,10000'] : [] } }) }
      if (cmd.endsWith('tailscale') && args[0] === 'serve') return { status: 0, stdout: JSON.stringify(funnel) }
      if (cmd.endsWith('tailscale') && args[0] === 'funnel' && args[1] === '--bg') {
        const port = args[2].split('=')[1]
        funnel = { TCP: { ...(funnel.TCP ?? {}), [port]: { HTTPS: true } }, Web: { ...(funnel.Web ?? {}), [`new-mac.tail1.ts.net:${port}`]: { Handlers: { '/': { Proxy: args[3] } } } }, AllowFunnel: { ...(funnel.AllowFunnel ?? {}), [`new-mac.tail1.ts.net:${port}`]: true } }
        return { status: 0 }
      }
      if (cmd.endsWith('tailscale') && args[0] === 'funnel' && args[2] === 'off') { funnel = {}; return { status: 0 } }
      return { status: 0, stdout: '' }
    },
  }
  return { deps, files, ran, logs, state: () => ({ backendNous, edgeLoaded: loaded.has('com.dispatch.edge'), hermesLoaded: loaded.has('com.dispatch.hermes'), running, funnel }) }
}

test('a fresh computer: registers, restarts Hermes, installs the gatekeeper with its own Nous account, opens Funnel, shows the QR', async () => {
  const m = machine()
  const result = await setup(m.deps)
  assert.equal(result.url, 'https://new-mac.tail1.ts.net') // 443 was free: the plain address
  assert.ok(m.ran.some((c) => c === '/x/bin/hermes dashboard register --name New Mac --redirect-uri https://new-mac.tail1.ts.net/auth/callback'))
  assert.ok(m.ran.includes('/bin/launchctl kickstart -k gui/501/ai.hermes.serve'))
  const config = JSON.parse(m.files.get(`${HOME}/.config/dispatch-edge/config.json`))
  assert.deepEqual(config, { listen: { host: '127.0.0.1', port: 9139 }, upstream: 'http://127.0.0.1:9119', owners: ['user_owner'] })
  assert.ok(m.ran.includes('/x/bin/tailscale funnel --bg --https=443 http://127.0.0.1:9139'))
  const plist = m.files.get(`${HOME}/Library/LaunchAgents/com.dispatch.edge.plist`)
  assert.match(plist, /N="\/usr\/local\/bin\/node"; \[ -x "\$N" \] \|\| N="\$\(command -v node\)"/) // survives a Node update
  assert.match(plist, /\.hermes\/tools\/node-\*\/bin\/node/)
  const out = m.logs.join('\n')
  assert.match(out, /Open in Dispatch/)
  assert.match(out, /▀/) // the QR
  assert.ok(!out.includes('x'.repeat(120)), 'no token is printed')
})

test('running it again on a finished computer changes nothing', async () => {
  const m = machine()
  await setup(m.deps)
  const before = m.ran.length
  await setup(m.deps)
  const second = m.ran.slice(before).filter((c) => /register|kickstart|bootstrap|funnel --bg|bootout/.test(c))
  assert.deepEqual(second, [])
})

test('--dry-run says what it would do and changes nothing', async () => {
  const m = machine()
  await setup(m.deps, { dryRun: true })
  assert.ok(!m.ran.some((c) => /register|kickstart|bootstrap|funnel --bg/.test(c)))
  assert.equal(m.files.has(`${HOME}/.config/dispatch-edge/config.json`), false)
  assert.match(m.logs.join('\n'), /would register/)
})

test('not signed in to Nous: opens the Nous sign-in, then carries on', async () => {
  const m = machine({ nous: false })
  await setup(m.deps)
  assert.ok(m.ran.includes('/x/bin/hermes auth add nous'))
  assert.deepEqual(JSON.parse(m.files.get(`${HOME}/.config/dispatch-edge/config.json`)).owners, ['user_owner'])
})

test('each thing only a person can do stops with what to do, before anything changes', async () => {
  for (const [opts, message] of [
    [{ hermes: false }, /Hermes isn't installed/],
    [{ platform: 'linux' }, /This setup is for a Mac/],
    [{ tailscale: '' }, /Install Tailscale on this computer \(not on your phone\)/],
    [{ tailscale: 'stopped' }, /not signed in/],
    [{ https: false }, /MagicDNS and HTTPS Certificates/],
  ]) {
    const m = machine(opts)
    await assert.rejects(setup(m.deps), message)
    assert.ok(!m.ran.some((c) => /register|kickstart|bootstrap|funnel --bg/.test(c)), String(message))
  }
})

test('ports: keeps the one already pointing at the gatekeeper, skips ones in use', () => {
  const ts = { funnelPorts: [443, 8443, 10000], serve: { TCP: { 443: {}, 8443: {} }, Web: { 'h:10013': { Handlers: { '/': { Proxy: 'http://127.0.0.1:18789' } } } } } }
  assert.equal(choosePort(ts, 9139), 10000)
  assert.equal(choosePort({ ...ts, serve: { ...ts.serve, Web: { 'h:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9139' } } } } } }, 9139), 8443)
  assert.equal(choosePort({ funnelPorts: [443], serve: { TCP: { 443: {} } } }, 9139), null)
  assert.equal(publicUrl('a.ts.net', 443), 'https://a.ts.net')
  assert.equal(connectLink('https://a.ts.net:10000'), 'hermes://connect?url=https%3A%2F%2Fa.ts.net%3A10000')
})

test('reads only the Nous account id, and ignores tokens from other issuers', () => {
  const m = machine()
  assert.equal(nousAccount(m.deps), 'user_owner')
  m.files.set(`${HOME}/.hermes/auth.json`, JSON.stringify({ nous: { access_token: jwt({ sub: 'evil', iss: 'https://example.com' }) } }))
  assert.equal(nousAccount(m.deps), '')
})

test('finds the real backend in a process list (Python-list launchers, Desktop port 0 skipped)', () => {
  const deps = { run: () => ({ stdout: "python3 -c sys.argv = ['/u/venv/bin/hermes', 'serve', '--host', '100.1.2.3', '--port', '9119']\n/u/hermes serve --host 127.0.0.1 --port 0\n/app/claude --hermes x serve\n" }) }
  assert.deepEqual(hermesBackends(deps), ['100.1.2.3:9119', '127.0.0.1:9119'])
})

test('off: closes the public address and stops the gatekeeper', async () => {
  const m = machine()
  await setup(m.deps)
  await off(m.deps)
  assert.ok(m.ran.includes('/x/bin/tailscale funnel --https=443 off'))
  assert.equal(m.state().edgeLoaded, false)
})

test('Hermes not running: starts `hermes serve` in the background, as a job Hermes\'s own updater restarts, then carries on', async () => {
  const m = machine({ running: false, launchAgent: false })
  const result = await setup(m.deps)
  assert.equal(result.url, 'https://new-mac.tail1.ts.net')
  const plist = m.files.get(`${HOME}/Library/LaunchAgents/com.dispatch.hermes.plist`)
  // Hermes's argv as launchd runs it, unwrapped: `hermes update` reads ProgramArguments to find launchd backends.
  assert.match(plist, /<array><string>\/x\/bin\/hermes<\/string><string>serve<\/string><string>--port<\/string><string>9119<\/string><\/array>/)
  assert.match(plist, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/)
  assert.ok(m.ran.includes(`/bin/launchctl bootstrap gui/501 ${HOME}/Library/LaunchAgents/com.dispatch.hermes.plist`))
  // The restart that turns Nous sign-in on goes through that same job.
  assert.ok(m.ran.includes('/bin/launchctl kickstart -k gui/501/com.dispatch.hermes'))
  assert.match(m.logs.join('\n'), /Starting Hermes in the background/)
})

test('a background Hermes that never answers stops with where to look and what to do instead', async () => {
  const m = machine({ running: false, launchAgent: false, hermesStarts: false })
  await assert.rejects(setup(m.deps), /Hermes didn't start in the background\. Its log: .*hermes\.log\. Start it yourself with "hermes serve"/)
  assert.ok(!m.ran.some((c) => /register|funnel --bg/.test(c)))
  // Nothing is left loaded to restart forever.
  assert.equal(m.state().hermesLoaded, false)
  assert.equal(m.files.has(`${HOME}/Library/LaunchAgents/com.dispatch.hermes.plist`), false)
})

test('--dry-run with Hermes stopped says it would start it, and starts nothing', async () => {
  const m = machine({ running: false, launchAgent: false })
  await setup(m.deps, { dryRun: true })
  assert.match(m.logs.join('\n'), /would start Hermes in the background/)
  assert.ok(!m.ran.some((c) => /bootstrap|register|kickstart|funnel --bg/.test(c)))
  assert.equal(m.files.has(`${HOME}/Library/LaunchAgents/com.dispatch.hermes.plist`), false)
})

test('off also stops the background Hermes this setup started, and removes it', async () => {
  const m = machine({ running: false, launchAgent: false })
  await setup(m.deps)
  await off(m.deps)
  assert.equal(m.state().hermesLoaded, false)
  assert.equal(m.files.has(`${HOME}/Library/LaunchAgents/com.dispatch.hermes.plist`), false)
  assert.match(m.logs.join('\n'), /Hermes no longer runs in the background/)
})

test('the last screen says how to connect the phone, and how to type the address instead', async () => {
  const m = machine()
  await setup(m.deps)
  const out = m.logs.join('\n')
  assert.match(out, /Open the Camera on your iPhone and point it at this code/)
  assert.match(out, /Can't scan it\? In Dispatch, tap "I already have an address" and type: https:\/\/new-mac\.tail1\.ts\.net/)
  assert.match(out, /Keep this Mac on and awake/)
})
