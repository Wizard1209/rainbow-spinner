import type { On } from 'claude-code'
import { type Engine, expect, type MockClock, mock, test } from 'claude-code/testing'
import { fromBase64 } from '../hooks/core/rgba'
import { changed, marker, slotFor, stateText } from '../hooks/core/wezterm'

// The WezTerm route: the mod's side of the folder it shares with its WezTerm
// module (wezterm/, tested by tests/wezterm.test.lua).

test('the state is one field a line, beat last', () => {
  expect(stateText({ pane: '4', cells: 9, frameMs: 40, count: 43, width: 225, height: 48, sheet: 'pane-4-1.png', made: 2, beat: 7 })).toBe(
    'pane=4\ncells=9\nframeMs=40\ncount=43\nwidth=225\nheight=48\nsheet=pane-4-1.png\nmade=2\nbeat=7\n',
  )
  expect(stateText({ pane: '0', cells: 0, frameMs: 0, count: 0, width: 0, height: 48, sheet: undefined, made: 0, beat: 1 })).toBe(
    'pane=0\ncells=0\nframeMs=0\ncount=0\nwidth=0\nheight=48\nsheet=\nmade=0\nbeat=1\n',
  )
})

test('a word takes the slot that holds its sheet, else the one the state did not name last', () => {
  expect(slotFor([], undefined, 'A')).toBe(0)
  expect(slotFor(['A'], 0, 'B')).toBe(1)
  expect(slotFor(['A', 'B'], 1, 'C')).toBe(0)
  expect(slotFor(['A', 'B'], 0, 'C')).toBe(1)
  expect(slotFor(['A', 'B'], 1, 'A')).toBe(0)
})

test('a file has changed when it reads a new value; an empty read is a write caught halfway', () => {
  expect([changed(undefined, '5'), changed('5', '6'), changed('', '6'), changed('5', '5'), changed('5', ''), changed('5', undefined)]).toEqual([
    true,
    true,
    true,
    false,
    false,
    false,
  ])
})

const DIR = '/x'
const WEZ = { TERM_PROGRAM: 'WezTerm', RAINBOW_SPINNER_WEZTERM_DIR: DIR, WEZTERM_PANE: '4' }
const SPINNER = {
  plugin: 'rainbow-spinner',
  component: 'Spinner',
  requestId: 'main',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40, isFullscreen: false },
  props: { word: 'Sauteing', message: null, suffix: '…', mode: 'thinking' },
} as const
const ok = { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }

// The shared folder in memory, and a module that ticks between any two reads
// of `alive` (or none, when it does not run); a sheet takes 100 ms to write.
// Records every file touched.
function folder(on: On, clock: MockClock, runs = true) {
  const files = new Map<string, string>()
  const touched: string[] = []
  const frames: { argv: readonly string[]; init?: { stdin?: string } }[] = []
  let tick = 0
  on('fs.read', ($, e) => {
    touched.push(e.path)
    if (runs && e.path === `${DIR}/alive`) files.set(e.path, `${++tick}`)
    const s = files.get(e.path)
    return s === undefined ? { deny: 'ENOENT' } : { value: s }
  })
  on('fs.write', ($, e) => {
    touched.push(e.path)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', async ($, e) => {
    frames.push(e)
    await clock.sleep(100)
    return ok
  })
  return { files, touched, frames, state: () => files.get(`${DIR}/pane-4.state`)?.replace(/beat=\d+\n$/, '') }
}

// The row's children: a Client as `Client:key`, a Text as its text.
async function shape(ui: { drawn: () => Promise<unknown> }) {
  const tree = (await ui.drawn()) as { children: { type: string; props?: { key?: string }; children?: string[] }[] }
  return tree.children.map(c => (c.type === 'Text' ? `Text ${c.children?.join('')}` : `${c.type}:${c.props?.key}`))
}

const TEXT = ['Client:line']
const MARKED = (cells: number) => ['Client:line', `Text ${marker(cells)}`, 'Client:tail']
const named = (cells: number, sheet: string, made: number) => `pane=4\ncells=${cells}\nframeMs=40\ncount=43\nwidth=${cells * 25}\nheight=48\nsheet=${sheet}\nmade=${made}\n`
const none = (cells: number) => `pane=4\ncells=${cells}\nframeMs=0\ncount=0\nwidth=${cells * 25}\nheight=48\nsheet=\nmade=0\n`

