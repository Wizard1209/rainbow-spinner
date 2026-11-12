import { expect, test } from 'claude-code/testing'
import { cellH, cellW } from '../hooks/core/atlas'
import { choose } from '../hooks/core/choice'
import { distance, evenLut, fromOklch, hex, luma, oklab } from '../hooks/core/colour'
import { formatDuration } from '../hooks/core/duration'
import { echo, textFrame } from '../hooks/core/line'
import type { Style } from '../hooks/core/style'
import { loopTime, picture, picturePng } from '../hooks/core/picture'

const decode = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0))

test('evenLut spaces a table in equal steps to the eye', () => {
  // A sample that turns slowly at first and fast at the end.
  const skewed = (u: number) => fromOklch(0.6 + 0.2 * u, 0.1, 360 * u ** 3)
  const steps = (lut: readonly (readonly [number, number, number])[]) => lut.slice(1).map((c, i) => distance(lut[i]!, c))
  const uneven = steps(Array.from({ length: 64 }, (_, i) => skewed(i / 63)))
  const even = steps(evenLut(skewed, 64))
  const mean = even.reduce((a, b) => a + b) / even.length
  expect(Math.max(...uneven)).toBeGreaterThan(2 * mean)
  expect(Math.max(...even)).toBeLessThan(2 * mean)
})

test('fromOklch gives way in chroma, keeping lightness and hue', () => {
  let narrowed = 0
  for (let h = 0; h < 360; h += 5) {
    const c = fromOklch(0.78, 0.12, h)
    for (const v of c) expect(Number.isInteger(v) && v >= 0 && v <= 255).toBe(true)
    const [l, a, b] = oklab(c)
    const hue = (Math.atan2(b, a) * 180) / Math.PI
    expect(Math.abs(l - 0.78)).toBeLessThan(0.01)
    expect(Math.abs(((hue - h + 540) % 360) - 180)).toBeLessThan(2)
    if (Math.hypot(a, b) < 0.115) narrowed++
  }
  // Blue cannot hold 0.12 at this lightness: those hues are narrowed, not clipped.
  expect(narrowed).toBeGreaterThan(0)
})

test('a colour echoed on the tail never sinks below its grey', () => {
  const seen = new Set<string>()
  for (const c of Array.from({ length: 180 }, (_, i) => fromOklch(0.1 + 0.15 * (i % 5), 0.15, i * 10))) {
    const e = echo(c)
    seen.add(hex(e))
    expect(luma(e)).toBeGreaterThanOrEqual(127)
  }
  expect(hex(echo([0, 0, 0]))).toBe('#808080')
  expect(seen.size).toBeGreaterThan(100)
})

test('durations read as the engine writes them', () => {
  expect([999, 42_000, 60_000, 187_400, 3_725_000, 90_000_000].map(formatDuration)).toEqual(['0s', '42s', '1m 0s', '3m 7s', '1h 2m 5s', '1d 1h 0m'])
})

test("a letter's middle pixel column takes the colour the text line gives that letter", () => {
  const word = 'Cogitating…'
  const n = Array.from(word).length
  const width = n * cellW
  const mid = (cellW - 1) / 2
  let checked = 0
  // A field whose hue turns 40° across each letter and drifts with time.
  const turning: Style = { tag: 'turning', output: 'image', frameMs: 40, field: (x, t) => fromOklch(0.7, 0.1, x * 40 + t / 10) }
  for (let t = 0; t < 3400; t += 40) {
    const px = decode(picture(turning.field, word, t).rgba)
    // The text line's letter colours: the word's spans, the leading space dropped.
    const letters = textFrame(turning, word, 'thinking', t).word.flatMap(s => Array.from(s.text).map(() => s.colour)).slice(1)
    for (let k = 0; k < n; k++) {
      for (let y = 0; y < cellH; y++) {
        const i = (y * width + k * cellW + mid) * 4
        if ((px[i + 3] ?? 0) === 0) continue
        expect(hex([px[i]!, px[i + 1]!, px[i + 2]!])).toBe(letters[k])
        checked++
        break
      }
    }
  }
  expect(checked).toBe(85 * n)
})

