import { expect, test } from 'claude-code/testing'
import { cellH, cellW } from '../hooks/core/atlas'
import { distance } from '../hooks/core/colour'
import { textFrame } from '../hooks/core/line'
import { picture } from '../hooks/core/picture'
import { FALLBACK, OFF, STYLES, TAGS } from '../hooks/styles'

// The contract every registered style keeps: a new style is checked here with
// no test of its own.

const LINES = [{ centre: 5 }, { centre: 6.5 }]

test('styles have distinct tags, off first and no style\'s, and the fallback draws text', () => {
  const tags = STYLES.map(m => m.tag)
  expect(new Set(tags).size).toBe(tags.length)
  for (const tag of tags) expect(tag).toMatch(/^[a-z]+(-[a-z]+)*$/)
  expect(TAGS).toEqual([OFF, ...tags])
  expect(tags).not.toContain(OFF)
  expect(FALLBACK).toBe(STYLES[0])
  expect(FALLBACK.output).toBe('text')
})

test('every style paints 8-bit colours, no faster than the engine can afford', () => {
  for (const style of STYLES) {
    expect(style.frameMs).toBeGreaterThanOrEqual(40)
    // One expect per style: an expect per channel costs the run seconds.
    const bad: unknown[] = []
    for (const line of LINES)
      for (let t = 0; t < 20_000; t += 170)
        for (let x = 0; x <= 40; x += 0.25) {
          const c = style.field(x, t, line)
          if (c.length !== 3 || !c.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) bad.push({ x, t, c })
        }
    expect([style.tag, bad.slice(0, 3)]).toEqual([style.tag, []])
  }
})

test('every style changes colour in even steps from frame to frame', () => {
  for (const style of STYLES) {
    const steps: number[] = []
    for (const line of LINES)
      for (let x = 0; x <= 30; x++)
        for (let t = 0; t < 20_000; t += style.frameMs) {
          const d = distance(style.field(x, t, line), style.field(x, t + style.frameMs, line))
          if (d > 0) steps.push(d)
        }
    if (steps.length === 0) continue // a still field has no steps to keep even
    steps.sort((a, b) => a - b)
    const median = steps[steps.length >> 1]!
    expect(steps.at(-1)!).toBeLessThanOrEqual(3 * median)
  }
})

test('a style that says it loops repeats its field every loopMs', () => {
  for (const style of STYLES) {
    if (style.loopMs === undefined) continue
    let differ = 0
    for (const line of LINES)
      for (let t = 0; t < 20_000; t += 130)
        for (let x = 0; x <= 40; x += 0.5) if (String(style.field(x, t, line)) !== String(style.field(x, t + style.loopMs, line))) differ++
    expect([style.tag, differ]).toEqual([style.tag, 0])
  }
})

test("every style's glyph is one character", () => {
  for (const style of STYLES)
    for (let t = 0; t < 10_000; t += 40) expect(Array.from(textFrame(style, 'Sauteing…', 'thinking', t).glyph.text)).toHaveLength(1)
})

// A glyph's picture covers the glyph's cell and the space after it, and is
// sent whenever the object changes: it must stay the same one while it holds.
test("every glyph picture fills two cells and stays one object while it holds", () => {
  for (const style of STYLES) {
    if (style.sprite === undefined) continue
    const objects = new Set<{ rgba: string; width: number; height: number }>()
    for (let t = 0; t < 20_000; t += 20) objects.add(style.sprite(t))
    const sizes = new Set([...objects].map(s => `${s.width}x${s.height}:${atob(s.rgba).length}`))
    expect([style.tag, ...sizes]).toEqual([style.tag, `${2 * cellW}x${cellH}:${2 * cellW * cellH * 4}`])
    expect([style.tag, objects.size]).toEqual([style.tag, new Set([...objects].map(s => s.rgba)).size])
  }
})

test('every style builds a frame in a small part of its frame time', () => {
  for (const style of STYLES) {
    let start = performance.now()
    for (let k = 0; k < 200; k++) textFrame(style, 'Cogitating…', 'thinking', 3000 + k * style.frameMs)
    expect((performance.now() - start) / 200).toBeLessThan(0.5)
    if (style.output !== 'image') continue
    start = performance.now()
    for (let k = 0; k < 50; k++) picture(style.field, 'Cogitating…', 3000 + k * style.frameMs)
    expect((performance.now() - start) / 50).toBeLessThan(style.frameMs / 4)
  }
})
