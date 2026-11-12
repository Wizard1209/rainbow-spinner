import { expect, mock, test } from 'claude-code/testing'
import { textFrame } from '../hooks/core/line'
import { picturePng } from '../hooks/core/picture'
import { bloom } from '../hooks/styles/bloom'
import { holo } from '../hooks/styles/holo'
import { temper } from '../hooks/styles/temper'

const SPINNER = {
  plugin: 'rainbow-spinner',
  component: 'Spinner',
  requestId: 'main',
  props: { word: 'Sauteing', message: null, suffix: '…', mode: 'thinking' },
} as const
const FULLSCREEN = { columns: 120, rows: 40, isFullscreen: true }
const MAIN_SCREEN = { columns: 120, rows: 40, isFullscreen: false }

// A word in a script the font atlas has no letters for.
const UNDRAWABLE = '\u8003\u3048\u4E2D'

type Found = { text: string; props: Record<string, unknown> }
type Drawing = {
  find: (q: { type: string; in?: string }) => Promise<Found | undefined>
  findAll: (q: { type: string; in?: string }) => Promise<Found[]>
  drawn: () => Promise<unknown>
}
type Rgba = { rgba: string; width: number; height: number }
type Png = { png: string }
type Blit = { requestId: string; key: string; source: Rgba | Png }

// The line drawn as one text: word (with the space before it) and tail.
async function textLine(ui: Drawing) {
  // texts[0] is the line itself; its spans follow: glyph, word runs, tail runs.
  const spans = (await ui.findAll({ type: 'Text', in: 'line' })).slice(1)
  const full = spans.map(t => t.text).join('')
  const wordEnd = full.lastIndexOf(' (')
  let at = 0
  const word: Found[] = []
  const tail: Found[] = []
  for (const span of spans) (at < wordEnd ? word : tail).push(span), (at += span.text.length)
  return {
    word: full.slice(2, wordEnd),
    colours: word.map(t => t.props.color as string),
    tail: full.slice(wordEnd),
    tailColours: tail.map(t => t.props.color as string),
  }
}

// What the drawing holds, as `type:key` of the row's children.
async function shape(ui: Drawing) {
  const drawn = (await ui.drawn()) as { children: { type: string; props: { key?: string } }[] }
  return drawn.children.map(c => `${c.type}:${c.props.key}`)
}

test("temper's line rests in black when it appears", async ($, on) => {
  mock.store(on, { style: 'temper' })
  mock.env(on, {})
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal', viewport: FULLSCREEN })
  expect(await shape(ui)).toEqual(['Client:line'])
  const atRest = await textLine(ui)
  expect(atRest.word).toBe('Sauteing…')
  expect(new Set(atRest.colours)).toEqual(new Set(['#000000']))
  expect(atRest.tail).toBe(' (0s · thinking)')
  expect(new Set(atRest.tailColours)).toEqual(new Set(['#808080']))
  await ui.unmount()
})

test('a message that ends in an ellipsis keeps just one', async ($, on) => {
  mock.store(on, { style: 'temper' })
  mock.env(on, {})
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal', props: { ...SPINNER.props, message: 'Compacting…' } })
  expect((await textLine(ui)).word).toBe('Compacting…')
  await ui.unmount()
})

test('holo draws the word as a picture between the glyph and the tail', async ($, on) => {
  mock.store(on, { style: 'holo' })
  mock.env(on, {})
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal', viewport: FULLSCREEN })
  expect(await shape(ui)).toEqual(['Client:line', 'Image:word', 'Client:tail'])
  const image = await ui.find({ type: 'Image' })
  expect([image?.props.alt, image?.props.columns, image?.props.rows]).toEqual(['Sauteing…', 9, 1])
  expect(image?.props.source).toEqual(picturePng(holo.field, 'Sauteing…', 0))
  expect((await ui.find({ type: 'Text', in: 'line' }))?.text).toMatch(/^[·✢✳✶✻✽] $/)
  expect((await ui.findAll({ type: 'Text', in: 'tail' })).slice(1).map(t => t.text).join('')).toBe(' (0s · thinking)')
  await ui.unmount()
})

test("holo draws the engine's accented words as pictures too", async ($, on) => {
  mock.store(on, { style: 'holo' })
  mock.env(on, {})
  for (const word of ['Flambéing', 'Sautéing']) {
    const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal', viewport: FULLSCREEN, props: { ...SPINNER.props, word } })
    expect(await shape(ui)).toEqual(['Client:line', 'Image:word', 'Client:tail'])
    expect((await ui.find({ type: 'Image' }))?.props.alt).toBe(`${word}…`)
    await ui.unmount()
  }
})

