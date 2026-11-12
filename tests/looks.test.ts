import { expect, test } from 'claude-code/testing'
import { cellW } from '../hooks/core/atlas'
import { distance, hex, oklab } from '../hooks/core/colour'
import { textFrame } from '../hooks/core/line'
import { inked } from '../hooks/core/rgba'
import { bloom } from '../hooks/styles/bloom'
import { height, sprites, width } from '../hooks/styles/bloom-sprites'
import { holo } from '../hooks/styles/holo'

// What particular styles look like, beyond the contract every style keeps.

test('holo is already spread over the whole line when it appears', () => {
  // Rims about three letters apart, each two letters wide, out past 40
  // letters from the centre: no stretch of two letters is black.
  const line = { centre: 6 }
  let dark = 0
  let longest = 0
  for (let x = 0; x < 46; x += 1 / cellW) {
    dark = holo.field(x, 0, line).every(v => v === 0) ? dark + 1 / cellW : 0
    longest = Math.max(longest, dark)
  }
  expect(longest).toBeLessThan(2)
})

test('bloom flows to the right at one lightness, from the wall clock', () => {
  const line = { centre: 5 }
  const lightness = new Set<number>()
  for (let x = 0; x < 40; x++) lightness.add(Math.round(oklab(bloom.field(x, 1234, line))[0] * 100))
  expect(Math.max(...lightness) - Math.min(...lightness)).toBeLessThanOrEqual(1)
  // A second later every colour stands 4 letters further right.
  for (let x = 0; x < 30; x++) expect(distance(bloom.field(x + 4, 2234, line), bloom.field(x, 1234, line))).toBeLessThan(0.01)
  expect(hex(bloom.field(3, 0, line))).not.toBe(hex(bloom.field(4, 0, line)))
})

// The Material Design icons of the plant, as Nerd Font codepoints: every Nerd
// Fonts release from 3.0 has them.
const [SEED, SPROUT, LEAF, CLOVER, PALMATE, LOTUS] = [0xf0e62, 0xf0e66, 0xf032a, 0xf0816, 0xf07a6, 0xf0cd1]
const ICONS = [SEED, SPROUT, LEAF, CLOVER, PALMATE, LOTUS]

test('bloom draws the same six icons in the same order as glyphs and as pictures', () => {
  // The pictures, in the order they were made, are of the six icons.
  expect(Object.values(sprites).map(s => s.code)).toEqual(ICONS)
  const pictureOf = new Map(Object.values(sprites).map(s => [s.code as number, inked(s.rgb, s.alpha, width, height).rgba]))
  // Over two turns of the plant every glyph is one of the six, the picture
  // beside it is that icon's, and the stages come in the icons' order.
  const order: number[] = []
  for (let t = 0; t < 7400; t += 20) {
    const code = textFrame(bloom, 'x', 'thinking', t).glyph.text.codePointAt(0)!
    expect([t, ICONS.includes(code), bloom.sprite!(t).rgba === pictureOf.get(code)]).toEqual([t, true, true])
    if (order.at(-1) !== code) order.push(code)
  }
  expect(order).toEqual([...ICONS, ...ICONS])
})

// The code beside a mask names the icon; this ties the mask to it. Digests
// (FNV-1a of the base64) of the masks sprites/gen_sprites.py draws from each
// icon's SVG; a regenerated file with other masks updates them here.
test('each picture of bloom is drawn from its own icon', () => {
  const fnv = (s: string) => {
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
    return h
  }
  const masks = new Map(Object.values(sprites).map(s => [s.code as number, fnv(s.alpha)]))
  expect(ICONS.map(code => masks.get(code))).toEqual([0x5c9056af, 0xdeac0b03, 0x7d4f7cbb, 0x80941180, 0x3eea8424, 0x1ac26ba6])
})

test('the bloom plant grows through six stages, its palmate leaf held longest', () => {
  const at = [0, 500, 1000, 1500, 2000, 3199, 3200, 3700]
  const glyphs = at.map(t => textFrame(bloom, 'Sauteing…', 'thinking', t).glyph.text.codePointAt(0))
  expect(glyphs).toEqual([SEED, SPROUT, LEAF, CLOVER, PALMATE, PALMATE, LOTUS, SEED])
  // Its pictures are of the same stages: one object while a stage holds.
  for (let t = 0; t < 7400; t += 40) expect(bloom.sprite!(t)).toBe(bloom.sprite!(Math.floor(t / 100) * 100))
  const pictures = at.map(t => bloom.sprite!(t))
  expect(new Set(pictures).size).toBe(6)
  expect(pictures[7]).toBe(pictures[0])
  // Each picture is one colour, the stage's glyph's.
  for (const t of at) {
    const px = Uint8Array.from(atob(bloom.sprite!(t).rgba), c => c.charCodeAt(0))
    const inks = new Set<string>()
    for (let i = 0; i < px.length; i += 4) if (px[i + 3]! > 0) inks.add(hex([px[i]!, px[i + 1]!, px[i + 2]!]))
    expect([...inks]).toEqual([textFrame(bloom, 'x', 'thinking', t).glyph.colour])
  }
})
