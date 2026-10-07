#!/usr/bin/env node
// hermes-hq-connect: one command on the computer that runs Hermes (a Mac, or Linux: a server, a VPS, a home box), so
// Hermes HQ can reach it from anywhere with Sign in with Nous, no Tailscale on the phone. It checks each piece and does
// what's missing:
//
//   1. Hermes is installed, and a backend (hermes serve / hermes dashboard) answers. With none running, it starts
//      `hermes serve` in the background: a LaunchAgent on a Mac, a systemd user service on Linux, both run the way
//      Hermes's own updater knows how to restart.
//   2. Hermes is signed in to Nous on this computer (if not, it starts the Nous sign-in). Hermes says where its folder
//      is (a profile's, HERMES_HOME, or ~/.hermes): its sign-in and settings are read there.
//   3. Tailscale is on this computer, signed in, with HTTPS names and Funnel allowed (it says what to do if not). On
//      Linux without admin rights it installs Tailscale for this account alone (userspace networking, no password).
//   4. The dashboard is registered with Nous for the public address (hermes dashboard register).
//   5. Hermes is restarted so Nous sign-in turns on, and its own sign-in gate is checked.
//   6. hermes-hq-edge (the owner-only gatekeeper) is installed with this computer's Nous account as the owner.
//      An install from before the rename (com.dispatch.edge, ~/.config/dispatch-edge, on a Mac) is moved over: its
//      config is copied, the new job takes its place, and only then is the old job removed (its folder is left as it was).
//   7. Tailscale Funnel points the public address at the gatekeeper, nothing else.
//   8. A QR code for the phone: scanning it opens Hermes HQ with the address filled in.
//
//   node hermes-hq-connect.mjs            set up (or repair) everything; safe to run again
//   node hermes-hq-connect.mjs --dry-run  say what would change, change nothing
//   node hermes-hq-connect.mjs status     what's set up
//   node hermes-hq-connect.mjs off        turn the public address and the gatekeeper off
//   ... --agent                           for Hermes itself to run (and any run without a terminal): it never waits on a
//                                         prompt; a step that needs the person prints NEXT STEP (exit 3) with exactly
//                                         what to relay, and the agent runs it again once that's done, until DONE
//
// No dependencies (node >= 20; macOS, or Linux with systemd). Never prints a token: it reads only the Nous account id
// from Hermes's login.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { qrTerminal } from './qr.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EDGE_LABEL = 'com.hermes-hq.edge'
// The install from before the app was renamed Hermes HQ (a Mac's): adopted, then retired, by setup.
const OLD_EDGE_LABEL = 'com.dispatch.edge'
/** The background Hermes this tool starts when none is running. */
const HERMES_LABEL = 'com.hermes-hq.hermes'
const DEFAULT_EDGE_PORT = 9139
const FUNNEL_PORTS = [443, 8443, 10000]

/** Everything the tool touches on the computer, so tests can stand in for a fresh or a finished machine. */
export function systemDeps() {
  return {
    // The account's own home, where launchd and systemd look for its jobs: Hermes's terminal may run commands with
    // HOME set to a folder of its own.
    home: (() => { try { return os.userInfo().homedir || os.homedir() } catch { return os.homedir() } })(),
    env: process.env,
    arch: process.arch,
    platform: process.platform,
    user: (() => { try { return os.userInfo().username } catch { return process.env.USER ?? '' } })(),
    hostname: os.hostname(),
    path: process.env.PATH ?? '',
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
    copy: (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 }); fs.copyFileSync(from, to) },
    remove: (p) => fs.rmSync(p, { force: true }),
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
    // Hermes running this from its terminal tool has no terminal to prompt in (connect.sh hands one over when there is).
    agent: process.argv.includes('--agent') || !process.stdin.isTTY,
    /** A process that outlives this run (the Nous sign-in waiting for its code), its output to `logFile`. */
    spawnDetached: (cmd, args, logFile) => {
      fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 })
      const out = fs.openSync(logFile, 'w', 0o600)
      // Python block-buffers a file: unbuffered, the link and code are in the log as soon as they're printed.
      const child = spawn(cmd, args, { detached: true, stdio: ['ignore', out, out], env: { ...process.env, PYTHONUNBUFFERED: '1' } })
      child.unref()
      return child.pid
    },
    alive: (pid) => { try { process.kill(pid, 0); return true } catch { return false } },
  }
}

// ---- reading the machine -------------------------------------------------------------------------------------

/** Hermes's own folder as Hermes resolves it (a profile's, HERMES_HOME, or ~/.hermes): where its Nous sign-in and
 *  settings are. Asked, not guessed: Hermes's terminal can run commands with another HOME. */
