// node --test gateway-edge/test — the built-in QR encoder, checked by Apple's own reader (Vision) on macOS.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { qrMatrix } from '../qr.mjs'

test('QR codes from 1 to 250 bytes decode exactly (versions 1–15)', { skip: process.platform !== 'darwin' && 'Vision is macOS-only' }, () => {
  const texts = [
    'hi', 'hermes://connect?url=https%3A%2F%2Fyour-mac.tailnet-name.ts.net%3A10000',
    'hermes://connect?url=https%3A%2F%2Fa-much-longer-computer-name.tailnet-with-a-long-name.ts.net',
    ...Array.from({ length: 24 }, (_, i) => 'x'.repeat(10 * i + 3) + ' é ✓'),
  ]
  const input = texts.map((t) => qrMatrix(t).map((row) => row.map((d) => (d ? '1' : '0')).join('')).join('|') + '\t' + t).join('\n') + '\n'
  const script = fileURLToPath(new URL('./qr_decode.swift', import.meta.url))
  const run = spawnSync('xcrun', ['swift', script], { input, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /PASS: \d+ QR codes decoded exactly/)
})

test('a QR is sized to its text and refuses what it cannot hold', () => {
  assert.equal(qrMatrix('hi').length, 21) // version 1
  assert.throws(() => qrMatrix('x'.repeat(600)), /too long/)
})
