// A small QR Code encoder (byte mode, error correction level M, versions 1–15) for hermes-hq-connect's terminal
// handoff, with no dependencies. Follows ISO/IEC 18004 the way Project Nayuki's reference implementation does:
// Reed–Solomon over GF(256), interleaved blocks, the eight masks scored by the standard penalty rules.

const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24] // level M
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10] // level M
const FORMAT_M = 0 // ECC level M's format bits

function rawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2
    result -= (25 * align - 10) * align - 55
    if (ver >= 7) result -= 36
  }
  return result
}
const dataCodewords = (ver) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver]

function rsMultiply(x, y) {
  let z = 0
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x }
  return z & 0xff
}
function rsDivisor(degree) {
  const result = new Array(degree).fill(0); result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) { result[j] = rsMultiply(result[j], root); if (j + 1 < result.length) result[j] ^= result[j + 1] }
    root = rsMultiply(root, 0x02)
  }
  return result
}
function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ result.shift(); result.push(0)
    divisor.forEach((coef, i) => { result[i] ^= rsMultiply(coef, factor) })
  }
  return result
}

/** The QR matrix for `text` (UTF-8, byte mode): rows of booleans, true = dark. */
export function qrMatrix(text) {
  const bytes = [...Buffer.from(text, 'utf8')]
  let ver = 1
  for (; ver <= 15; ver++) if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(ver) * 8) break
  if (ver > 15) throw new Error('Text too long for this QR encoder')
  // Data bits: mode 0100, length, bytes, terminator, padding.
  const bits = []
  const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1) }
  push(4, 4); push(bytes.length, ver < 10 ? 8 : 16); for (const b of bytes) push(b, 8)
  const capacity = dataCodewords(ver) * 8
  push(0, Math.min(4, capacity - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8)
  const data = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))

  // Blocks and interleaving.
  const numBlocks = BLOCKS[ver], eccLen = ECC_PER_BLOCK[ver], raw = Math.floor(rawDataModules(ver) / 8)
  const shortBlocks = numBlocks - (raw % numBlocks), shortLen = Math.floor(raw / numBlocks)
  const divisor = rsDivisor(eccLen), blocks = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1)); k += dat.length
    const ecc = rsRemainder(dat, divisor)
    if (i < shortBlocks) dat.push(0)
    blocks.push(dat.concat(ecc))
  }
  const codewords = []
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((block, j) => { if (i !== shortLen - eccLen || j >= shortBlocks) codewords.push(block[i]) })

  // Function patterns.
  const size = ver * 4 + 17
  const modules = Array.from({ length: size }, () => new Array(size).fill(false))
  const fn = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (x, y, dark) => { modules[y][x] = dark; fn[y][x] = true }
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0) }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4)
    }
  }
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4)
  const align = []
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2, step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2
    align.push(6)
    for (let pos = size - 7; align.length < n; pos -= step) align.splice(1, 0, pos)
  }
  align.forEach((ay, i) => align.forEach((ax, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) return
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }))
  const drawFormat = (mask) => {
    const value = (FORMAT_M << 3) | mask
    let rem = value
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const b = ((value << 10) | rem) ^ 0x5412
    const bit = (i) => ((b >>> i) & 1) !== 0
    for (let i = 0; i <= 5; i++) set(8, i, bit(i))
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8))
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i))
    set(8, size - 8, true)
  }
  drawFormat(0)
  if (ver >= 7) {
    let rem = ver
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const b = (ver << 12) | rem
    for (let i = 0; i < 18; i++) {
      const dark = ((b >>> i) & 1) !== 0, a = size - 11 + (i % 3), c = Math.floor(i / 3)
      set(a, c, dark); set(c, a, dark)
    }
  }

  // Data placement (zigzag).
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert
      if (!fn[y][x] && i < codewords.length * 8) { modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++ }
    }
  }

  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (fn[y][x]) continue
      const invert = [(x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0, (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
        (x * y) % 2 + (x * y) % 3 === 0, ((x * y) % 2 + (x * y) % 3) % 2 === 0, ((x + y) % 2 + (x * y) % 3) % 2 === 0][mask]
      if (invert) modules[y][x] = !modules[y][x]
    }
  }
  let best = 0, bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask); drawFormat(mask)
    const score = penalty(modules)
    if (score < bestScore) { best = mask; bestScore = score }
    applyMask(mask)
  }
  applyMask(best); drawFormat(best)
  return modules
}

function penalty(m) {
  const size = m.length
  let score = 0
  const runs = (line) => {
    let s = 0, run = 1
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) run++
      else { if (run >= 5) s += 3 + run - 5; run = 1 }
    }
    const pattern = (k) => [1, 0, 1, 1, 1, 0, 1].every((v, j) => line[k + j] === !!v)
    for (let k = 0; k + 7 <= line.length; k++) {
      if (!pattern(k)) continue
      const before = k >= 4 && [1, 2, 3, 4].every((d) => !line[k - d]), after = k + 11 <= line.length && [7, 8, 9, 10].every((d) => !line[k + d])
      if (before || after) s += 40
    }
    return s
  }
  for (let y = 0; y < size; y++) score += runs(m[y])
  for (let x = 0; x < size; x++) score += runs(m.map((row) => row[x]))
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = m[y][x]
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3
  }
  const dark = m.reduce((n, row) => n + row.filter(Boolean).length, 0)
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10
  return score
}

/** The QR for `text` as terminal text: two module rows per line (▀ with a foreground for the top module and a
 *  background for the bottom one), in explicit black and white so it scans on light and dark terminals alike. */
export function qrTerminal(text) {
  const m = qrMatrix(text), size = m.length, q = 2
  const dark = (x, y) => x >= 0 && y >= 0 && x < size && y < size && m[y][x]
  const lines = []
  for (let y = -q; y < size + q; y += 2) {
    let line = ''
    for (let x = -q; x < size + q; x++) line += `\x1b[${dark(x, y) ? 30 : 97};${dark(x, y + 1) ? 40 : 107}m▀`
    lines.push(line + '\x1b[0m')
  }
  return lines.join('\n')
}