test('/spinner takes a named style; with no argument it asks for the one that is on', () => {
  const tags = ['off', 'temper', 'holo', 'bloom']
  expect(choose(tags, '')).toBe(null)
  expect(choose(tags, '  ')).toBe(null)
  expect(choose(tags, ' Holo ')).toEqual({ tag: 'holo' })
  expect(choose(tags, 'OFF')).toEqual({ tag: 'off' })
  expect(choose(tags, 'neon')).toEqual({ unknown: 'neon' })
})

// The test environment has no zlib: an inflate of one block under the fixed
// codes, which is all the encoder writes.
function inflateFixed(data: Uint8Array): Uint8Array {
  let pos = 0
  const bit = () => (data[pos >> 3]! >> (pos++ & 7)) & 1
  const bits = (n: number) => {
    let v = 0
    for (let i = 0; i < n; i++) v |= bit() << i
    return v
  }
  const code = (n: number) => {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | bit()
    return v
  }
  const symbol = () => {
    let v = code(7)
    if (v <= 0x17) return 256 + v
    v = (v << 1) | bit()
    if (v >= 0x30 && v <= 0xbf) return v - 0x30
    if (v >= 0xc0 && v <= 0xc7) return 280 + v - 0xc0
    return 144 + ((v << 1) | bit()) - 0x190
  }
  const LEN = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
  const DIST = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
  const extra = (i: number, from: number) => (i < from ? 0 : (i - from) >> 2) + (i < from ? 0 : 1)
  expect([bits(1), bits(2)]).toEqual([1, 1]) // the last block, fixed codes
  const out: number[] = []
  for (let s = symbol(); s !== 256; s = symbol()) {
    if (pos > data.length * 8) throw new Error('the block ran past its data')
    if (s < 256) {
      out.push(s)
      continue
    }
    const i = s - 257
    const length = i === 28 ? 258 : LEN[i]! + bits(extra(i, 8))
    const d = code(5)
    const back = DIST[d]! + bits(d < 4 ? 0 : (d >> 1) - 1)
    for (let k = 0; k < length; k++) out.push(out[out.length - back]!)
  }
  return Uint8Array.from(out)
}

// The PNG holds the RGBA picture's pixels: undo the deflate and the "up"
// filter, row by row.
test('a picture as a PNG holds the same pixels', () => {
  const field: Style['field'] = (x, t) => fromOklch(0.7, 0.1, x * 40 + t / 10)
  for (const [word, t] of [['Cogitating…', 0], ['Flambéing…', 1234]] as const) {
    const bytes = decode(picturePng(field, word, t).png)
    const raw = picture(field, word, t)
    const view = new DataView(bytes.buffer)
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([raw.width, raw.height])
    const idat = bytes.subarray(41, 41 + view.getUint32(33))
    expect(bytes[25]).toBe(6) // RGBA
    const rows = inflateFixed(idat.subarray(2))
    for (let y = 0; y < raw.height; y++) expect(rows[y * (raw.width * 4 + 1)]).toBe(2) // each row filtered "up"
    const stride = raw.width * 4
    const px = new Uint8Array(stride * raw.height)
    for (let y = 0; y < raw.height; y++)
      for (let x = 0; x < stride; x++) px[y * stride + x] = (rows[y * (stride + 1) + 1 + x]! + (y > 0 ? px[(y - 1) * stride + x]! : 0)) & 255
    const want = decode(raw.rgba)
    // A count, not the arrays: a diff of 50 000 bytes swamps the report.
    expect([word, px.length, px.reduce((bad, v, i) => bad + (v === want[i] ? 0 : 1), 0)]).toEqual([word, want.length, 0])
  }
})

test('a looping field is drawn at frame steps through its loop', () => {
  const holoLike = { frameMs: 40, loopMs: 1700 }
  expect([0, 39, 40, 1699, 1700, 1745, 5 * 1700 + 81].map(t => loopTime(holoLike, t))).toEqual([0, 0, 40, 1680, 0, 40, 80])
  expect(loopTime({ frameMs: 40 }, 1745)).toBe(1745)
})
