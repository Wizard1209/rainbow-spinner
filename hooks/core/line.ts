import { hex, luma, type Rgb, tint, toRgb } from './colour'
import { formatDuration } from './duration'
import { letterAt, lineOf, type Style } from './style'

export type Span = { text: string; colour: string } // neighbouring letters of one colour, joined
export type Frame = { glyph: Span; word: Span[]; tail: Span[] } // word: the space before it included

const STARS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const STAR_MS = 120
const TAIL_GREY = 128 // the time and state after the word, at rest
const ECHO = 0.45 // how strongly a field's colour tints that tail

// The tail never goes dark: a colour reaching it only tints its grey, so the
// time and state stay readable whatever the field does there.
export function echo(rgb: Rgb): Rgb {
  if (rgb.every(v => v === 0)) return [TAIL_GREY, TAIL_GREY, TAIL_GREY]
  let mixed = tint(TAIL_GREY, rgb, ECHO)
  // A dark colour would sink the tail below its grey: lift it back.
  if (luma(mixed) < TAIL_GREY) mixed = mixed.map(v => v + (TAIL_GREY - luma(mixed)))
  return toRgb(mixed)
}

// The spinner line as coloured text at wall time t: glyph, space and word in
// the field's colours, then the tail in their echo.
export function textFrame(style: Style, text: string, activity: string, t: number): Frame {
  const letters = Array.from(text)
  const line = lineOf(text)
  const at = (x: number) => style.field(x, t, line)
  const glyph = style.glyph?.(t) ?? { ch: STARS[Math.floor(t / STAR_MS) % STARS.length] ?? '·', rgb: at(0) }

  const word: Span[] = []
  push(word, ' ', at(letterAt(-1)))
  letters.forEach((ch, k) => push(word, ch, at(letterAt(k))))

  const elapsed = formatDuration(Math.floor(t / 1000) * 1000)
  const tail: Span[] = []
  const first = letterAt(letters.length)
  Array.from(` (${elapsed}${activity === 'thinking' ? ' · thinking' : ''})`).forEach((ch, j) => push(tail, ch, echo(at(first + j))))

  return { glyph: { text: glyph.ch, colour: hex(glyph.rgb) }, word, tail }
}

function push(spans: Span[], ch: string, rgb: Rgb) {
  const colour = hex(rgb)
  const last = spans.at(-1)
  if (last?.colour === colour) last.text += ch
  else spans.push({ text: ch, colour })
}
