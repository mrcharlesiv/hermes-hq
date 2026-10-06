#!/usr/bin/env node
// hermes-hq-connect: one command on the computer that runs Hermes, so Hermes HQ can reach it from anywhere with
// Sign in with Nous, no Tailscale on the phone. It checks each piece and does what's missing:
//
//   1. Hermes is installed and a backend (hermes serve / hermes dashboard) answers.
//   2. Hermes is signed in to Nous on this computer (if not, it opens the Nous sign-in).
//   3. Tailscale is on this computer, signed in, with HTTPS names and Funnel allowed (it says what to click if not).
//   4. The dashboard is registered with Nous for the public address (hermes dashboard register).
//   5. Hermes is restarted so Nous sign-in turns on, and its own sign-in gate is checked.
//   6. hermes-hq-edge (the owner-only gatekeeper) is installed with this computer's Nous account as the owner.
//      An install from before the rename (com.dispatch.edge, ~/.config/dispatch-edge) is moved over: its config is
//      copied, the new job takes its place, and only then is the old job removed (its folder is left as it was).
//   7. Tailscale Funnel points the public address at the gatekeeper, nothing else.
//   8. A QR code for the phone: scanning it opens Hermes HQ with the address filled in.
//
//   node hermes-hq-connect.mjs            set up (or repair) everything; safe to run again
//   node hermes-hq-connect.mjs --dry-run  say what would change, change nothing
//   node hermes-hq-connect.mjs status     what's set up
//   node hermes-hq-connect.mjs off        turn the public address and the gatekeeper off
//
// No dependencies (node >= 20, macOS). Never prints a token: it reads only the Nous account id from Hermes's login.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { qrTerminal } from './qr.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EDGE_LABEL = 'com.hermes-hq.edge'
// The install from before the app was renamed Hermes HQ: adopted, then retired, by setup.
const OLD_EDGE_LABEL = 'com.dispatch.edge'
const DEFAULT_EDGE_PORT = 9139
const FUNNEL_PORTS = [443, 8443, 10000]

/** Everything the tool touches on the computer, so tests can stand in for a fresh or a finished machine. */
export function systemDeps() {
  return {
    home: os.homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : 501,
    node: process.execPath,
    run: (cmd, args, opts = {}) => {
      // A full process list can run to megabytes (some apps have huge command lines): a large buffer, not a truncated read.
      const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: opts.interactive ? 'inherit' : 'pipe', timeout: opts.timeoutMs ?? 120_000, input: opts.input, maxBuffer: 256 * 1024 * 1024 })
      return { status: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
    which: (name) => { const r = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : '' },
    exists: (p) => fs.existsSync(p),
    read: (p) => fs.readFileSync(p, 'utf8'),
    write: (p, text, mode) => { fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 }); fs.writeFileSync(p, text, { mode: mode ?? 0o600 }) },
    remove: (p) => fs.rmSync(p, { force: true }),
    copy: (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 }); fs.copyFileSync(from, to) },
    fetchJson: async (url, timeoutMs = 4000) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } })
        let body = null
        try { body = await r.json() } catch {}
        return { status: r.status, body }
      } catch { return { status: 0, body: null } }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line = '') => process.stdout.write(line + '\n'),
  }
}

// ---- reading the machine -------------------------------------------------------------------------------------

/** The Nous account id (JWT `sub`) of Hermes's own Nous login on this computer, or ''. Only the id leaves here. */
export function nousAccount(deps) {
  const file = path.join(deps.home, '.hermes', 'auth.json')
  if (!deps.exists(file)) return ''
  let data
  try { data = JSON.parse(deps.read(file)) } catch { return '' }
  const found = []
  const walk = (value, trail) => {
    if (typeof value === 'string' && /nous/i.test(trail) && value.split('.').length === 3 && value.length > 100) found.push(value)
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, trail + '/' + k)
  }
  walk(data, '')
  for (const token of found) {
    try {
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
      if (typeof claims.sub === 'string' && claims.sub && /nousresearch\.com/.test(String(claims.iss ?? ''))) return claims.sub
    } catch {}
  }
  return ''
}

