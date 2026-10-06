// node --test gateway-edge/test — hermes-hq-connect against a simulated computer: a fresh one, a finished one, and
// each thing a person has to fix first. Nothing here runs a real command.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setup, off, status, nousAccount, hermesBackends, choosePort, publicUrl, connectLink } from '../hermes-hq-connect.mjs'

const HOME = '/Users/new'
const jwt = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'x'.repeat(120)].join('.')
const EDGE_SOURCE = fs.readFileSync(fileURLToPath(new URL('../hermes-hq-edge.mjs', import.meta.url)), 'utf8')

/** A computer: files, processes, Tailscale and Hermes as the tool would find them, and a record of what it did. */
function machine({ hermes = true, running = true, nous = true, tailscale = 'running', https = true, funnelAllowed = true, serve = {}, env = '', launchAgent = true, platform = 'darwin', hermesStarts = true, old = null, newEdgeStarts = true } = {}) {
  const files = new Map(), ran = [], logs = [], loaded = new Set(old ? ['com.dispatch.edge'] : [])
  let backendNous = env.includes('OAUTH_CLIENT_ID'), funnel = { ...serve }
  const label = (target) => target.split('/').pop().replace(/\.plist$/, '')
  if (old) {
    files.set(`${HOME}/.config/dispatch-edge/config.json`, JSON.stringify(old.config))
    files.set(`${HOME}/.config/dispatch-edge/dispatch-edge.mjs`, 'old edge')
    files.set(`${HOME}/Library/LaunchAgents/com.dispatch.edge.plist`, '<string>com.dispatch.edge</string>')
  }
  const edgeLoaded = () => loaded.has('com.hermes-hq.edge') || loaded.has('com.dispatch.edge')
  if (nous) files.set(`${HOME}/.hermes/auth.json`, JSON.stringify({ providers: { nous: { access_token: jwt({ sub: 'user_owner', iss: 'https://portal.nousresearch.com' }) } } }))
  files.set(`${HOME}/.hermes/.env`, env)
  if (launchAgent) files.set(`${HOME}/Library/LaunchAgents/ai.hermes.serve.plist`, '<key>Label</key><string>ai.hermes.serve</string><string>/x/bin/hermes</string><string>serve</string><string>9119</string>')
  const deps = {
    home: HOME, uid: 501, node: '/usr/local/bin/node', platform, path: '/opt/homebrew/bin:/usr/bin:/bin',
    which: (name) => (name === 'hermes' && hermes ? '/x/bin/hermes' : name === 'tailscale' && tailscale ? '/x/bin/tailscale' : ''),
    exists: (p) => files.has(p) || p.endsWith('hermes-hq-edge.mjs') && !p.startsWith(HOME),
    read: (p) => { if (p.endsWith('hermes-hq-edge.mjs') && !p.startsWith(HOME)) return EDGE_SOURCE; if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) },
    write: (p, text) => files.set(p, text),
    copy: (from, to) => files.set(to, EDGE_SOURCE),
    remove: (p) => files.delete(p),
    sleep: async () => {},
    log: (line = '') => logs.push(line),
    fetchJson: async (url) => {
      if (url.includes(':9119/api/status')) return running ? { status: 200, body: { auth_required: backendNous, auth_providers: backendNous ? ['nous'] : [], auth_flows: backendNous ? ['cookie', 'native_pkce'] : ['cookie'] } } : { status: 0, body: null }
      if (url.includes(':9139/api/status')) return edgeLoaded() && (newEdgeStarts || !loaded.has('com.hermes-hq.edge')) ? { status: 200, body: {} } : { status: 0, body: null }
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
        if (label(args[2]) === 'com.hermes-hq.hermes') running = hermesStarts
        return { status: 0 }
      }
      if (cmd === '/bin/launchctl' && args[0] === 'bootout') { loaded.delete(label(args[1])); if (label(args[1]) === 'com.hermes-hq.hermes') running = false; return { status: 0 } }
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
  return { deps, files, ran, logs, state: () => ({ backendNous, edgeLoaded: edgeLoaded(), jobs: [...loaded].filter((l) => l.endsWith('.edge')), hermesLoaded: loaded.has('com.hermes-hq.hermes'), running, funnel }) }
}

