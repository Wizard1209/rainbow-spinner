import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { SAY } from '../hooks/core/caps'
import { TAGS } from '../hooks/styles'

const SPINNER = {
  plugin: 'rainbow-spinner',
  component: 'Spinner',
  requestId: 'main',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40, isFullscreen: true },
  props: { word: 'Sauteing', message: null, suffix: '…', mode: 'thinking' },
} as const

// /spinner as typed at the prompt.
const TYPED = { command: 'spinner', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

// The engine's own drawing, beneath the mod's hooks.
function engine(on: On) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

test('/spinner is registered with the styles as its hint', async ($, on) => {
  const registered: unknown[] = []
  on('command.register', ($, e) => {
    registered.push(e)
    return { value: { command: 'spinner' } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual([expect.objectContaining({ name: 'spinner', argumentHint: '[off|temper|holo|bloom]' })])
})

test('/spinner offers off, temper, holo and bloom', () => {
  expect(TAGS).toEqual(['off', 'temper', 'holo', 'bloom'])
})

// With nothing stored the style is off: the spinner line is the engine's, and
// the mod reads nothing of the terminal, writes nothing and mounts nothing
// that ticks.
test('with nothing stored, the spinner line is the engine\'s and the mod adds nothing', async ($, on) => {
  // An empty store and a terminal, each call to them recorded.
  const calls: string[] = []
  on('store.get', ($, e) => {
    calls.push(`store.get ${e.key}`)
    return { value: null }
  })
  for (const kind of ['store.set', 'store.delete', 'store.keys', 'env.get', 'process.run', 'ui.blit'] as const)
    on(kind, () => {
      calls.push(kind)
      return { value: undefined }
    })
  engine(on)

  const line = await $.ui.mount(SPINNER)
  expect(await line.drawn()).toEqual(expect.objectContaining({ type: 'Text' }))
  expect((await line.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['engine'])
  await line.advance(1000)
  await line.unmount()

  // The choice, read at each drawing: nothing else.
  expect(new Set(calls)).toEqual(new Set(['store.get style']))
})

test('/spinner holo switches the line to holo and keeps it', async ($, on) => {
  mock.store(on)
  mock.env(on, {})
  const before = await $.ui.mount(SPINNER)
  expect(await before.findAll({ type: 'Image' })).toHaveLength(0)
  await before.unmount()

  expect((await $.command.run({ ...TYPED, args: 'holo' })).text).toBe(SAY.shown('holo'))
  const after = await $.ui.mount(SPINNER)
  expect(await after.findAll({ type: 'Image' })).toHaveLength(1)
  await after.unmount()
})

test('/spinner off stores off, answers "spinner: off", and the engine draws the line again', async ($, on) => {
  mock.store(on, { style: 'holo' })
  mock.env(on, {})
  engine(on)
  expect((await $.command.run({ ...TYPED, args: 'off' })).text).toBe('spinner: off')
  const ui = await $.ui.mount(SPINNER)
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['engine'])
  await ui.unmount()
  expect((await $.command.run({ ...TYPED, args: '' })).text).toBe(SAY.current('off', TAGS))
})

test('a bare /spinner names the style that is on, lists the styles, and changes nothing', async ($, on) => {
  mock.store(on)
  mock.env(on, {})
  expect((await $.command.run({ ...TYPED, args: '' })).text).toBe('spinner: off; styles: off, temper, holo, bloom')
  await $.command.run({ ...TYPED, args: 'holo' })
  for (const args of ['', '  ']) expect((await $.command.run({ ...TYPED, args })).text).toBe('spinner: holo; styles: off, temper, holo, bloom')
  const ui = await $.ui.mount(SPINNER)
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(1)
  await ui.unmount()
})

test('a kept bloom is bloom', async ($, on) => {
  mock.store(on, { style: 'bloom' })
  mock.env(on, { KITTY_WINDOW_ID: '1' })
  const ui = await $.ui.mount(SPINNER)
  // bloom is in colour from the first frame, its seed first; temper would rest in black.
  const spans = (await ui.findAll({ type: 'Text', in: 'line' })).slice(1)
  expect(spans.map(t => t.text).join('')).toMatch(/^\u{F0E62} Sauteing…/u)
  expect(spans.map(t => t.props.color)).not.toContain('#000000')
  await ui.unmount()
  expect((await $.command.run({ ...TYPED, args: '' })).text).toBe(SAY.current('bloom', TAGS))
})

test('a kept tag that names no style is off', async ($, on) => {
  mock.store(on, { style: 'rainbow' })
  mock.env(on, {})
  engine(on)
  const ui = await $.ui.mount(SPINNER)
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['engine'])
  await ui.unmount()
  expect((await $.command.run({ ...TYPED, args: '' })).text).toBe(SAY.current('off', TAGS))
})

test('an unknown style lists the styles and changes nothing', async ($, on) => {
  mock.store(on, { style: 'holo' })
  mock.env(on, {})
  expect((await $.command.run({ ...TYPED, args: 'no-such-style' })).text).toBe('spinner: no style "no-such-style"; styles: off, temper, holo, bloom')
  expect((await $.command.run({ ...TYPED, args: '' })).text).toBe(SAY.current('holo', TAGS))
})
