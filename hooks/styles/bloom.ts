import { fromOklch, type Rgb } from '../core/colour'
import type { Glyph, Style } from '../core/style'
import { inked, type Rgba } from '../core/rgba'
import { height, sprites, width } from './bloom-sprites'

// A pastel rainbow flowing left to right across every letter, beside a plant
// that grows from seed to flower and starts again: a Nerd Font icon where
// the terminal draws those, elsewhere a picture of the same icon.
//
// Every hue has the same lightness, so no bright or dark band rolls along the
// line; with the chroma held as well, equal hue steps are equal steps to the
// eye, and where sRGB holds less chroma (blue) it gives way rather than a
// channel clipping. The phase follows the wall clock and moves a fraction of
// a letter each frame, so the flow is smooth and keeps its speed when frames
// come late.
const LIGHTNESS = 0.76
const CHROMA = 0.14
const PERIOD = 18 // letters one turn of the hue circle spans
const SPEED = 0.004 // letters per millisecond
const HUES: readonly Rgb[] = Array.from({ length: 360 }, (_, i) => fromOklch(LIGHTNESS, CHROMA, (360 * i) / 359))

// The plant's stages, six Material Design icons, each its Nerd Font codepoint
// (in every Nerd Fonts release from 3.0) and a picture of that icon, both in
// the stage's colour. The palmate leaf is the plant at its fullest, and holds
// longest. A picture is drawn on first use: the line's text module loads this
// style too.
type Stage = { readonly glyph: Glyph; readonly ms: number; readonly picture: () => Rgba }
const PLANT: readonly Stage[] = (
  [
    ['seed', 500],
    ['sprout', 500],
    ['leaf', 500],
    ['clover', 500],
    ['palmate', 1200],
    ['lotus', 500],
  ] as const
).map(([name, ms]) => {
  const { code, rgb, alpha } = sprites[name]
  let drawn: Rgba | undefined
  return { glyph: { ch: String.fromCodePoint(code), rgb }, ms, picture: () => (drawn ??= inked(rgb, alpha, width, height)) }
})
const CYCLE_MS = PLANT.reduce((sum, s) => sum + s.ms, 0)

function stageAt(t: number): Stage {
  let left = t % CYCLE_MS
  for (const stage of PLANT) {
    if (left < stage.ms) return stage
    left -= stage.ms
  }
  return PLANT[0]!
}

export const bloom: Style = {
  tag: 'bloom',
  output: 'text',
  // A frame moves the hue about 6°, below what the eye tells apart, so 12.5
  // frames a second look continuous at half the redraws of 25.
  frameMs: 80,
  field: (x, t) => {
    const u = (x - SPEED * t) / PERIOD
    return HUES[Math.round((u - Math.floor(u)) * (HUES.length - 1))]!
  },
  glyph: t => stageAt(t).glyph,
  nerdGlyph: true,
  sprite: t => stageAt(t).picture(),
}