test('a fresh computer: registers, restarts Hermes, installs the gatekeeper with its own Nous account, opens Funnel, shows the QR', async () => {
  const m = machine()
  const result = await setup(m.deps)
  assert.equal(result.url, 'https://new-mac.tail1.ts.net') // 443 was free: the plain address
  assert.ok(m.ran.some((c) => c === '/x/bin/hermes dashboard register --name New Mac --redirect-uri https://new-mac.tail1.ts.net/auth/callback'))
  assert.ok(m.ran.includes('/bin/launchctl kickstart -k gui/501/ai.hermes.serve'))
  const config = JSON.parse(m.files.get(`${HOME}/.config/hermes-hq-edge/config.json`))
  assert.deepEqual(config, { listen: { host: '127.0.0.1', port: 9139 }, upstream: 'http://127.0.0.1:9119', owners: ['user_owner'] })
  assert.ok(m.ran.includes('/x/bin/tailscale funnel --bg --https=443 http://127.0.0.1:9139'))
  const plist = m.files.get(`${HOME}/Library/LaunchAgents/com.hermes-hq.edge.plist`)
  assert.match(plist, /N="\/usr\/local\/bin\/node"; \[ -x "\$N" \] \|\| N="\$\(command -v node\)"/) // survives a Node update
  assert.match(plist, /\.hermes\/tools\/node-\*\/bin\/node/)
  const out = m.logs.join('\n')
  assert.match(out, /Open in Hermes HQ/)
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
  assert.equal(m.files.has(`${HOME}/.config/hermes-hq-edge/config.json`), false)
  assert.match(m.logs.join('\n'), /would register/)
})

test('not signed in to Nous: opens the Nous sign-in, then carries on', async () => {
  const m = machine({ nous: false })
  await setup(m.deps)
  assert.ok(m.ran.includes('/x/bin/hermes auth add nous'))
  assert.deepEqual(JSON.parse(m.files.get(`${HOME}/.config/hermes-hq-edge/config.json`)).owners, ['user_owner'])
})