// Only iTerm2 needs fullscreen mode for pictures; kitty and Ghostty
// show them on the main screen too.
test('holo draws its picture on the main screen too', async ($, on) => {
  mock.store(on, { style: 'holo' })
  mock.env(on, { KITTY_WINDOW_ID: '1' })
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal', viewport: MAIN_SCREEN })
  expect(await shape(ui)).toEqual(['Client:line', 'Image:word', 'Client:tail'])
  await ui.unmount()
})

test('a word the font atlas has no letters for falls back to temper text', async ($, on) => {
  mock.store(on, { style: 'holo' })
  mock.env(on, {})
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal', viewport: FULLSCREEN, props: { ...SPINNER.props, message: UNDRAWABLE } })
  expect(await shape(ui)).toEqual(['Client:line'])
  expect(new Set((await textLine(ui)).colours)).toEqual(new Set(['#000000']))
  await ui.unmount()
})

test('each frame the glyph posts is blitted once, and a redraw shows the last', async ($, on) => {
  mock.store(on, { style: 'holo' })
  mock.env(on, {})
  const blits: Blit[] = []
  on('ui.blit', ($, e) => {
    blits.push(e as unknown as Blit)
    return { value: {} }
  })
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal', viewport: FULLSCREEN })
  for (const t of [400, 800, 1200]) await ui.post({ t, tag: 'holo', text: 'Sauteing…' }, { in: 'line' })
  expect(blits.map(b => [b.requestId, b.key])).toEqual([['main', 'word'], ['main', 'word'], ['main', 'word']])
  expect(blits.map(b => b.source)).toEqual([400, 800, 1200].map(t => picturePng(holo.field, 'Sauteing…', t)))

  await ui.redraw({ ...SPINNER.props, mode: 'responding' })
  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual(blits[2]?.source)
  await ui.unmount()
})

// holo's field repeats every loopMs: a frame a loop later is the same picture,
// and a time between frames shows the frame before it.
test("holo's pictures follow its loop, a frame at a time", async ($, on) => {
  mock.store(on, { style: 'holo' })
  mock.env(on, {})
  const blits: Blit[] = []
  on('ui.blit', ($, e) => {
    blits.push(e as unknown as Blit)
    return { value: {} }
  })
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal', viewport: FULLSCREEN })
  const loop = holo.loopMs!
  const between = 400 + holo.frameMs + 15
  for (const t of [400, between, 400 + loop, between + 3 * loop]) await ui.post({ t, tag: 'holo', text: 'Sauteing…' }, { in: 'line' })
  const [a, b, c, d] = blits.map(x => x.source)
  expect(a).toEqual(picturePng(holo.field, 'Sauteing…', 400))
  expect(b).toEqual(picturePng(holo.field, 'Sauteing…', 400 + holo.frameMs))
  expect([c, d]).toEqual([a, b])
  await ui.unmount()
})

test("the glyph's clock posts a frame every tick", async ($, on) => {
  mock.store(on, { style: 'holo' })
  mock.env(on, {})
  const blits: Blit[] = []
  on('ui.blit', ($, e) => {
    blits.push(e as unknown as Blit)
    return { value: {} }
  })
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal', viewport: FULLSCREEN })
  for (let i = 0; i < 3; i++) {
    // The line reads wall time, which the kit's advance() does not move.
    const start = performance.now()
    while (performance.now() - start < holo.frameMs + 5) {}
    await ui.advance(holo.frameMs)
  }
  expect(blits).toHaveLength(3)
  expect(new Set(blits.map(b => JSON.stringify(b.source))).size).toBe(3)
  await ui.unmount()
})

// Waits out ms of wall time, which the line reads, and moves the frame clock on.
async function frameOn(ui: Drawing & { advance: (ms: number) => Promise<void> }, ms: number) {
  const start = performance.now()
  while (performance.now() - start < ms + 5) {}
  await ui.advance(ms)
}