export function findHermes(deps) {
  return deps.which('hermes') || [path.join(deps.home, '.hermes/hermes-agent/venv/bin/hermes'), path.join(deps.home, '.local/bin/hermes')].find((p) => deps.exists(p)) || ''
}

export function findTailscale(deps) {
  return deps.which('tailscale') || ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'].find((p) => deps.exists(p)) || ''
}

/** Running Hermes web backends: their bind address from the process list (Desktop's private port-0 ones skipped). */
export function hermesBackends(deps) {
  const ps = deps.run('/bin/ps', ['-axww', '-o', 'command='])
  const found = []
  for (const raw of ps.stdout.split('\n')) {
    // Launchers may show their arguments as a Python list ('serve', '--host', '…'): read them as plain words.
    const line = raw.replace(/[',\[\]"]/g, ' ')
    if (!/(^|\/)hermes(\s|$)/.test(line) || !/\s(serve|dashboard)(\s|$)/.test(line) || /dashboard\s+register/.test(line)) continue
    const host = /--host[ =]+([^\s]+)/.exec(line)?.[1] ?? '127.0.0.1'
    const port = Number(/--port[ =]+(\d+)/.exec(line)?.[1] ?? 9119)
    if (!port) continue
    const address = `${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`
    if (!found.includes(address)) found.push(address)
  }
  if (!found.includes('127.0.0.1:9119')) found.push('127.0.0.1:9119')
  return found
}

/** The LaunchAgent that keeps a backend at `address` running, so it can be restarted for the user, or null. */
export function backendLaunchAgent(deps, address) {
  const dir = path.join(deps.home, 'Library/LaunchAgents')
  const r = deps.run('/bin/sh', ['-c', `ls "${dir}"/*.plist 2>/dev/null`])
  const port = address.split(':').pop()
  for (const file of r.stdout.split('\n').filter(Boolean)) {
    let text = ''
    try { text = deps.read(file) } catch { continue }
    if (/<string>[^<]*hermes<\/string>/.test(text) && /<string>(serve|dashboard)<\/string>/.test(text) && text.includes(`<string>${port}</string>`)) {
      return /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1] ?? null
    }
  }
  return null
}

export function tailscaleState(deps, cli) {
  const status = deps.run(cli, ['status', '--json'], { timeoutMs: 15_000 })
  let json = null
  try { json = JSON.parse(status.stdout) } catch {}
  const self = json?.Self ?? {}
  const caps = [...(self.Capabilities ?? []), ...Object.keys(self.CapMap ?? {})]
  const funnelCap = caps.find((c) => c.includes('funnel-ports'))
  const ports = funnelCap ? (/ports=([\d,]+)/.exec(funnelCap)?.[1] ?? '').split(',').map(Number).filter(Boolean) : []
  const serve = deps.run(cli, ['serve', 'status', '--json'], { timeoutMs: 15_000 })
  let serveJson = {}
  try { serveJson = JSON.parse(serve.stdout || '{}') } catch {}
  return {
    running: json?.BackendState === 'Running',
    dnsName: String(self.DNSName ?? '').replace(/\.$/, ''),
    httpsNames: (json?.CertDomains ?? []).length > 0,
    funnelAllowed: Boolean(funnelCap) || caps.includes('funnel'),
    funnelPorts: ports.length ? ports : FUNNEL_PORTS,
    serve: serveJson,
  }
}

/** The public port: the one already pointing at the gatekeeper, else the first allowed port nothing else uses. */
export function choosePort(ts, edgePort) {
  const web = ts.serve?.Web ?? {}
  for (const [hostPort, conf] of Object.entries(web)) {
    if (Object.values(conf?.Handlers ?? {}).some((h) => h?.Proxy === `http://127.0.0.1:${edgePort}`)) return Number(hostPort.split(':').pop())
  }
  const used = new Set(Object.keys(ts.serve?.TCP ?? {}).map(Number))
  return [443, 8443, 10000].find((p) => ts.funnelPorts.includes(p) && !used.has(p)) ?? null
}

export const publicUrl = (dnsName, port) => `https://${dnsName}${port === 443 ? '' : ':' + port}`
export const connectLink = (url) => `hermes://connect?url=${encodeURIComponent(url)}`

function edgePaths(deps) {
  const dir = path.join(deps.home, '.config', 'hermes-hq-edge')
  return { dir, script: path.join(dir, 'hermes-hq-edge.mjs'), config: path.join(dir, 'config.json'),
    plist: path.join(deps.home, 'Library/LaunchAgents', EDGE_LABEL + '.plist'), log: path.join(dir, 'edge.log') }
}

/** Where the gatekeeper lived before the rename. Its folder is never deleted: it keeps the old logs, and the old
 *  config stays as a backup of the owners list. */
function oldEdgePaths(deps) {
  const dir = path.join(deps.home, '.config', 'dispatch-edge')
  return { dir, config: path.join(dir, 'config.json'), plist: path.join(deps.home, 'Library/LaunchAgents', OLD_EDGE_LABEL + '.plist') }
}

const loadedJob = (deps, label) => deps.run('/bin/launchctl', ['print', `gui/${deps.uid}/${label}`]).status === 0

/** The gatekeeper's config: the current one, else the one from before the rename (so its owners carry over). */
function readEdgeConfig(deps) {
  for (const file of [edgePaths(deps).config, oldEdgePaths(deps).config]) {
    try { return JSON.parse(deps.read(file)) } catch {}
  }
  return null
}

/** An install from before the rename: its job still loaded, or its LaunchAgent file still there. */
function oldInstall(deps) {
  const old = oldEdgePaths(deps)
  const loaded = loadedJob(deps, OLD_EDGE_LABEL)
  return loaded || deps.exists(old.plist) ? { loaded, plist: old.plist } : null
}

/** Starts the gatekeeper with whichever Node is there at the time: this one if it still exists, else one on PATH, else
 *  the newest Node that Hermes ships (~/.hermes/tools/node-<version>, whose folder changes when Hermes updates). */
function nodeLauncher(deps) {
  const hermesNode = `$(ls -d "${deps.home}"/.hermes/tools/node-*/bin/node 2>/dev/null | tail -1)`
  return `N="${deps.node}"; [ -x "$N" ] || N="$(command -v node)"; [ -x "$N" ] || N="${hermesNode}"; exec "$N"`
}

function edgePlist(deps) {
  const p = edgePaths(deps)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${EDGE_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string><string>${nodeLauncher(deps)} "${p.script}" "${p.config}"</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${p.log}</string>
  <key>StandardOutPath</key><string>${path.join(p.dir, 'edge.out')}</string>
</dict>
</plist>
`
}

// ---- the steps -------------------------------------------------------------------------------------------------

class Stop extends Error { constructor(message, code = 2) { super(message); this.code = code } }

export async function setup(deps, { dryRun = false } = {}) {
  const say = (line) => deps.log(line)
  const done = (line) => say('  ✓ ' + line)
  const todo = (line) => say((dryRun ? '  • would ' : '  → ') + line)
  say('Hermes HQ: reach this computer from anywhere\n')

  // 1. Hermes and its backend.
  const hermes = findHermes(deps)
  if (!hermes) throw new Stop('Hermes isn\'t installed on this computer. Install it first: https://hermes-agent.nousresearch.com/docs/')
  done('Hermes is installed')
  let backend = null
  for (const address of hermesBackends(deps)) {
    const r = await deps.fetchJson(`http://${address}/api/status`)
    if (r.status === 200 && r.body && 'auth_required' in r.body) { backend = address; break }
  }
  if (!backend) throw new Stop('Hermes isn\'t running its dashboard. Start it with "hermes dashboard --no-open" (or "hermes serve"), leave it running, then run this again.')
  done(`Hermes is running (${backend})`)

  // 2. Nous sign-in on this computer: its account becomes the gateway's owner.
  let owner = nousAccount(deps)
  if (!owner) {
    if (dryRun) todo('open the Nous sign-in for Hermes on this computer (hermes auth add nous)')
    else {
      say('  → Sign in to Nous: a browser window opens. Come back here when you\'re done.')
      deps.run(hermes, ['auth', 'add', 'nous'], { interactive: true, timeoutMs: 15 * 60_000 })
      owner = nousAccount(deps)
      if (!owner) throw new Stop('Hermes isn\'t signed in to Nous yet. Run "hermes auth add nous", sign in, then run this again.')
    }
  }
  if (owner) done('Hermes is signed in to Nous (that account will be the only one allowed in)')

  // 3. Tailscale on this computer (the phone doesn't need it).
  const cli = findTailscale(deps)
  if (!cli) throw new Stop('Install Tailscale on this computer (not on your phone): https://tailscale.com/download/mac. Open it, sign in, then run this again.')
  const ts = tailscaleState(deps, cli)
  if (!ts.running) throw new Stop('Tailscale is installed but not signed in. Open Tailscale, sign in, then run this again.')
  if (!ts.dnsName || !ts.httpsNames) throw new Stop('Turn on MagicDNS and HTTPS Certificates for your tailnet: https://login.tailscale.com/admin/dns (both are one switch each). Then run this again.')
  done(`Tailscale is on (${ts.dnsName})`)

  const existing = readEdgeConfig(deps)
  const edgePort = existing?.listen?.port ?? DEFAULT_EDGE_PORT
  const port = choosePort(ts, edgePort)
  if (!port) throw new Stop(`All of Funnel's public ports (${ts.funnelPorts.join(', ')}) are already used on this computer. Free one with "tailscale funnel --https=<port> off", then run this again.`)
  const url = publicUrl(ts.dnsName, port)

  // 4. Register with Nous for that address (updates in place when already registered).
  const env = (() => { try { return deps.read(path.join(deps.home, '.hermes/.env')) } catch { return '' } })()
  const registered = /^HERMES_DASHBOARD_OAUTH_CLIENT_ID=agent:/m.test(env) && env.includes(`HERMES_DASHBOARD_PUBLIC_URL=${url}`)
  if (registered) done(`Registered with Nous for ${url}`)
  else if (dryRun) todo(`register this computer with Nous for ${url} (hermes dashboard register)`)
  else {
    todo(`Registering with Nous for ${url}`)
    const name = (deps.run('/usr/sbin/scutil', ['--get', 'ComputerName']).stdout.trim() || 'my-computer').replace(/[^\w .-]/g, '').slice(0, 40)
    const r = deps.run(hermes, ['dashboard', 'register', '--name', name, '--redirect-uri', `${url}/auth/callback`], { interactive: true })
    if (r.status !== 0) throw new Stop('Registering with Nous didn\'t finish (see above). Fix that, then run this again.')
  }

  // 5. Hermes picks up Nous sign-in on restart; its own sign-in gate must be on.
  const status = (await deps.fetchJson(`http://${backend}/api/status`)).body ?? {}
  const nousOn = (status.auth_providers ?? []).includes('nous') && (status.auth_flows ?? []).includes('native_pkce') && status.auth_required === true
  if (nousOn) done('Hermes offers Nous sign-in')
  else {
    const agent = backendLaunchAgent(deps, backend)
    if (dryRun) todo(agent ? `restart Hermes (${agent}) so Nous sign-in turns on — open chats pause for a few seconds` : 'ask you to restart Hermes so Nous sign-in turns on')
    else {
      if (agent) { todo('Restarting Hermes (open chats pause for a few seconds)'); deps.run('/bin/launchctl', ['kickstart', '-k', `gui/${deps.uid}/${agent}`]) }
      else say('  → Restart Hermes now (quit "hermes dashboard" or "hermes serve" and start it again). Waiting for it…')
      let ok = false
      for (let i = 0; i < (agent ? 60 : 300) && !ok; i++) {
        await deps.sleep(2000)
        const s = (await deps.fetchJson(`http://${backend}/api/status`)).body ?? {}
        ok = (s.auth_providers ?? []).includes('nous') && s.auth_required === true
      }
      if (!ok) throw new Stop('Hermes didn\'t come back with Nous sign-in on. Check it started, then run this again.')
      done('Hermes offers Nous sign-in')
    }
  }

  // 6. The gatekeeper, with this computer's Nous account as the owner.
  const p = edgePaths(deps)
  const config = { ...(existing ?? {}), listen: { host: '127.0.0.1', port: edgePort }, upstream: `http://${backend}`,
    owners: [...new Set([...(existing?.owners ?? []), ...(owner ? [owner] : [])])] }
  const edgeSource = path.join(HERE, 'hermes-hq-edge.mjs')
  const current = (() => { try { return JSON.parse(deps.read(p.config)) } catch { return null } })()
  const sameScript = deps.exists(p.script) && deps.read(p.script) === deps.read(edgeSource)
  const sameConfig = current && JSON.stringify(current) === JSON.stringify(config)
  const loaded = loadedJob(deps, EDGE_LABEL)
  const old = oldInstall(deps)
  const restoreOld = () => { if (old?.loaded && deps.exists(old.plist)) deps.run('/bin/launchctl', ['bootstrap', `gui/${deps.uid}`, old.plist]) }
  const retireOld = () => {
    if (!old) return
    if (old.loaded) deps.run('/bin/launchctl', ['bootout', `gui/${deps.uid}/${OLD_EDGE_LABEL}`])
    if (deps.exists(old.plist)) deps.remove(old.plist)
    done(`The gatekeeper's old ${OLD_EDGE_LABEL} job is removed (its folder ~/.config/dispatch-edge is left as it was)`)
  }
  if (sameScript && sameConfig && loaded) {
    if (old && dryRun) todo(`remove the gatekeeper's old ${OLD_EDGE_LABEL} job`)
    else if (old) {
      retireOld()
      // If the old job was the one holding the port, the new one takes it now.
      if (old.loaded) deps.run('/bin/launchctl', ['kickstart', '-k', `gui/${deps.uid}/${EDGE_LABEL}`])
    }
    done('The gatekeeper is running (only your Nous account gets in)')
  } else if (dryRun) {
    if (old) todo(`move the gatekeeper over to its Hermes HQ name (${OLD_EDGE_LABEL} → ${EDGE_LABEL}), keeping its allowed Nous accounts`)
    todo(`install the gatekeeper (owner: this computer's Nous account; upstream ${config.upstream})`)
  } else {
    todo(old ? 'Moving the gatekeeper over to its Hermes HQ name (your allowed Nous accounts carry over)' : 'Installing the gatekeeper')
    deps.copy(edgeSource, p.script)
    deps.write(p.config, JSON.stringify(config, null, 2) + '\n')
    deps.write(p.plist, edgePlist(deps), 0o644)
    // The old and new jobs listen on the same port, the one Funnel points at: the old one stops just before the new
    // one starts (a second or two), and is started again if the new one doesn't come up.
    if (old?.loaded) deps.run('/bin/launchctl', ['bootout', `gui/${deps.uid}/${OLD_EDGE_LABEL}`])
    if (loaded) deps.run('/bin/launchctl', ['bootout', `gui/${deps.uid}/${EDGE_LABEL}`])
    const r = deps.run('/bin/launchctl', ['bootstrap', `gui/${deps.uid}`, p.plist])
    if (r.status !== 0) { restoreOld(); throw new Stop('The gatekeeper didn\'t start: ' + (r.stderr.trim() || 'launchctl refused it')) }
    let up = false
    for (let i = 0; i < 15 && !up; i++) { await deps.sleep(1000); up = (await deps.fetchJson(`http://127.0.0.1:${edgePort}/api/status`)).status === 200 }
    if (!up) {
      if (old?.loaded) { deps.run('/bin/launchctl', ['bootout', `gui/${deps.uid}/${EDGE_LABEL}`]); restoreOld() }
      throw new Stop(`The gatekeeper didn't answer. Its log: ${p.log}` + (old?.loaded ? ` (the old one, ${OLD_EDGE_LABEL}, is running again)` : ''))
    }
    if (old) { old.loaded = false; retireOld() }
    done('The gatekeeper is running (only your Nous account gets in)')
  }

  // 7. Funnel: the public address goes to the gatekeeper only.
  const funnelOn = choosePort(ts, edgePort) === port && (ts.serve?.AllowFunnel ?? {})[`${ts.dnsName}:${port}`] === true
  if (funnelOn) done(`The public address is on: ${url}`)
  else if (dryRun) todo(`turn on the public address ${url} (Tailscale Funnel → the gatekeeper)`)
  else {
    todo(`Turning on the public address ${url}`)
    if (!ts.funnelAllowed) say('    Tailscale may ask you to allow Funnel for this computer: open the link it shows, click Allow, and come back.')
    const r = deps.run(cli, ['funnel', '--bg', `--https=${port}`, `http://127.0.0.1:${edgePort}`], { interactive: true, timeoutMs: 15 * 60_000 })
    if (r.status !== 0) throw new Stop('Tailscale didn\'t turn on the public address (see above). Fix that, then run this again.')
    done(`The public address is on: ${url}`)
  }

  if (dryRun) { say('\nNothing was changed (dry run).'); return { url, dryRun: true } }

  // 8. The phone.
  say('\nNow, on your iPhone: open the Camera, point it at this code, and tap "Open in Hermes HQ".\n')
  say(qrTerminal(connectLink(url)))
  say(`\nThen tap Sign in with Nous. (Or in Hermes HQ, add the gateway ${url})`)
  say('To turn it off later: curl -fsSL https://raw.githubusercontent.com/mrcharlesiv/hermes-hq/main/connect.sh | sh -s -- off')
  return { url, owner: Boolean(owner) }
}

export async function status(deps) {
  const say = (line) => deps.log(line)
  const cfg = readEdgeConfig(deps)
  const cli = findTailscale(deps)
  const ts = cli ? tailscaleState(deps, cli) : null
  const port = ts && cfg ? choosePort(ts, cfg.listen?.port ?? DEFAULT_EDGE_PORT) : null
  const loaded = loadedJob(deps, EDGE_LABEL) || loadedJob(deps, OLD_EDGE_LABEL)
  const funnel = ts && port && (ts.serve?.AllowFunnel ?? {})[`${ts.dnsName}:${port}`] === true
  say(`Gatekeeper: ${loaded ? 'running' : 'off'}${cfg ? ` (${cfg.owners?.length ?? 0} allowed Nous account${cfg.owners?.length === 1 ? '' : 's'})` : ''}`)
  say(`Public address: ${funnel ? publicUrl(ts.dnsName, port) : 'off'}`)
  return { gatekeeper: loaded, url: funnel ? publicUrl(ts.dnsName, port) : null }
}

export async function off(deps) {
  const say = (line) => deps.log(line)
  const cfg = readEdgeConfig(deps)
  const cli = findTailscale(deps)
  if (cli && cfg) {
    const ts = tailscaleState(deps, cli)
    const port = choosePort(ts, cfg.listen?.port ?? DEFAULT_EDGE_PORT)
    if (port && (ts.serve?.AllowFunnel ?? {})[`${ts.dnsName}:${port}`]) { deps.run(cli, ['funnel', `--https=${port}`, 'off']); say(`  ✓ Public address ${publicUrl(ts.dnsName, port)} is off`) }
  }
  for (const label of [EDGE_LABEL, OLD_EDGE_LABEL]) {
    if (loadedJob(deps, label)) { deps.run('/bin/launchctl', ['bootout', `gui/${deps.uid}/${label}`]); say('  ✓ Gatekeeper stopped') }
  }
  say('Your computer is reachable again only the way it was before (Tailscale or your network). Nous registration stays; remove it at https://portal.nousresearch.com/local-dashboards if you like.')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const command = args.find((a) => !a.startsWith('-')) ?? 'setup'
  const deps = systemDeps()
  // An unknown flag (--help, a typo) prints usage instead of running setup.
  const work = args.some((a) => a.startsWith('-') && a !== '--dry-run') ? null : command === 'status' ? status(deps) : command === 'off' ? off(deps) : command === 'setup' ? setup(deps, { dryRun: args.includes('--dry-run') }) : null
  if (!work) { console.error('usage: node hermes-hq-connect.mjs [setup|status|off] [--dry-run]'); process.exit(64) }
  work.catch((error) => {
    if (error instanceof Stop) { console.error('\n' + error.message); process.exit(error.code) }
    console.error('\nSomething went wrong: ' + (error?.message ?? error)); process.exit(1)
  })
}