test('each thing only a person can do stops with what to do, before anything changes', async () => {
  for (const [opts, message] of [
    [{ hermes: false }, /Hermes isn't installed/],
    [{ platform: 'win32' }, /This setup runs on a Mac or on Linux/],
    [{ tailscale: '' }, /Install Tailscale on this Mac \(not on your phone\)/],
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
  const plist = m.files.get(`${HOME}/Library/LaunchAgents/com.hermes-hq.hermes.plist`)
  // Hermes's argv as launchd runs it, unwrapped: `hermes update` reads ProgramArguments to find launchd backends.
  assert.match(plist, /<array><string>\/x\/bin\/hermes<\/string><string>serve<\/string><string>--port<\/string><string>9119<\/string><\/array>/)
  assert.match(plist, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/)
  assert.ok(m.ran.includes(`/bin/launchctl bootstrap gui/501 ${HOME}/Library/LaunchAgents/com.hermes-hq.hermes.plist`))
  // The restart that turns Nous sign-in on goes through that same job.
  assert.ok(m.ran.includes('/bin/launchctl kickstart -k gui/501/com.hermes-hq.hermes'))
  assert.match(m.logs.join('\n'), /Starting Hermes in the background/)
})

test('a background Hermes that never answers stops with where to look and what to do instead', async () => {
  const m = machine({ running: false, launchAgent: false, hermesStarts: false })
  await assert.rejects(setup(m.deps), /Hermes didn't start in the background\. Its log: .*hermes\.log\. Start it yourself with "hermes serve"/)
  assert.ok(!m.ran.some((c) => /register|funnel --bg/.test(c)))
  // Nothing is left loaded to restart forever.
  assert.equal(m.state().hermesLoaded, false)
  assert.equal(m.files.has(`${HOME}/Library/LaunchAgents/com.hermes-hq.hermes.plist`), false)
})

test('--dry-run with Hermes stopped says it would start it, and starts nothing', async () => {
  const m = machine({ running: false, launchAgent: false })
  await setup(m.deps, { dryRun: true })
  assert.match(m.logs.join('\n'), /would start Hermes in the background/)
  assert.ok(!m.ran.some((c) => /bootstrap|register|kickstart|funnel --bg/.test(c)))
  assert.equal(m.files.has(`${HOME}/Library/LaunchAgents/com.hermes-hq.hermes.plist`), false)
})

test('off also stops the background Hermes this setup started, and removes it', async () => {
  const m = machine({ running: false, launchAgent: false })
  await setup(m.deps)
  await off(m.deps)
  assert.equal(m.state().hermesLoaded, false)
  assert.equal(m.files.has(`${HOME}/Library/LaunchAgents/com.hermes-hq.hermes.plist`), false)
  assert.match(m.logs.join('\n'), /Hermes no longer runs in the background/)
})

test('the last screen says how to connect the phone, and how to type the address instead', async () => {
  const m = machine()
  await setup(m.deps)
  const out = m.logs.join('\n')
  assert.match(out, /Open the Camera on your iPhone and point it at this code/)
  assert.match(out, /Can't scan it\? In Hermes HQ, tap "I already have an address" \(or Add Gateway\) and type: https:\/\/new-mac\.tail1\.ts\.net/)
  assert.match(out, /Keep this Mac on and awake/)
})

// The owner's Mac (and anyone who ran setup before the rename): com.dispatch.edge in ~/.config/dispatch-edge, with
// Funnel already pointing at its port. Running setup again moves it over without losing the allowed accounts.
const OLD = { config: { listen: { host: '127.0.0.1', port: 9139 }, upstream: 'http://127.0.0.1:9119', owners: ['user_owner', 'user_partner'] } }
const finished = { env: 'HERMES_DASHBOARD_OAUTH_CLIENT_ID=agent:abc\nHERMES_DASHBOARD_PUBLIC_URL=https://new-mac.tail1.ts.net:10000\n',
  serve: { TCP: { 10000: { HTTPS: true } }, Web: { 'new-mac.tail1.ts.net:10000': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9139' } } } }, AllowFunnel: { 'new-mac.tail1.ts.net:10000': true } } }

test('an install from before the rename: copies its config, starts the new job, then removes the old one', async () => {
  const m = machine({ ...finished, old: OLD })
  const result = await setup(m.deps)
  assert.equal(result.url, 'https://new-mac.tail1.ts.net:10000', 'same public address')
  assert.deepEqual(JSON.parse(m.files.get(`${HOME}/.config/hermes-hq-edge/config.json`)).owners, ['user_owner', 'user_partner'], 'allowed accounts carry over')
  assert.deepEqual(m.state().jobs, ['com.hermes-hq.edge'])
  const order = m.ran.filter((c) => /launchctl (bootout|bootstrap)/.test(c))
  assert.deepEqual(order, ['/bin/launchctl bootout gui/501/com.dispatch.edge', `/bin/launchctl bootstrap gui/501 ${HOME}/Library/LaunchAgents/com.hermes-hq.edge.plist`])
  assert.equal(m.files.has(`${HOME}/Library/LaunchAgents/com.dispatch.edge.plist`), false, 'old job removed')
  assert.ok(m.files.has(`${HOME}/.config/dispatch-edge/config.json`), 'old folder left alone')
  assert.ok(!m.ran.some((c) => /funnel --bg|register|kickstart/.test(c)), 'Funnel, registration and Hermes untouched')
  const before = m.ran.length
  await setup(m.deps)
  assert.deepEqual(m.ran.slice(before).filter((c) => /bootstrap|bootout|funnel --bg/.test(c)), [], 'a second run changes nothing')
})

test('an install from before the rename stays running when the new gatekeeper does not come up', async () => {
  const m = machine({ ...finished, old: OLD, newEdgeStarts: false })
  await assert.rejects(setup(m.deps), /didn't answer.*com\.dispatch\.edge, is running again/)
  assert.deepEqual(m.state().jobs, ['com.dispatch.edge'])
  assert.ok(m.files.has(`${HOME}/Library/LaunchAgents/com.dispatch.edge.plist`))
})

test('--dry-run on an install from before the rename says it would move it, and changes nothing', async () => {
  const m = machine({ ...finished, old: OLD })
  await setup(m.deps, { dryRun: true })
  assert.match(m.logs.join('\n'), /would move the gatekeeper over to its Hermes HQ name/)
  assert.ok(!m.ran.some((c) => /bootstrap|bootout/.test(c)))
  assert.deepEqual(m.state().jobs, ['com.dispatch.edge'])
})

test('status and off see the gatekeeper from before the rename', async () => {
  const m = machine({ ...finished, old: OLD })
  assert.equal((await status(m.deps)).gatekeeper, true)
  await off(m.deps)
  assert.deepEqual(m.state().jobs, [])
})

// ---- Linux: a server or home box, systemd user services, Tailscale managed by its operator --------------------------

const LHOME = '/home/ubuntu'
const UNITS = `${LHOME}/.config/systemd/user`
/** A Linux computer as the tool would find it: systemd user services, loginctl lingering, Tailscale's operator. */
function linux({ running = true, nous = true, linger = false, lingerWithoutSudo = false, operator = false, systemd = true, hermesStarts = true, units = {} } = {}) {
  const files = new Map(Object.entries(units)), ran = [], logs = [], active = new Set()
  let backendNous = false, funnel = {}, lingering = linger, isOperator = operator
  if (nous) files.set(`${LHOME}/.hermes/auth.json`, JSON.stringify({ providers: { nous: { access_token: jwt({ sub: 'user_owner', iss: 'https://portal.nousresearch.com' }) } } }))
  files.set(`${LHOME}/.hermes/.env`, '')
  const unitOf = (args) => args[args.length - 1]
  const deps = {
    home: LHOME, uid: 1000, user: 'ubuntu', hostname: 'hermes-box.lan', platform: 'linux', node: '/usr/bin/node', path: '/usr/local/bin:/usr/bin:/bin',
    which: (name) => (name === 'hermes' ? `${LHOME}/.local/bin/hermes` : name === 'tailscale' ? '/usr/bin/tailscale' : ''),
    exists: (p) => files.has(p) || p.endsWith('hermes-hq-edge.mjs') && !p.startsWith(LHOME),
    read: (p) => { if (p.endsWith('hermes-hq-edge.mjs') && !p.startsWith(LHOME)) return EDGE_SOURCE; if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) },
    write: (p, text) => files.set(p, text),
    copy: (from, to) => files.set(to, EDGE_SOURCE),
    remove: (p) => files.delete(p),
    sleep: async () => {},
    log: (line = '') => logs.push(line),
    fetchJson: async (url) => {
      if (url.includes(':9119/api/status')) return running ? { status: 200, body: { auth_required: backendNous, auth_providers: backendNous ? ['nous'] : [], auth_flows: backendNous ? ['cookie', 'native_pkce'] : ['cookie'] } } : { status: 0, body: null }
      if (url.includes(':9139/api/status')) return active.has('hermes-hq-edge.service') ? { status: 200, body: {} } : { status: 0, body: null }
      return { status: 0, body: null }
    },
    run: (cmd, args, opts = {}) => {
      ran.push([cmd, ...args].join(' ') + (opts.interactive ? ' [tty]' : ''))
      if (cmd === '/bin/ps') return { status: 0, stdout: running ? `${LHOME}/.local/bin/hermes serve --port 9119\n` : '' }
      if (cmd === '/bin/sh') return { status: 0, stdout: [...files.keys()].filter((k) => k.startsWith(UNITS + '/')).join('\n') }
      if (cmd === 'systemctl') {
        if (!systemd) return { status: 1, stderr: 'Failed to connect to bus' }
        const [, verb] = args
        if (verb === 'show-environment' || verb === 'daemon-reload' || verb === 'enable') return { status: 0, stdout: '' }
        if (verb === 'is-active') return { status: active.has(unitOf(args)) ? 0 : 3 }
        if (verb === 'restart') {
          const unit = unitOf(args)
          active.add(unit)
          if (unit === 'hermes-hq-hermes.service') running = hermesStarts
          if (/hermes/.test(unit) && unit !== 'hermes-hq-edge.service') backendNous = files.get(`${LHOME}/.hermes/.env`).includes('OAUTH_CLIENT_ID')
          return { status: 0 }
        }
        if (verb === 'disable') { active.delete(unitOf(args)); if (unitOf(args) === 'hermes-hq-hermes.service') running = false; return { status: 0 } }
      }
      if (cmd === 'loginctl' && args[0] === 'show-user') return { status: 0, stdout: lingering ? 'yes\n' : 'no\n' }
      if (cmd === 'loginctl' && args[0] === 'enable-linger') { if (lingerWithoutSudo) lingering = true; return { status: lingerWithoutSudo ? 0 : 1 } }
      if (cmd === 'sudo' && args[0] === 'loginctl') { lingering = true; return { status: 0 } }
      if (cmd === 'sudo' && args[0] === '/usr/bin/tailscale' && args[1] === 'set') { isOperator = true; return { status: 0 } }
      if (cmd.endsWith('hermes') && args[0] === 'auth') { files.set(`${LHOME}/.hermes/auth.json`, JSON.stringify({ nous: { access_token: jwt({ sub: 'user_owner', iss: 'https://portal.nousresearch.com' }) } })); return { status: 0 } }
      if (cmd.endsWith('hermes') && args[0] === 'dashboard') { files.set(`${LHOME}/.hermes/.env`, `HERMES_DASHBOARD_OAUTH_CLIENT_ID=agent:abc\nHERMES_DASHBOARD_PUBLIC_URL=${args[5].replace('/auth/callback', '')}\n`); return { status: 0 } }
      if (cmd === '/usr/bin/tailscale' && args[0] === 'set') return { status: isOperator ? 0 : 1, stderr: isOperator ? '' : 'Access denied: prefs write access denied' }
      if (cmd === '/usr/bin/tailscale' && args[0] === 'status') return { status: 0, stdout: JSON.stringify({ BackendState: 'Running', CertDomains: ['hermes-box.tail1.ts.net'], Self: { DNSName: 'hermes-box.tail1.ts.net.', Capabilities: ['https://tailscale.com/cap/funnel-ports?ports=443,8443,10000'] } }) }
      // Without operator rights Tailscale won't say what it serves: the tool must not guess a free port.
      if (cmd === '/usr/bin/tailscale' && args[0] === 'serve') return isOperator ? { status: 0, stdout: JSON.stringify(funnel) } : { status: 1, stdout: '', stderr: 'Access denied' }
      if (cmd === '/usr/bin/tailscale' && args[0] === 'funnel' && args[1] === '--bg') {
        if (!isOperator) return { status: 1 }
        const port = args[2].split('=')[1]
        funnel = { TCP: { [port]: { HTTPS: true } }, Web: { [`hermes-box.tail1.ts.net:${port}`]: { Handlers: { '/': { Proxy: args[3] } } } }, AllowFunnel: { [`hermes-box.tail1.ts.net:${port}`]: true } }
        return { status: 0 }
      }
      if (cmd === '/usr/bin/tailscale' && args[0] === 'funnel' && args[2] === 'off') { funnel = {}; return { status: 0 } }
      return { status: 0, stdout: '' }
    },
  }
  return { deps, files, ran, logs, state: () => ({ active, lingering, isOperator, running, funnel }) }
}

test('Linux, fresh: starts Hermes as a systemd user service, keeps it past logout, makes this account Tailscale\'s operator, and finishes with the QR', async () => {
  const m = linux({ running: false })
  const result = await setup(m.deps)
  assert.equal(result.url, 'https://hermes-box.tail1.ts.net')
  const hermesUnit = m.files.get(`${UNITS}/hermes-hq-hermes.service`)
  // Hermes's own argv as ExecStart: `hermes update` finds a systemd backend by its MainPID and restarts that unit.
  assert.match(hermesUnit, /^ExecStart="\/home\/ubuntu\/\.local\/bin\/hermes" "serve" "--port" "9119"$/m)
  assert.match(hermesUnit, /^Environment="PATH=\/usr\/local\/bin:\/usr\/bin:\/bin"$/m)
  assert.match(hermesUnit, /^WantedBy=default\.target$/m)
  assert.ok(m.ran.includes('sudo loginctl enable-linger ubuntu [tty]'))
  assert.ok(m.ran.includes('sudo /usr/bin/tailscale set --operator=ubuntu [tty]'))
  assert.ok(m.ran.some((c) => c.startsWith(`${LHOME}/.local/bin/hermes dashboard register --name hermes-box --redirect-uri https://hermes-box.tail1.ts.net/auth/callback`)))
  assert.ok(m.ran.includes('systemctl --user restart hermes-hq-hermes.service'))
  // The gatekeeper's shell launcher reaches sh intact: systemd's own `$` doubled, quotes escaped.
  const edgeUnit = m.files.get(`${UNITS}/hermes-hq-edge.service`)
  assert.match(edgeUnit, /^ExecStart="\/bin\/sh" "-c" "N=\\"\/usr\/bin\/node\\"; \[ -x \\"\$\$N\\" \]/m)
  assert.match(edgeUnit, /^StandardError=append:\/home\/ubuntu\/\.config\/hermes-hq-edge\/edge\.log$/m)
  assert.deepEqual(JSON.parse(m.files.get(`${LHOME}/.config/hermes-hq-edge/config.json`)).owners, ['user_owner'])
  assert.ok(m.ran.includes('/usr/bin/tailscale funnel --bg --https=443 http://127.0.0.1:9139 [tty]'))
  const out = m.logs.join('\n')
  assert.match(out, /▀/)
  assert.match(out, /Keep this computer on/)
  assert.ok(!out.includes('Mac'), 'no Mac wording on Linux')
})

test('Linux: lingering without a password when the system allows it, and an operator already set asks for nothing', async () => {
  const m = linux({ running: false, lingerWithoutSudo: true, operator: true })
  await setup(m.deps)
  assert.ok(m.ran.includes('loginctl enable-linger ubuntu'))
  assert.ok(!m.ran.some((c) => c.startsWith('sudo ')))
})

test('Linux: the Nous sign-in is a link and a code, for a computer without a screen', async () => {
  const m = linux({ nous: false, running: false })
  await setup(m.deps)
  assert.ok(m.ran.includes(`${LHOME}/.local/bin/hermes auth add nous [tty]`))
  assert.match(m.logs.join('\n'), /open the link below in any browser \(your phone's is fine\), enter the code/)
})

test('Linux: running it again changes nothing', async () => {
  const m = linux({ running: false })
  await setup(m.deps)
  const before = m.ran.length
  await setup(m.deps)
  const second = m.ran.slice(before).filter((c) => /register|restart|enable |funnel --bg|disable|sudo/.test(c))
  assert.deepEqual(second, [])
})

test('Linux: a Hermes the person runs as their own service is restarted through it, not started twice', async () => {
  const own = `${UNITS}/hermes-web.service`
  const m = linux({ units: { [own]: `[Service]\nExecStart=${LHOME}/.local/bin/hermes dashboard --no-open\n` }, operator: true, linger: true })
  await setup(m.deps)
  assert.ok(m.ran.includes('systemctl --user restart hermes-web.service'))
  assert.equal(m.files.has(`${UNITS}/hermes-hq-hermes.service`), false)
})

test('Linux: a Hermes started by hand in a terminal is restarted by the person, who is told so', async () => {
  const m = linux({ operator: true, linger: true })
  await assert.rejects(setup(m.deps), /didn't come back with Nous sign-in on/)
  assert.match(m.logs.join('\n'), /Restart Hermes now \(stop "hermes dashboard" or "hermes serve" and start it again\)/)
  assert.equal(m.files.has(`${UNITS}/hermes-hq-hermes.service`), false)
})

test('Linux: no systemd user session (su, a container) stops before anything changes', async () => {
  const m = linux({ systemd: false, running: false })
  await assert.rejects(setup(m.deps), /systemd user services, which this session can't reach/)
  assert.ok(!m.ran.some((c) => /register|restart|funnel --bg|sudo|enable/.test(c)))
})

test('Linux --dry-run says it would linger, set the operator and start Hermes, and does none of it', async () => {
  const m = linux({ running: false })
  await setup(m.deps, { dryRun: true })
  const out = m.logs.join('\n')
  assert.match(out, /would start Hermes in the background/)
  assert.match(out, /would let your services keep running after you log out/)
  assert.match(out, /would let this account manage Tailscale/)
  assert.ok(!m.ran.some((c) => /sudo|register|restart|funnel --bg|enable-linger/.test(c)))
  assert.equal(m.files.has(`${UNITS}/hermes-hq-hermes.service`), false)
})

test('Linux off: closes the public address, and stops and removes both services', async () => {
  const m = linux({ running: false })
  await setup(m.deps)
  await off(m.deps)
  assert.ok(m.ran.includes('/usr/bin/tailscale funnel --https=443 off'))
  assert.ok(m.ran.includes('systemctl --user disable --now hermes-hq-edge.service'))
  assert.ok(m.ran.includes('systemctl --user disable --now hermes-hq-hermes.service'))
  assert.equal(m.files.has(`${UNITS}/hermes-hq-edge.service`), false)
  assert.equal(m.files.has(`${UNITS}/hermes-hq-hermes.service`), false)
})

/** systemd's own reading of an ExecStart= line (systemd.syntax: quoted words, C escapes, `$$` and `%%`), enough to
 *  prove the words that reach the program are the ones the tool meant. */
function execStartWords(line) {
  const words = []
  let i = 0
  while (i < line.length) {
    while (line[i] === ' ') i++
    if (i >= line.length) break
    let word = ''
    if (line[i] === '"') {
      i++
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\') { word += line[i + 1]; i += 2 } else word += line[i++]
      }
      i++
    } else while (i < line.length && line[i] !== ' ') word += line[i++]
    words.push(word.replace(/\$\$/g, '$').replace(/%%/g, '%'))
  }
  return words
}

test('Linux units: the words systemd hands each program are exactly the tool\'s (quotes, $ and the launcher intact)', async () => {
  const m = linux({ running: false })
  await setup(m.deps)
  const exec = (unit) => /^ExecStart=(.*)$/m.exec(m.files.get(`${UNITS}/${unit}`))[1]
  assert.deepEqual(execStartWords(exec('hermes-hq-hermes.service')), [`${LHOME}/.local/bin/hermes`, 'serve', '--port', '9119'])
  const [sh, flag, script] = execStartWords(exec('hermes-hq-edge.service'))
  assert.deepEqual([sh, flag], ['/bin/sh', '-c'])
  assert.equal(script, `N="/usr/bin/node"; [ -x "$N" ] || N="$(command -v node)"; [ -x "$N" ] || N="$(ls -d "${LHOME}"/.hermes/tools/node-*/bin/node 2>/dev/null | tail -1)"; exec "$N" "${LHOME}/.config/hermes-hq-edge/hermes-hq-edge.mjs" "${LHOME}/.config/hermes-hq-edge/config.json"`)
})