test("a line whose style changes under it ticks at that style's rate", async ($, on) => {
  mock.store(on, { style: 'temper' })
  mock.env(on, { KITTY_WINDOW_ID: '1' })
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal', viewport: MAIN_SCREEN })
  await $.command.run({ command: 'spinner', args: 'bloom', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await ui.redraw()
  const colours = async () => JSON.stringify((await ui.findAll({ type: 'Text', in: 'line' })).map(t => t.props.color))
  const shown = [await colours()]
  for (let i = 0; i < 4; i++) {
    await frameOn(ui, temper.frameMs)
    shown.push(await colours())
  }
  // bloom moves every frame, but its frames come every other tick of temper's.
  expect(bloom.frameMs).toBe(2 * temper.frameMs)
  expect(shown.map((s, i) => i > 0 && s !== shown[i - 1])).toEqual([false, false, true, false, true])
  await ui.unmount()
})

test('after three refused pictures, lines are drawn as temper text', async ($, on) => {
  mock.store(on, { style: 'holo' })
  mock.env(on, {})
  on('ui.blit', () => ({ value: { deny: 'the terminal draws the alt here' } }))
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal', viewport: FULLSCREEN })
  for (const t of [40, 80]) await ui.post({ t, tag: 'holo', text: 'Sauteing…' }, { in: 'line' })
  expect(await shape(ui)).toEqual(['Client:line', 'Image:word', 'Client:tail'])
  await ui.post({ t: 120, tag: 'holo', text: 'Sauteing…' }, { in: 'line' })
  expect(await shape(ui)).toEqual(['Client:line'])
  expect((await textLine(ui)).word).toBe('Sauteing…')
  await ui.unmount()

  // Every line after it, too.
  const next = await $.ui.mount({ ...SPINNER, requestId: 'other', surface: 'terminal', viewport: FULLSCREEN })
  expect(await shape(next)).toEqual(['Client:line'])
  await next.unmount()
})

test('once a picture is taken, refusals never turn the session to text', async ($, on) => {
  mock.store(on, { style: 'holo' })
  mock.env(on, {})
  let blits = 0
  on('ui.blit', () => (blits++ === 0 ? { value: {} } : { value: { deny: 'not mounted' } }))
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal', viewport: FULLSCREEN })
  for (let t = 40; t <= 400; t += 40) await ui.post({ t, tag: 'holo', text: 'Sauteing…' }, { in: 'line' })
  expect(blits).toBe(10)
  expect(await shape(ui)).toEqual(['Client:line', 'Image:word', 'Client:tail'])
  await ui.unmount()

  const next = await $.ui.mount({ ...SPINNER, requestId: 'other', surface: 'terminal', viewport: FULLSCREEN })
  for (let t = 40; t <= 200; t += 40) await next.post({ t, tag: 'holo', text: 'Sauteing…' }, { in: 'line' })
  expect(await shape(next)).toEqual(['Client:line', 'Image:word', 'Client:tail'])
  await next.unmount()
})

test('a post that is not a frame of a picture style is left alone', async ($, on) => {
  mock.store(on, { style: 'holo' })
  mock.env(on, {})
  const blits: Blit[] = []
  on('ui.blit', ($, e) => {
    blits.push(e as unknown as Blit)
    return { value: {} }
  })
  on('ui.message', () => ({}))
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal', viewport: FULLSCREEN })
  for (const data of [{ t: -1, tag: 'holo', text: 'Sauteing…' }, { t: 40, tag: 'temper', text: 'Sauteing…' }, { t: 40, tag: 'holo', text: UNDRAWABLE }, null])
    await ui.post(data, { in: 'line' })
  expect(blits).toHaveLength(0)
  await ui.unmount()
})

// Letters and their colours, however the spans split them.
const lettersOf = (spans: { text: string; colour: string }[]) => spans.flatMap(s => Array.from(s.text).map(ch => [ch, s.colour]))

// The terminals of the bloom tests below: kitty draws Nerd Font glyphs; one
// that names nothing gets pictures.
const KITTY = { KITTY_WINDOW_ID: '1' }
const UNKNOWN = {}

test('where the terminal draws Nerd Font glyphs, bloom is all text', async ($, on) => {
  mock.store(on, { style: 'bloom' })
  mock.env(on, KITTY)
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal', viewport: FULLSCREEN })
  expect(await shape(ui)).toEqual(['Client:line'])
  const drawn = (await ui.findAll({ type: 'Text', in: 'line' })).slice(1)
  const frame = textFrame(bloom, 'Sauteing…', 'thinking', 0)
  expect(drawn[0]?.text).toBe('\u{F0E62}')
  expect(lettersOf(drawn.map(t => ({ text: t.text, colour: t.props.color as string })))).toEqual(lettersOf([frame.glyph, ...frame.word, ...frame.tail]))
  await ui.unmount()
})

test('elsewhere bloom draws its glyph as a picture, and the word and tail as text', async ($, on) => {
  mock.store(on, { style: 'bloom' })
  mock.env(on, UNKNOWN)
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal', viewport: FULLSCREEN })
  expect(await shape(ui)).toEqual(['Image:glyph', 'Client:line'])
  const image = await ui.find({ type: 'Image' })
  expect([image?.props.columns, image?.props.rows, image?.props.alt]).toEqual([2, 1, '·'])
  expect(image?.props.source).toEqual(bloom.sprite!(0))
  // The picture covers the glyph and the space after it.
  const drawn = (await ui.findAll({ type: 'Text', in: 'line' })).slice(1)
  const frame = textFrame(bloom, 'Sauteing…', 'thinking', 0)
  expect(lettersOf(drawn.map(t => ({ text: t.text, colour: t.props.color as string })))).toEqual(lettersOf([...frame.word, ...frame.tail]).slice(1))
  await ui.unmount()
})

test("bloom's picture is sent only when the plant moves on, holds the palmate leaf 1200 ms, and a redraw keeps the stage", async ($, on) => {
  mock.store(on, { style: 'bloom' })
  mock.env(on, UNKNOWN)
  const blits: (Blit & { at: number })[] = []
  let at = 0
  on('ui.blit', ($, e) => {
    blits.push({ ...(e as unknown as Blit), at })
    return { value: {} }
  })
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal', viewport: FULLSCREEN })
  // The times the line's clock posts, a frame apart. The kit's Date is frozen,
  // so the test posts them for the clock.
  for (at = bloom.frameMs; at <= 4000; at += bloom.frameMs) await ui.post({ t: at, tag: 'bloom', text: 'Sauteing…' }, { in: 'line' })
  const changes = [560, 1040, 1520, 2000, 3200, 3760]
  expect(blits.map(b => [b.key, b.at])).toEqual(changes.map(t => ['glyph', t]))
  expect(blits.map(b => b.source)).toEqual(changes.map(t => bloom.sprite!(t)))
  expect(blits[4]!.at - blits[3]!.at).toBe(1200)

  await ui.redraw({ ...SPINNER.props, mode: 'responding' })
  const image = await ui.find({ type: 'Image' })
  expect(image?.props.source).toEqual(blits.at(-1)?.source)
  expect(image?.props.alt).toBe('·')
  await ui.unmount()
})

test("bloom's clock is its text's: its ticks move the glyph on", async ($, on) => {
  mock.store(on, { style: 'bloom' })
  mock.env(on, UNKNOWN)
  const blits: Blit[] = []
  on('ui.blit', ($, e) => {
    blits.push(e as unknown as Blit)
    return { value: {} }
  })
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal', viewport: FULLSCREEN })
  // The seed holds 500 ms of wall time.
  for (let i = 0; i < 7; i++) await frameOn(ui, bloom.frameMs)
  expect(blits.map(b => [b.key, b.source])).toEqual([['glyph', bloom.sprite!(500)]])
  await ui.unmount()
})

test('a terminal refusing the glyph picture gets bloom as temper text', async ($, on) => {
  mock.store(on, { style: 'bloom' })
  mock.env(on, UNKNOWN)
  on('ui.blit', () => ({ value: { deny: 'the terminal draws the alt here' } }))
  const ui = await $.ui.mount({ ...SPINNER, surface: 'terminal', viewport: FULLSCREEN })
  // A refused picture is sent again on the next frame, till the third refusal.
  for (const t of [500, 580]) await ui.post({ t, tag: 'bloom', text: 'Sauteing…' }, { in: 'line' })
  expect(await shape(ui)).toEqual(['Image:glyph', 'Client:line'])
  await ui.post({ t: 660, tag: 'bloom', text: 'Sauteing…' }, { in: 'line' })
  expect(await shape(ui)).toEqual(['Client:line'])
  const spans = (await ui.findAll({ type: 'Text', in: 'line' })).slice(1)
  expect(spans[0]?.text).toBe(textFrame(temper, 'Sauteing…', 'thinking', 0).glyph.text)
  expect((await textLine(ui)).word).toBe('Sauteing…')
  expect(new Set((await textLine(ui)).colours)).toEqual(new Set(['#000000']))
  await ui.unmount()
})

test('other surfaces get the engine spinner', async ($, on) => {
  mock.store(on, { style: 'holo' })
  mock.env(on, {})
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...SPINNER, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})
