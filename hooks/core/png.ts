// RGBA pixels as a PNG, deflated here: the hooks environment has no zlib.
// Fixed Huffman codes and a greedy LZ77 match: a word picture is mostly
// transparent rows and columns of one colour, which this packs to about a
// twelfth of its raw bytes: kitty draws nothing under a picture until its last
// byte is in, and raw pixels take longer than a frame to arrive.

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array, from: number, to: number): number {
  let c = 0xffffffff
  for (let i = from; i < to; i++) c = CRC[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

class Bits {
  buf = new Uint8Array(1 << 16)
  len = 0
  acc = 0
  n = 0
  put(value: number, count: number) {
    this.acc |= value << this.n
    this.n += count
    while (this.n >= 8) {
      this.byte(this.acc & 0xff)
      this.acc >>>= 8
      this.n -= 8
    }
  }
  // Huffman codes go most significant bit first.
  code(code: number, count: number) {
    let r = 0
    for (let i = 0; i < count; i++) r |= ((code >> i) & 1) << (count - 1 - i)
    this.put(r, count)
  }
  byte(b: number) {
    if (this.len === this.buf.length) {
      const more = new Uint8Array(this.buf.length * 2)
      more.set(this.buf)
      this.buf = more
    }
    this.buf[this.len++] = b
  }
  flush() {
    if (this.n > 0) this.byte(this.acc & 0xff)
    this.acc = 0
    this.n = 0
  }
}

function literal(out: Bits, v: number) {
  if (v < 144) out.code(0x30 + v, 8)
  else if (v < 256) out.code(0x190 + v - 144, 9)
  else if (v < 280) out.code(v - 256, 7)
  else out.code(0xc0 + v - 280, 8)
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]

function match(out: Bits, length: number, dist: number) {
  let i = LEN_BASE.length - 1
  while (LEN_BASE[i]! > length) i--
  literal(out, 257 + i)
  out.put(length - LEN_BASE[i]!, LEN_EXTRA[i]!)
  let d = DIST_BASE.length - 1
  while (DIST_BASE[d]! > dist) d--
  out.code(d, 5)
  out.put(dist - DIST_BASE[d]!, DIST_EXTRA[d]!)
}

function deflate(data: Uint8Array): Uint8Array {
  const out = new Bits()
  out.byte(0x78)
  out.byte(0x01)
  out.put(1, 1) // last block
  out.put(1, 2) // fixed codes
  const HASH = 1 << 14
  const head = new Int32Array(HASH).fill(-1)
  const prev = new Int32Array(data.length)
  const hash = (i: number) => ((data[i]! << 10) ^ (data[i + 1]! << 5) ^ data[i + 2]!) & (HASH - 1)
  let i = 0
  while (i < data.length) {
    let best = 0
    let dist = 0
    if (i + 2 < data.length) {
      const h = hash(i)
      let j = head[h]!
      for (let tries = 0; j >= 0 && i - j <= 32768 && tries < 16; tries++, j = prev[j]!) {
        let l = 0
        while (l < 258 && i + l < data.length && data[j + l] === data[i + l]) l++
        if (l > best) {
          best = l
          dist = i - j
          if (l === 258) break
        }
      }
      prev[i] = head[h]!
      head[h] = i
    }
    if (best >= 3) {
      match(out, best, dist)
      for (let k = 1; k < best; k++) {
        const p = i + k
        if (p + 2 < data.length) {
          const h = hash(p)
          prev[p] = head[h]!
          head[h] = p
        }
      }
      i += best
    } else {
      literal(out, data[i]!)
      i++
    }
  }
  literal(out, 256)
  out.flush()
  let a = 1
  let b = 0
  for (let k = 0; k < data.length; k++) {
    a = (a + data[k]!) % 65521
    b = (b + a) % 65521
  }
  for (const v of [b >> 8, b & 255, a >> 8, a & 255]) out.byte(v)
  return out.buf.subarray(0, out.len)
}

// The rows filtered "up" (each byte less the one above), which turns a
// column of one colour into zeros.
export function png(px: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4
  const rows = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    rows[y * (stride + 1)] = 2
    for (let x = 0; x < stride; x++) {
      const v = px[y * stride + x]!
      rows[y * (stride + 1) + 1 + x] = (v - (y > 0 ? px[(y - 1) * stride + x]! : 0)) & 255
    }
  }
  const idat = deflate(rows)
  const chunks: [string, Uint8Array][] = [
    ['IHDR', new Uint8Array([width >>> 24, (width >>> 16) & 255, (width >>> 8) & 255, width & 255, height >>> 24, (height >>> 16) & 255, (height >>> 8) & 255, height & 255, 8, 6, 0, 0, 0])],
    ['IDAT', idat],
    ['IEND', new Uint8Array(0)],
  ]
  const size = 8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0)
  const file = new Uint8Array(size)
  file.set([137, 80, 78, 71, 13, 10, 26, 10])
  let o = 8
  for (const [type, d] of chunks) {
    file.set([d.length >>> 24, (d.length >>> 16) & 255, (d.length >>> 8) & 255, d.length & 255], o)
    for (let k = 0; k < 4; k++) file[o + 4 + k] = type.charCodeAt(k)
    file.set(d, o + 8)
    const c = crc32(file, o + 4, o + 8 + d.length)
    file.set([c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255], o + 8 + d.length)
    o += 12 + d.length
  }
  return file
}