export function hermesHome(deps, hermes) {
  const r = hermes ? deps.run(hermes, ['config', 'path'], { timeoutMs: 60_000 }) : null
  const file = r?.status === 0 ? String(r.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/') && l.endsWith('config.yaml')).pop() : undefined
  if (file) return path.dirname(file)
  const env = String(deps.env?.HERMES_HOME ?? '').trim()
  return env ? env.replace(/^~(?=\/|$)/, deps.home) : path.join(deps.home, '.hermes')
}

/** The Nous account id (JWT `sub`) of Hermes's own Nous login on this computer, or ''. Only the id leaves here. */
export function nousAccount(deps, home = path.join(deps.home, '.hermes')) {
  const file = path.join(home, 'auth.json')
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

/** This account's own Tailscale when setup installed one (Linux without admin rights), else the computer's. */
export function findTailscale(deps) {
  const own = ownTailscalePaths(deps).cli
  if (deps.platform === 'linux' && deps.exists(own)) return own
  return deps.which('tailscale') ||['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'].find((p) => deps.exists(p)) || ''
}

/** Running Hermes web backends: their bind address from the process list (Desktop's private port-0 ones skipped). */
export function hermesBackends(deps) {
  const ps = deps.run('/bin/ps', deps.platform === 'linux' ? ['-e', '-w', '-w', '-o', 'args='] : ['-axww', '-o', 'command='])
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

// ---- background jobs: LaunchAgents on a Mac, systemd user services on Linux ---------------------------------------

const xml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')
/** One ExecStart word: quoted, with systemd's own `$` (variables) and `%` (specifiers) doubled so they pass through. */
const unitWord = (text) => '"' + String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$').replace(/%/g, '%%') + '"'

/** A job is {argv, env?, out, err}: the gatekeeper's, or Hermes's when this setup started it. `start` (re)loads the
 *  job file already written and says why it failed, or returns null; `backendJob` finds whatever keeps a Hermes backend
 *  on `address` running (this setup's or the person's own), so it can be restarted. */
export function jobManager(deps) {
  return deps.platform === 'linux' ? systemdJobs(deps) : launchdJobs(deps)
}

function launchdJobs(deps) {
  const labels = { edge: EDGE_LABEL, hermes: HERMES_LABEL }, domain = `gui/${deps.uid}`
  const dir = path.join(deps.home, 'Library/LaunchAgents'), file = (job) => path.join(dir, labels[job] + '.plist')
  const loaded = (label) => deps.run('/bin/launchctl', ['print', `${domain}/${label}`]).status === 0
  return {
    file,
    text: (job, spec) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${labels[job]}</string>
  <key>ProgramArguments</key>
  <array>${spec.argv.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
${spec.env ? `  <key>EnvironmentVariables</key>
  <dict>${Object.entries(spec.env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict>
` : ''}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
${spec.throttle ? `  <key>ThrottleInterval</key><integer>${spec.throttle}</integer>
` : ''}  <key>StandardErrorPath</key><string>${xml(spec.err)}</string>
  <key>StandardOutPath</key><string>${xml(spec.out)}</string>
</dict>
</plist>
`,
    loaded: (job) => loaded(labels[job]),
    start(job) {
      if (loaded(labels[job])) deps.run('/bin/launchctl', ['bootout', `${domain}/${labels[job]}`])
      const r = deps.run('/bin/launchctl', ['bootstrap', domain, file(job)])
      return r.status === 0 ? null : (r.stderr.trim() || 'launchctl refused it')
    },
    restart: (job) => deps.run('/bin/launchctl', ['kickstart', '-k', `${domain}/${labels[job]}`]),
    remove(job) { if (loaded(labels[job])) deps.run('/bin/launchctl', ['bootout', `${domain}/${labels[job]}`]); deps.remove(file(job)) },
    backendJob(address) {
      const port = address.split(':').pop()
      for (const plist of deps.run('/bin/sh', ['-c', `ls "${dir}"/*.plist 2>/dev/null`]).stdout.split('\n').filter(Boolean)) {
        let text = ''
        try { text = deps.read(plist) } catch { continue }
        if (/<string>[^<]*hermes<\/string>/.test(text) && /<string>(serve|dashboard)<\/string>/.test(text) && text.includes(`<string>${port}</string>`)) {
          const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1]
          if (label) return { name: label, restart: () => deps.run('/bin/launchctl', ['kickstart', '-k', `${domain}/${label}`]).status === 0 }
        }
      }
      return null
    },
  }
}

function systemdJobs(deps) {
  const units = { edge: 'hermes-hq-edge.service', hermes: 'hermes-hq-hermes.service', tailscale: 'hermes-hq-tailscale.service' }
  const dir = path.join(deps.home, '.config/systemd/user'), file = (job) => path.join(dir, units[job])
  const ctl = (...args) => deps.run('systemctl', ['--user', ...args])
  const titles = { edge: 'Hermes HQ gatekeeper (only your Nous account gets in)', hermes: 'Hermes for Hermes HQ (hermes serve)',
    tailscale: 'Tailscale for Hermes HQ (this account\'s own, no admin rights)' }
  return {
    file,
    text: (job, spec) => `[Unit]
Description=${titles[job]}

[Service]
ExecStart=${spec.argv.map(unitWord).join(' ')}
${spec.env ? Object.entries(spec.env).map(([k, v]) => `Environment=${unitWord(`${k}=${v}`).replace(/\$\$/g, '$')}`).join('\n') + '\n' : ''}Restart=always
RestartSec=10
${spec.out ? `StandardOutput=append:${spec.out}\n` : ''}${spec.err ? `StandardError=append:${spec.err}\n` : ''}
[Install]
WantedBy=default.target
`,
    loaded: (job) => ctl('is-active', '--quiet', units[job]).status === 0,
    start(job) {
      ctl('daemon-reload')
      ctl('enable', units[job])
      const r = ctl('restart', units[job])
      return r.status === 0 ? null : (r.stderr.trim() || 'systemctl refused it')
    },
    restart: (job) => ctl('restart', units[job]),
    remove(job) { ctl('disable', '--now', units[job]); deps.remove(file(job)); ctl('daemon-reload') },
    backendJob(address) {
      const port = Number(address.split(':').pop())
      for (const unit of deps.run('/bin/sh', ['-c', `ls "${dir}"/*.service 2>/dev/null`]).stdout.split('\n').filter(Boolean)) {
        let text = ''
        try { text = deps.read(unit) } catch { continue }
        const exec = /^ExecStart=(.*)$/m.exec(text)?.[1]?.replace(/["']/g, ' ') ?? ''
        if (!/(^|\/)hermes\s/.test(exec) || !/\s(serve|dashboard)(\s|$)/.test(exec)) continue
        if (Number(/--port[ =]+(\d+)/.exec(exec)?.[1] ?? 9119) !== port) continue
        const name = path.basename(unit)
        return { name, restart: () => ctl('restart', name).status === 0 }
      }
      return null
    },
  }
}

/** Linux: user services stop at logout unless lingering is on; it takes a password (sudo) on most systems. */
function keepRunningAfterLogout(deps, say, dryRun) {
  if (deps.platform !== 'linux') return
  if (deps.run('loginctl', ['show-user', deps.user, '--property=Linger', '--value']).stdout.trim() === 'yes') return
  if (dryRun) { say(`  • would let your services keep running after you log out (loginctl enable-linger ${deps.user})`); return }
  if (deps.run('loginctl', ['enable-linger', deps.user]).status === 0) return
  if (deps.agent) {
    // No prompt to answer: passwordless sudo, or a warning the agent passes on (Hermes keeps working while logged in).
    if (deps.run('sudo', ['-n', 'loginctl', 'enable-linger', deps.user]).status === 0) return
  } else {
    say('  → To keep running after you log out, this needs your password once (sudo loginctl enable-linger).')
    if (deps.run('sudo', ['loginctl', 'enable-linger', deps.user], { interactive: true }).status === 0) return
  }
  say(`  ! Hermes and the gatekeeper will stop when you log out. To keep them running, run: sudo loginctl enable-linger ${deps.user}`)
}

/** Linux: Tailscale lets only root or its operator change Serve and Funnel; the operator is set once, with sudo. This
 *  account's own Tailscale is already its to change. */
function tailscaleOperator(deps, cli, say, dryRun) {
  if (deps.platform !== 'linux' || deps.uid === 0 || cli === ownTailscalePaths(deps).cli) return
  if (deps.run(cli, ['set', `--operator=${deps.user}`]).status === 0) return
  if (dryRun) { say(`  • would let this account manage Tailscale (sudo tailscale set --operator=${deps.user})`); return }
  if (deps.agent) {
    if (deps.run('sudo', ['-n', cli, 'set', `--operator=${deps.user}`]).status === 0) return
    throw new NextStep('person', `On the computer running Hermes, run this once in a terminal (it asks for your password), so Hermes may manage Tailscale there: sudo tailscale set --operator=${deps.user}`)
  }
  say('  → Tailscale needs your password once (sudo), so this account can turn on the public address.')
  if (deps.run('sudo', [cli, 'set', `--operator=${deps.user}`], { interactive: true }).status !== 0) {
    throw new Stop(`Tailscale didn't give this account access. Run "sudo tailscale set --operator=${deps.user}", then run this again.`)
  }
}

// ---- Tailscale for this account alone (Linux without admin rights) ------------------------------------------------

/** Tailscale's own static build, kept beside the gatekeeper. `tailscale` here is a two-line wrapper that talks to this
 *  account's tailscaled, so every step uses it the way it uses the computer's. */
function ownTailscalePaths(deps) {
  const dir = path.join(edgePaths(deps).dir, 'tailscale')
  return { dir, bin: path.join(dir, 'bin'), cli: path.join(dir, 'tailscale'), socket: path.join(dir, 'tailscaled.sock'), state: path.join(dir, 'state') }
}

/** tailscaled with userspace networking needs no admin rights; port 0 keeps clear of a system tailscaled's port. Its
 *  chatty output goes to the journal, which rotates it (journalctl --user -u hermes-hq-tailscale). */
function ownTailscaleJob(deps) {
  const t = ownTailscalePaths(deps)
  return { argv: [path.join(t.bin, 'tailscaled'), '--tun=userspace-networking', `--socket=${t.socket}`, `--statedir=${t.state}`, '--port=0'] }
}

const TAILSCALE_ARCH = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386', riscv64: 'riscv64' }

/** Installs (once, checked against Tailscale's checksum) and starts this account's own Tailscale; returns its CLI. */
async function ownTailscale(deps, jobs, say, todo) {
  const t = ownTailscalePaths(deps)
  if (!deps.exists(path.join(t.bin, 'tailscaled'))) {
    const arch = TAILSCALE_ARCH[deps.arch]
    const index = arch ? (await deps.fetchJson('https://pkgs.tailscale.com/stable/?mode=json', 30_000)).body : null
    const tarball = index?.Tarballs?.[arch]
    if (!tarball) throw new Stop(`Couldn't find Tailscale's download for this computer (${deps.arch}). Install Tailscale on it (https://tailscale.com/download/linux), then run this again.`)
    todo(`Installing Tailscale${index.TarballsVersion ? ' ' + index.TarballsVersion : ''} for this account only (no password needed)`)
    const url = `https://pkgs.tailscale.com/stable/${tarball}`, file = path.join(t.dir, tarball)
    deps.run('mkdir', ['-p', t.bin])
    const got = deps.run('curl', ['-fsSL', '--retry', '3', '-o', file, url], { timeoutMs: 10 * 60_000 })
    const want = got.status === 0 ? deps.run('curl', ['-fsSL', '--retry', '3', url + '.sha256'], { timeoutMs: 60_000 }).stdout.trim() : ''
    const have = want ? deps.run('sha256sum', [file]).stdout.trim().split(/\s+/)[0] : ''
    const unpacked = Boolean(have) && have === want && deps.run('tar', ['-xzf', file, '-C', t.bin, '--strip-components=1']).status === 0
    deps.remove(file)
    if (!unpacked) throw new Stop('Downloading Tailscale didn\'t finish (or it didn\'t match Tailscale\'s checksum). Run this again.')
  }
  deps.write(t.cli, `#!/bin/sh\n# This account's own Tailscale (set up by Hermes HQ): the tailscale command, talking to its own tailscaled.\nexec "${path.join(t.bin, 'tailscale')}" --socket="${t.socket}" "$@"\n`, 0o755)
  const text = jobs.text('tailscale', ownTailscaleJob(deps))
  const same = (() => { try { return deps.read(jobs.file('tailscale')) === text } catch { return false } })()
  if (same && jobs.loaded('tailscale')) return t.cli
  keepRunningAfterLogout(deps, say, false)
  deps.write(jobs.file('tailscale'), text, 0o644)
  const failed = jobs.start('tailscale')
  if (failed) throw new Stop('Tailscale didn\'t start: ' + relayable(failed))
  // Ready once it answers on its own socket.
  for (let i = 0; i < 20; i++) {
    try { if ('BackendState' in JSON.parse(deps.run(t.cli, ['status', '--json'], { timeoutMs: 15_000 }).stdout)) return t.cli } catch {}
    await deps.sleep(1000)
  }
  throw new Stop('Tailscale didn\'t start on this computer. Its messages: journalctl --user -u hermes-hq-tailscale. Then run this again.')
}

/** Tailscale's sign-in link while it waits for one: `tailscale up` asks for it, or says the one already waiting. */
function tailscaleSignInLink(deps, cli) {
  const waiting = () => { try { return JSON.parse(deps.run(cli, ['status', '--json'], { timeoutMs: 15_000 }).stdout).AuthURL || '' } catch { return '' } }
  const already = waiting()
  if (already) return already
  const r = deps.run(cli, ['up', '--timeout=15s'], { timeoutMs: 30_000 })
  return /https:\/\/login\.tailscale\.com\/\S+/.exec(r.stdout + r.stderr)?.[0] ?? waiting()
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
  let serveJson = {}, serveRead = serve.status === 0
  try { serveJson = JSON.parse(serve.stdout || '{}') } catch { serveRead = false }
  return {
    running: json?.BackendState === 'Running',
    dnsName: String(self.DNSName ?? '').replace(/\.$/, ''),
    httpsNames: (json?.CertDomains ?? []).length > 0,
    funnelAllowed: Boolean(funnelCap) || caps.includes('funnel'),
    funnelPorts: ports.length ? ports : FUNNEL_PORTS,
    serve: serveJson,
    // What's already served is known: a port is never picked over something the person shares.
    serveRead,
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
  return { dir, script: path.join(dir, 'hermes-hq-edge.mjs'), config: path.join(dir, 'config.json'), log: path.join(dir, 'edge.log') }
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

/** An install from before the rename (only ever on a Mac): its job still loaded, or its LaunchAgent file still there. */
function oldInstall(deps) {
  if ((deps.platform ?? 'darwin') !== 'darwin') return null
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

/** The gatekeeper's job: its stderr is edge.log, which it then rotates itself (dispatch-edge.mjs logTarget). */
function edgeJob(deps) {
  const p = edgePaths(deps)
  return { argv: ['/bin/sh', '-c', `${nodeLauncher(deps)} "${p.script}" "${p.config}"`], out: path.join(p.dir, 'edge.out'), err: p.log }
}

/** `hermes serve` (headless, 127.0.0.1:9119), Hermes's own argv unwrapped: `hermes update` finds a launchd backend by
 *  its ProgramArguments and a systemd one by its MainPID, and restarts it rather than starting a second copy. PATH is
 *  the one this was run with, so the agent's tools find what they find in a terminal; HERMES_HOME is the folder Hermes
 *  said is its own, so the phone reaches this Hermes (its profile, its sign-in), not a fresh one. */
export function hermesJob(deps, hermes, home = path.join(deps.home, '.hermes')) {
  const log = path.join(edgePaths(deps).dir, 'hermes.log')
  return { argv: [hermes, 'serve', '--port', '9119'], env: { PATH: deps.path || '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', HERMES_HOME: home }, out: log, err: log, throttle: 10 }
}

// ---- the steps -------------------------------------------------------------------------------------------------

class Stop extends Error { constructor(message, code = 2) { super(message); this.code = code } }
/** Agent mode: something to do before running again. `forWhom` is 'person' (relay it word for word) or 'agent'. */
export class NextStep extends Stop { constructor(forWhom, message) { super(message, 3); this.forWhom = forWhom } }
/** Another program's words, safe to pass on in a chat: Hermes sends any file named by its full path along with the
 *  message (it once sent a Nous sign-in file that way), so paths become "…". Links are left as they are. */
export const relayable = (text) => String(text ?? '').replace(/(^|[\s"'(=])(?:~\/|\/)[^\s"')]+/g, '$1…').replace(/\s+/g, ' ').trim()
export const nextStepText = (step) => step.forWhom === 'person'
  ? `NEXT STEP for the person (send them this, word for word, then wait until they say it's done):\n  ${step.message}\nThen run this same command again.`
  : `NEXT STEP for you, the agent:\n  ${step.message}\nThen run this same command again.`

/** Root, or sudo that needs no password: the agent can do what would otherwise ask the person for theirs. */
const sudoPrefix = (deps) => deps.uid === 0 ? [] : deps.run('sudo', ['-n', 'true']).status === 0 ? ['sudo', '-n'] : null
const asRoot = (deps, prefix, cmd, args, opts) => prefix.length ? deps.run(prefix[0], [...prefix.slice(1), cmd, ...args], opts) : deps.run(cmd, args, opts)

/** Agent mode: Hermes's own Nous sign-in (a device code) started in the background, so its link and code can be passed
 *  on now and the sign-in finishes while the person approves it. A run while it's still waiting shows the same code. */
function nousSignInForAgent(deps, hermes) {
  const dir = edgePaths(deps).dir, log = path.join(dir, 'nous-sign-in.log'), pidFile = path.join(dir, 'nous-sign-in.pid')
  let pid = 0
  try { pid = Number(deps.read(pidFile)) } catch {}
  if (!pid || !deps.alive(pid)) { pid = deps.spawnDetached(hermes, ['auth', 'add', 'nous'], log); deps.write(pidFile, String(pid)) }
  return { log, pid }
}


export async function setup(deps, { dryRun = false } = {}) {
  const say = (line) => deps.log(line)
  const done = (line) => say('  ✓ ' + line)
  const todo = (line) => say((dryRun ? '  • would ' : '  → ') + line)
  const mac = (deps.platform ?? 'darwin') === 'darwin', linux = deps.platform === 'linux'
  // Windows (outside WSL) has neither LaunchAgents nor systemd: Hermes HQ's Windows steps use Tailscale on the phone.
  if (!mac && !linux) throw new Stop('This setup runs on a Mac or on Linux. For Hermes on Windows, follow Hermes HQ\'s steps for Windows instead: in Hermes HQ, tap Get Started, then Set It Up Myself, then On Windows.')
  const computer = mac ? 'this Mac' : 'this computer'
  const jobs = jobManager(deps)
  // systemd user services keep Hermes and the gatekeeper running; a session without them (su, some containers) can't.
  if (linux && deps.run('systemctl', ['--user', 'show-environment']).status !== 0) {
    throw new Stop('This setup keeps Hermes and its gatekeeper running with systemd user services, which this session can\'t reach. Log in to this computer directly or over SSH (not with su or sudo), then run this again.')
  }
  const agent = Boolean(deps.agent) && !dryRun
  say(`Setting up ${computer} for Hermes HQ. It takes a few minutes; ${agent ? 'a step that needs the person says NEXT STEP' : 'you\'ll be told when to do something'}.\n`)

  // 1. Hermes and its backend: started in the background if none is running.
  const hermes = findHermes(deps)
  if (!hermes) throw new Stop(`Hermes isn't installed on ${computer}. Install it first (https://hermes-agent.nousresearch.com/docs/), then run this again.`)
  done('Hermes is installed')
  // Hermes's own folder (its profile, HERMES_HOME, or ~/.hermes): its sign-in, its settings, and the background
  // Hermes's HERMES_HOME.
  const home = hermesHome(deps, hermes)
  const findBackend = async () => {
    for (const address of hermesBackends(deps)) {
      const r = await deps.fetchJson(`http://${address}/api/status`)
      if (r.status === 200 && r.body && 'auth_required' in r.body) return address
    }
    return null
  }
  let backend = await findBackend()
  // A background Hermes this setup started before it asked Hermes for its folder runs with the default one, not this
  // Hermes's: started again with it.
  const ownJob = (() => { try { return jobs.loaded('hermes') ? deps.read(jobs.file('hermes')) : null } catch { return null } })()
  if (backend && ownJob !== null && !ownJob.includes(`HERMES_HOME=${home}"`) && !ownJob.includes(`<key>HERMES_HOME</key><string>${xml(home)}</string>`)) {
    if (dryRun) todo(`start Hermes in the background again with its own folder (open chats pause for a few seconds)`)
    else {
      todo('Starting Hermes in the background again with its own folder (open chats pause for a few seconds)')
      deps.write(jobs.file('hermes'), jobs.text('hermes', hermesJob(deps, hermes, home)), 0o644)
      const failed = jobs.start('hermes')
      backend = null
      for (let i = 0; i < 60 && !backend && !failed; i++) { await deps.sleep(2000); backend = await findBackend() }
      if (!backend) throw new Stop(`Hermes didn't come back in the background${failed ? ': ' + relayable(failed) : ''}. Its log is hermes.log in ~/.config/hermes-hq-edge. Run this again.`)
    }
  }
  const running = Boolean(backend)
  // A dry run carries on as if Hermes were started at its default address.
  if (!backend && dryRun) {
    todo(`start Hermes in the background (hermes serve), and again whenever ${mac ? 'you log in' : 'this computer starts'}`)
    keepRunningAfterLogout(deps, say, dryRun)
    backend = '127.0.0.1:9119'
  } else if (!backend) {
    todo(`Starting Hermes in the background, so your phone can reach it any time (it starts again when ${mac ? 'you log in' : 'this computer starts'})`)
    keepRunningAfterLogout(deps, say, dryRun)
    deps.write(jobs.file('hermes'), jobs.text('hermes', hermesJob(deps, hermes, home)), 0o644)
    const failed = jobs.start('hermes')
    const yourself = `Start it yourself with "hermes serve" in another ${mac ? 'Terminal window' : 'terminal'}, leave it open, then run this again.`
    if (failed) { jobs.remove('hermes'); throw new Stop(`Hermes didn't start in the background: ${failed}. ${yourself}`) }
    // A first start can take a while (Hermes loads its tools); the log says why if it never answers.
    for (let i = 0; i < 60 && !backend; i++) { await deps.sleep(2000); backend = await findBackend() }
    if (!backend) {
      // Nothing left behind restarting every few seconds (a port taken by something else, say).
      jobs.remove('hermes')
      throw new Stop(`Hermes didn't start in the background. Its log: ${path.join(edgePaths(deps).dir, 'hermes.log')}. ${yourself}`)
    }
  }
  if (running || !dryRun) done(`Hermes is running (${backend})`)

  // 2. Nous sign-in on this computer: its account becomes the gateway's owner. Read from Hermes's own folder.
  let owner = nousAccount(deps, home)
  if (!owner) {
    if (dryRun) todo('start the Nous sign-in for Hermes on this computer (hermes auth add nous)')
    else if (agent) {
      const { log, pid } = nousSignInForAgent(deps, hermes)
      let text = ''
      // Until it shows its link, or ends: a sign-in made earlier (another profile's, or the last run's) is imported
      // without one.
      for (let i = 0; i < 30 && !/Open:\s*https?:\/\//.test(text) && deps.alive(pid); i++) { await deps.sleep(1000); try { text = deps.read(log) } catch {} }
      try { text = deps.read(log) } catch {}
      // The sign-in may have finished in that time (approved, or imported): carry on with its account.
      owner = nousAccount(deps, home)
      if (!owner) {
        const link = /Open:\s*(https?:\/\/\S+)/.exec(text)?.[1], code = /enter code:\s*(\S+)/.exec(text)?.[1]
        if (link && deps.alive(pid)) throw new NextStep('person', `Sign in to Nous for the computer running Hermes: open ${link}${code ? ` and enter the code ${code}` : ''}. Use your own Nous account, the one you'll sign in with in Hermes HQ.`)
        if (deps.alive(pid)) throw new NextStep('agent', 'Hermes\'s Nous sign-in is still starting. Wait a minute, then run this same command again.')
        // What it said, without paths: it names its credentials file, which a chat would send along.
        const said = relayable(text.trim().split('\n').slice(-2).join(' '))
        throw new NextStep('agent', `Hermes's Nous sign-in ended without signing in${said ? ` (it said: ${said})` : ''}. Run this same command again: it starts the sign-in over. If it ends this way twice, tell the person what it said.`)
      }
    } else {
      say(mac ? '  → Sign in to Nous: a browser window opens. Come back here when you\'re done.'
        : '  → Sign in to Nous: open the link below in any browser (your phone\'s is fine), enter the code, then come back here.')
      deps.run(hermes, ['auth', 'add', 'nous'], { interactive: true, timeoutMs: 15 * 60_000 })
      owner = nousAccount(deps, home)
      if (!owner) throw new Stop('Hermes isn\'t signed in to Nous yet. Run "hermes auth add nous", sign in, then run this again.')
    }
  }
  if (owner) done('Hermes is signed in to Nous (that account will be the only one allowed in)')

  // 3. Tailscale on this computer (the phone doesn't need it).
  let cli = findTailscale(deps)
  const ownCli = ownTailscalePaths(deps).cli
  // This account's own Tailscale (set up by an earlier run) is one of this setup's services: kept running.
  if (cli === ownCli && !dryRun) await ownTailscale(deps, jobs, say, todo)
  if (!cli && linux) {
    // Root, or an agent's sudo that needs no password: the usual install. Anyone else: Tailscale for this account alone,
    // which needs no password at all.
    const root = deps.uid === 0 ? [] : agent ? sudoPrefix(deps) : null
    if (dryRun) {
      todo(root ? 'install Tailscale on this computer (tailscale.com/install.sh)' : 'install Tailscale for this account only (no password needed)')
      say('\nNothing was changed (dry run). The rest needs Tailscale: run this without --dry-run to carry on.')
      return { dryRun: true }
    }
    if (root) {
      todo('Installing Tailscale on this computer')
      const r = asRoot(deps, root, '/bin/sh', ['-c', 'curl -fsSL https://tailscale.com/install.sh | sh'], { timeoutMs: 10 * 60_000 })
      if (r.status !== 0) throw new Stop('Installing Tailscale didn\'t finish: ' + relayable((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' / ')))
      cli = findTailscale(deps)
    } else cli = await ownTailscale(deps, jobs, say, todo)
  }
  const own = cli === ownCli
  if (!cli && agent && mac) throw new NextStep('person', 'Install Tailscale on the Mac running Hermes (not on your phone): https://tailscale.com/download/mac or the Mac App Store. Open it and sign in.')
  if (!cli) throw new Stop(mac ? 'Install Tailscale on this Mac (not on your phone): https://tailscale.com/download/mac. Open it, sign in, then run this again.'
    : 'Install Tailscale on this computer (not on your phone): curl -fsSL https://tailscale.com/install.sh | sh, then sudo tailscale up and sign in. Then run this again.')
  let ts = tailscaleState(deps, cli)
  if (!ts.running && own) {
    // This account's own Tailscale: signing it in takes only its link, opened in any browser.
    if (agent) {
      const link = tailscaleSignInLink(deps, cli)
      ts = tailscaleState(deps, cli)
      if (!ts.running && link) throw new NextStep('person', `Sign in to Tailscale for the computer running Hermes (free; your phone doesn't need it): open ${link}`)
      if (!ts.running) throw new NextStep('agent', 'Tailscale on this computer is still starting. Wait a minute, then run this same command again.')
    } else {
      say('  → Sign in to Tailscale (free; your phone doesn\'t need it): open the link below in any browser, then come back here.')
      deps.run(cli, ['up'], { interactive: true, timeoutMs: 15 * 60_000 })
      ts = tailscaleState(deps, cli)
      if (!ts.running) throw new Stop('Tailscale isn\'t signed in yet. Run this again and open the link it shows.')
    }
  }
  if (!ts.running && agent) {
    if (mac) throw new NextStep('person', 'Open the Tailscale app on the Mac running Hermes and sign in (it\'s free). Your phone doesn\'t need Tailscale.')
    const root = sudoPrefix(deps)
    if (!root) throw new NextStep('person', `On the computer running Hermes, run this once in a terminal (it asks for your password), then open the sign-in link it shows: sudo tailscale up --operator=${deps.user}`)
    // `tailscale up` leaves the sign-in link with Tailscale itself: waiting for it is the person's job, not this run's.
    const r = asRoot(deps, root, cli, ['up', `--operator=${deps.user}`, '--timeout=15s'], { timeoutMs: 30_000 })
    let auth = /https:\/\/login\.tailscale\.com\/\S+/.exec(r.stdout + r.stderr)?.[0]
    try { auth ??= JSON.parse(deps.run(cli, ['status', '--json']).stdout).AuthURL || undefined } catch {}
    ts = tailscaleState(deps, cli)
    if (!ts.running) throw new NextStep('person', auth ? `Sign in to Tailscale for the computer running Hermes (free; your phone doesn't need it): open ${auth}` : `On the computer running Hermes, run this once in a terminal and open the sign-in link it shows: sudo tailscale up --operator=${deps.user}`)
  }
  if (!ts.running) throw new Stop(mac ? 'Tailscale is installed but not signed in. Open Tailscale, sign in, then run this again.'
    : 'Tailscale is installed but not signed in. Run sudo tailscale up, sign in, then run this again.')
  if ((!ts.dnsName || !ts.httpsNames) && agent) throw new NextStep('person', 'Turn on MagicDNS and HTTPS Certificates for your Tailscale network: open https://login.tailscale.com/admin/dns and switch both on.')
  if (!ts.dnsName || !ts.httpsNames) throw new Stop('Turn on MagicDNS and HTTPS Certificates for your tailnet: https://login.tailscale.com/admin/dns (both are one switch each). Then run this again.')
  tailscaleOperator(deps, cli, say, dryRun)
  if (!ts.serveRead) ts = tailscaleState(deps, cli)
  if (!ts.serveRead && !dryRun) throw new Stop('Couldn\'t read what Tailscale already shares on this computer (tailscale serve status). Check that Tailscale is running and that this account may manage it, then run this again.')
  done(`Tailscale is on (${ts.dnsName})`)

  const existing = readEdgeConfig(deps)
  const edgePort = existing?.listen?.port ?? DEFAULT_EDGE_PORT
  const port = choosePort(ts, edgePort)
  if (!port) throw new Stop(`All of Funnel's public ports (${ts.funnelPorts.join(', ')}) are already used on this computer. Free one with "tailscale funnel --https=<port> off", then run this again.`)
  const url = publicUrl(ts.dnsName, port)

  // 4. Register with Nous for that address (updates in place when already registered).
  const env = (() => { try { return deps.read(path.join(home, '.env')) } catch { return '' } })()
  const registered = /^HERMES_DASHBOARD_OAUTH_CLIENT_ID=agent:/m.test(env) && env.includes(`HERMES_DASHBOARD_PUBLIC_URL=${url}`)
  if (registered) done(`Registered with Nous for ${url}`)
  else if (dryRun) todo(`register this computer with Nous for ${url} (hermes dashboard register)`)
  else {
    todo(`Registering with Nous for ${url}`)
    const named = mac ? deps.run('/usr/sbin/scutil', ['--get', 'ComputerName']).stdout.trim() : String(deps.hostname ?? '').split('.')[0]
    const name = (named || 'my-computer').replace(/[^\w .-]/g, '').slice(0, 40)
    const r = deps.run(hermes, ['dashboard', 'register', '--name', name, '--redirect-uri', `${url}/auth/callback`], { interactive: !agent })
    if (r.status !== 0) throw new Stop('Registering with Nous didn\'t finish' + (agent ? ': ' + relayable((r.stdout + r.stderr).trim().split('\n').slice(-3).join(' / ')) : ' (see above)') + '. Fix that, then run this again.')
  }

  // 5. Hermes picks up Nous sign-in on restart; its own sign-in gate must be on.
  const status = (await deps.fetchJson(`http://${backend}/api/status`)).body ?? {}
  const nousOn = (status.auth_providers ?? []).includes('nous') && (status.auth_flows ?? []).includes('native_pkce') && status.auth_required === true
  if (nousOn) done('Hermes offers Nous sign-in')
  else {
    const job = jobs.backendJob(backend)
    if (dryRun) todo(job ? `restart Hermes (${job.name}) so Nous sign-in turns on — open chats pause for a few seconds` : 'ask you to restart Hermes so Nous sign-in turns on')
    else if (!job && agent) {
      throw new NextStep('agent', `Restart the Hermes web server on ${backend} (the hermes serve or hermes dashboard process) the same way it was started, so it turns Nous sign-in on. If this chat itself runs inside that process, ask the person to restart it instead.`)
    } else {
      if (job) { todo('Restarting Hermes (open chats pause for a few seconds)'); job.restart() }
      else say('  → Restart Hermes now (stop "hermes dashboard" or "hermes serve" and start it again). Waiting for it…')
      let ok = false
      for (let i = 0; i < (job ? 60 : 300) && !ok; i++) {
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
  const jobText = jobs.text('edge', edgeJob(deps))
  const sameJob = (() => { try { return deps.read(jobs.file('edge')) === jobText } catch { return false } })()
  const loaded = jobs.loaded('edge')
  const old = oldInstall(deps)
  const restoreOld = () => { if (old?.loaded && deps.exists(old.plist)) deps.run('/bin/launchctl', ['bootstrap', `gui/${deps.uid}`, old.plist]) }
  const retireOld = () => {
    if (!old) return
    if (old.loaded) deps.run('/bin/launchctl', ['bootout', `gui/${deps.uid}/${OLD_EDGE_LABEL}`])
    if (deps.exists(old.plist)) deps.remove(old.plist)
    done(`The gatekeeper's old ${OLD_EDGE_LABEL} job is removed (its folder ~/.config/dispatch-edge is left as it was)`)
  }
  if (sameScript && sameConfig && sameJob && loaded) {
    if (old && dryRun) todo(`remove the gatekeeper's old ${OLD_EDGE_LABEL} job`)
    else if (old) {
      retireOld()
      // If the old job was the one holding the port, the new one takes it now.
      if (old.loaded) jobs.restart('edge')
    }
    done('The gatekeeper is running (only your Nous account gets in)')
  } else if (dryRun) {
    if (old) todo(`move the gatekeeper over to its Hermes HQ name (${OLD_EDGE_LABEL} → ${EDGE_LABEL}), keeping its allowed Nous accounts`)
    todo(`install the gatekeeper (owner: this computer's Nous account; upstream ${config.upstream})`)
    keepRunningAfterLogout(deps, say, dryRun)
  } else {
    todo(old ? 'Moving the gatekeeper over to its Hermes HQ name (your allowed Nous accounts carry over)' : 'Installing the gatekeeper')
    keepRunningAfterLogout(deps, say, dryRun)
    deps.copy(edgeSource, p.script)
    deps.write(p.config, JSON.stringify(config, null, 2) + '\n')
    deps.write(jobs.file('edge'), jobText, 0o644)
    // The old and new jobs listen on the same port, the one Funnel points at: the old one stops just before the new
    // one starts (a second or two), and is started again if the new one doesn't come up.
    if (old?.loaded) deps.run('/bin/launchctl', ['bootout', `gui/${deps.uid}/${OLD_EDGE_LABEL}`])
    const failed = jobs.start('edge')
    if (failed) { if (old?.loaded) jobs.remove('edge'); restoreOld(); throw new Stop('The gatekeeper didn\'t start: ' + failed) }
    let up = false
    for (let i = 0; i < 15 && !up; i++) { await deps.sleep(1000); up = (await deps.fetchJson(`http://127.0.0.1:${edgePort}/api/status`)).status === 200 }
    if (!up) {
      // With the old one restored, the new job goes entirely: two jobs on one port would fight at the next login.
      if (old?.loaded) { jobs.remove('edge'); restoreOld() }
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
    if (!ts.funnelAllowed && !agent) say('    Tailscale may ask you to allow Funnel for this computer: open the link it shows, click Allow, and come back.')
    // Agent mode: Tailscale waits for Funnel to be allowed on the tailnet; its link goes to the person instead.
    const r = deps.run(cli, ['funnel', '--bg', `--https=${port}`, `http://127.0.0.1:${edgePort}`], agent ? { timeoutMs: 30_000 } : { interactive: true, timeoutMs: 15 * 60_000 })
    if (r.status !== 0 && agent) {
      const allow = /https:\/\/login\.tailscale\.com\/\S+/.exec(r.stdout + r.stderr)?.[0]
      if (allow) throw new NextStep('person', `Allow Tailscale Funnel (your computer's public address) on your Tailscale network: open ${allow} and turn it on.`)
      throw new Stop('Tailscale didn\'t turn on the public address: ' + relayable((r.stdout + r.stderr).trim().split('\n').slice(-3).join(' / ')))
    }
    if (r.status !== 0) throw new Stop('Tailscale didn\'t turn on the public address (see above). Fix that, then run this again.')
    done(`The public address is on: ${url}`)
  }

  if (dryRun) { say('\nNothing was changed (dry run).'); return { url, dryRun: true } }

  // 8. The phone. An agent passes the address on: a QR code in a chat message is no use.
  if (agent) {
    say(`\nDONE. Hermes HQ can reach this computer at: ${url}`)
    say(`Send the person this address and tell them: in Hermes HQ, paste it into Address, then tap Sign in with Nous with the Nous account this computer's Hermes uses. Keep this computer on${mac ? ' and awake' : ''}.`)
    return { url, owner: Boolean(owner) }
  }
  say('\nDone! Now connect your iPhone:')
  say('  1. Open the Camera on your iPhone and point it at this code.')
  say('  2. Tap "Open in Hermes HQ", then tap Sign in with Nous.\n')
  say(qrTerminal(connectLink(url)))
  say(`\nCan't scan it? In Hermes HQ, tap "I already have an address" (or Add Gateway) and type: ${url}`)
  say(mac ? 'Keep this Mac on and awake: your iPhone can reach Hermes only while it is.' : 'Keep this computer on: your iPhone can reach Hermes only while it is.')
  say('To turn it off later: curl -fsSL https://raw.githubusercontent.com/mrcharlesiv/hermes-hq/main/connect.sh | sh -s -- off')
  return { url, owner: Boolean(owner) }
}

export async function status(deps) {
  const say = (line) => deps.log(line)
  const jobs = jobManager(deps)
  const cfg = readEdgeConfig(deps)
  const cli = findTailscale(deps)
  const ts = cli ? tailscaleState(deps, cli) : null
  const port = ts && cfg ? choosePort(ts, cfg.listen?.port ?? DEFAULT_EDGE_PORT) : null
  const loaded = jobs.loaded('edge') || Boolean(oldInstall(deps)?.loaded)
  const funnel = ts && port && (ts.serve?.AllowFunnel ?? {})[`${ts.dnsName}:${port}`] === true
  say(`Gatekeeper: ${loaded ? 'running' : 'off'}${cfg ? ` (${cfg.owners?.length ?? 0} allowed Nous account${cfg.owners?.length === 1 ? '' : 's'})` : ''}`)
  say(`Public address: ${funnel ? publicUrl(ts.dnsName, port) : 'off'}`)
  const background = deps.exists(jobs.file('hermes')) && jobs.loaded('hermes')
  if (background) say('Hermes: running in the background (started by this setup)')
  return { gatekeeper: loaded, url: funnel ? publicUrl(ts.dnsName, port) : null, background }
}

export async function off(deps) {
  const say = (line) => deps.log(line)
  const jobs = jobManager(deps)
  const cfg = readEdgeConfig(deps)
  const cli = findTailscale(deps)
  if (cli && cfg) {
    const ts = tailscaleState(deps, cli)
    const port = choosePort(ts, cfg.listen?.port ?? DEFAULT_EDGE_PORT)
    if (port && (ts.serve?.AllowFunnel ?? {})[`${ts.dnsName}:${port}`]) { deps.run(cli, ['funnel', `--https=${port}`, 'off']); say(`  ✓ Public address ${publicUrl(ts.dnsName, port)} is off`) }
  }
  if (jobs.loaded('edge') || deps.exists(jobs.file('edge'))) { jobs.remove('edge'); say('  ✓ Gatekeeper stopped') }
  if (oldInstall(deps)?.loaded) { deps.run('/bin/launchctl', ['bootout', `gui/${deps.uid}/${OLD_EDGE_LABEL}`]); say('  ✓ Gatekeeper stopped') }
  // The background Hermes, if this setup started it: everything it added comes off.
  if (deps.exists(jobs.file('hermes'))) {
    jobs.remove('hermes')
    say('  ✓ Hermes no longer runs in the background (this setup had started it). Start it yourself any time with: hermes dashboard')
  }
  // This account's own Tailscale, if this setup installed it: stopped, kept signed in for a later setup.
  if (deps.platform === 'linux' && deps.exists(jobs.file('tailscale'))) {
    jobs.remove('tailscale')
    say('  ✓ This account\'s own Tailscale is stopped (setting up again starts it, still signed in)')
  }
  say('Your computer is reachable again only the way it was before (Tailscale or your network). Nous registration stays; remove it at https://portal.nousresearch.com/local-dashboards if you like.')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const command = args.find((a) => !a.startsWith('-')) ?? 'setup'
  const deps = systemDeps()
  // An unknown flag (--help, a typo) prints usage instead of running setup.
  const work = args.some((a) => a.startsWith('-') && !['--dry-run', '--agent'].includes(a)) ? null : command === 'status' ? status(deps) : command === 'off' ? off(deps) : command === 'setup' ? setup(deps, { dryRun: args.includes('--dry-run') }) : null
  if (!work) { console.error('usage: node hermes-hq-connect.mjs [setup|status|off] [--dry-run] [--agent]'); process.exit(64) }
  work.catch((error) => {
    if (error instanceof NextStep) { console.log('\n' + nextStepText(error)); process.exit(error.code) }
    if (error instanceof Stop) { console.error('\n' + error.message); process.exit(error.code) }
    console.error('\nSomething went wrong: ' + (error?.message ?? error)); process.exit(1)
  })
}
