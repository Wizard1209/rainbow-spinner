import { cellH, cellW, glyphs } from './atlas'
import { type Field, letterAt, lineOf, type Style } from './style'
import { png } from './png'
import { fromBase64, rgba, type Rgba } from './rgba'

// The word as a picture: each letter is its JetBrains Mono mask from the
// atlas, inked per pixel column in the field's colour at that column's place
// on the line, so the colour runs on inside a letter. The terminal scales the
// picture to fill the word's cells.

const MAX_SIDE = 2048 // an rgba source's widest

const masks = new Map<string, Uint8Array>()

function mask(ch: string): Uint8Array | undefined {
  const known = masks.get(ch)
  if (known !== undefined) return known
  const b64 = glyphs[ch]
  if (b64 === undefined) return undefined
  const decoded = fromBase64(b64)
  masks.set(ch, decoded)
  return decoded
}

// Whether the atlas has every letter of the text and the picture fits a source.
export function drawable(text: string): boolean {
  const letters = Array.from(text)
  return letters.length > 0 && letters.length * cellW <= MAX_SIDE && letters.every(ch => glyphs[ch] !== undefined)
}

// A picture as ImageSource's PNG form, base64.
export type Png = { png: string }

// The middle pixel column of letter k sits at letterAt(k), exactly where the
// text line samples that letter.
export function picture(field: Field, text: string, t: number): Rgba {
  const { px, width } = pixels(field, text, t)
  return rgba(px, width, cellH)
}

// The same picture as a PNG: what is sent to the terminal.
export function picturePng(field: Field, text: string, t: number): Png {
  const { px, width } = pixels(field, text, t)
  return { png: (png(px, width, cellH) as Uint8Array & { toBase64: () => string }).toBase64() }
}

// The pictures at each of the times stacked into one PNG, the first on top:
// frame k is the band from y = k × cellH.
export function sheetPng(field: Field, text: string, times: readonly number[]): Png {
  const frames = times.map(t => pixels(field, text, t))
  const width = frames[0]?.width ?? 0
  const px = new Uint8Array(width * cellH * 4 * frames.length)
  frames.forEach((f, k) => px.set(f.px, k * f.px.length))
  return { png: (png(px, width, cellH * frames.length) as Uint8Array & { toBase64: () => string }).toBase64() }
}

// The time a frame at t is drawn at. A field that repeats every loopMs is
// drawn at frameMs steps through its loop, so one loop's pictures serve every
// later one.
export function loopTime(style: Pick<Style, 'frameMs' | 'loopMs'>, t: number): number {
  if (style.loopMs === undefined) return t
  const within = t % style.loopMs
  return within - (within % style.frameMs)
}

function pixels(field: Field, text: string, t: number): { px: Uint8Array; width: number } {
  const letters = Array.from(text)
  const line = lineOf(text)
  const width = letters.length * cellW
  const px = new Uint8Array(width * cellH * 4)
  letters.forEach((ch, k) => {
    const ink = mask(ch)
    if (ink === undefined) return
    for (let dx = 0; dx < cellW; dx++) {
      const [r, g, b] = field(letterAt(k) - 0.5 + (dx + 0.5) / cellW, t, line)
      for (let y = 0; y < cellH; y++) {
        const a = ink[y * cellW + dx] ?? 0
        if (a === 0) continue
        const i = (y * width + k * cellW + dx) * 4
        px[i] = r
        px[i + 1] = g
        px[i + 2] = b
        px[i + 3] = a
      }
    }
  })
  return { px, width }
}