async function start($: Engine, on: On) {
  on('command.register', () => ({ value: { command: 'spinner' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

async function holo($: Engine, on: On, runs = true) {
  const clock = mock.clock(on)
  mock.store(on, { style: 'holo' })
  mock.env(on, WEZ)
  const shared = folder(on, clock, runs)
  await start($, on)
  return { clock, ...shared }
}

test('a word is text until its sheet is written and named and the module has looked; then its cells are marked', async ($, on) => {
  const { clock, frames, state } = await holo($, on)
  await clock.advance(1200)
  const ui = await $.ui.mount(SPINNER)
  expect(await shape(ui)).toEqual(TEXT)
  await clock.advance(300)
  expect(await shape(ui)).toEqual(MARKED(9))
  expect(state()).toBe(named(9, 'pane-4-0.png', 1))
  // One PNG of 9 × 25 by 43 × 48 pixels.
  const png = fromBase64(frames[0]?.init?.stdin ?? '')
  const size = new DataView(png.buffer, 16, 8)
  expect(frames.map(f => f.argv.at(-1))).toEqual([`${DIR}/pane-4-0.png`])
  expect([size.getUint32(0), size.getUint32(4)]).toEqual([225, 43 * 48])
  await ui.unmount()
})

test("a new word takes the old picture away at once, gets the other slot, and a word seen before keeps its sheet", async ($, on) => {
  const { clock, frames, state } = await holo($, on)
  await clock.advance(1200)
  const ui = await $.ui.mount(SPINNER)
  await clock.advance(300)
  await ui.redraw({ ...SPINNER.props, word: 'Brewing' })
  await clock.settle()
  expect([await shape(ui), state()]).toEqual([TEXT, none(8)])
  await clock.advance(300)
  expect([await shape(ui), state()]).toEqual([MARKED(8), named(8, 'pane-4-1.png', 2)])
  await ui.redraw({ ...SPINNER.props })
  await clock.settle()
  expect([await shape(ui), state()]).toEqual([TEXT, named(9, 'pane-4-0.png', 1)])
  await clock.advance(300)
  expect([await shape(ui), state()]).toEqual([MARKED(9), named(9, 'pane-4-0.png', 1)])
  expect(frames).toHaveLength(2)
  await ui.unmount()
})

test("a word the module does not draw goes back to text, and the state stops naming its sheet", async ($, on) => {
  const { clock, files, state } = await holo($, on)
  await clock.advance(1200)
  const ui = await $.ui.mount(SPINNER)
  await clock.advance(300)
  // The line's clock posts every 40 ms while the word is marked: only then
  // does the drawn line carry the clock.
  let t = 0
  const drawnFor = async (ms: number) => {
    for (const end = clock.now() + ms; clock.now() < end; ) {
      await clock.advance(40)
      if ((await shape(ui)).length > 1) await ui.post({ t: (t += 40), tag: 'holo', text: 'Sauteing…' }, { in: 'line' })
    }
  }
  files.set(`${DIR}/pane-4.ack`, 'a')
  await drawnFor(40)
  await drawnFor(1400)
  files.set(`${DIR}/pane-4.ack`, '')
  await drawnFor(40)
  expect(await shape(ui)).toEqual(MARKED(9))
  await drawnFor(1600)
  await clock.settle()
  expect([await shape(ui), state()]).toEqual([TEXT, none(9)])
  await ui.unmount()
})

test("the posts of a drawn line's clock renew the state and read the ack once every 300 ms", async ($, on) => {
  const { clock, touched } = await holo($, on)
  await clock.advance(1200)
  const ui = await $.ui.mount(SPINNER)
  await clock.advance(300)
  touched.length = 0
  for (let t = 40; t <= 920; t += 40) {
    await ui.post({ t, tag: 'holo', text: 'Sauteing…' }, { in: 'line' })
    await clock.advance(40)
  }
  expect([touched.filter(p => p.endsWith('.ack')).length, touched.filter(p => p.endsWith('.state')).length]).toEqual([3, 3])
  await ui.unmount()
})

test('a word that comes back after its line was away is text until the module has looked again', async ($, on) => {
  const { clock, files, frames, state } = await holo($, on)
  await clock.advance(1200)
  let ui = await $.ui.mount(SPINNER)
  await clock.advance(300)
  files.set(`${DIR}/pane-4.ack`, 'a')
  await ui.post({ t: 40, tag: 'holo', text: 'Sauteing…' }, { in: 'line' })
  expect(await shape(ui)).toEqual(MARKED(9))
  await ui.unmount()
  await clock.advance(5000)
  ui = await $.ui.mount(SPINNER)
  expect(await shape(ui)).toEqual(TEXT)
  await clock.advance(300)
  expect([await shape(ui), state()]).toEqual([MARKED(9), named(9, 'pane-4-0.png', 1)])
  for (const t of [80, 120, 160]) await ui.post({ t, tag: 'holo', text: 'Sauteing…' }, { in: 'line' })
  await clock.settle()
  expect(await shape(ui)).toEqual(MARKED(9))
  expect(frames).toHaveLength(1)
  await ui.unmount()
})

test('/spinner holo answers whether the module runs, and draws the box where it does not', async ($, on) => {
  const { clock } = await holo($, on, false)
  const reply = $.command.run({ command: 'spinner', args: 'holo', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await clock.advance(1200)
  expect((await reply).text).toStartWith("spinner: holo → temper · WezTerm shows pictures only through the mod's WezTerm module (the module is ")
  const ui = await $.ui.mount(SPINNER)
  expect(await shape(ui)).toEqual(TEXT)
  await ui.unmount()
})

for (const [without, env] of [
  ['the folder', { TERM_PROGRAM: 'WezTerm', WEZTERM_PANE: '4' }],
  ['the pane', { TERM_PROGRAM: 'WezTerm', RAINBOW_SPINNER_WEZTERM_DIR: DIR }],
  ['the pane', { TERM_PROGRAM: 'WezTerm', RAINBOW_SPINNER_WEZTERM_DIR: DIR, WEZTERM_PANE: '' }],
] as const) {
  test(`without ${without} in the environment no file is read or written (${Object.keys(env).length} variables)`, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on, { style: 'holo' })
    mock.env(on, env)
    const { touched } = folder(on, clock)
    await start($, on)
    await clock.advance(1200)
    const ui = await $.ui.mount(SPINNER)
    await clock.advance(1500)
    expect(await shape(ui)).toEqual(TEXT)
    await ui.unmount()
    expect(touched).toEqual([])
  })
}
