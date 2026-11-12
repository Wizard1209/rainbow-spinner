import type { On } from 'claude-code'
import { type Engine, expect, type MockClock, mock, test } from 'claude-code/testing'
import { marker } from '../hooks/core/wezterm'

// The WezTerm route against a module that draws by its own ticks, as
// wezterm/rainbow-spinner.lua does, with no ack set by hand: while it runs,
// each read of `alive` sees a new tick; it draws a frame (a new ack) while the
// line is on screen and the state, renewed within the last 1.5 s, names a
// sheet, once that has held for one of its ticks: 20 ms if it drew within the
// last 1.5 s, else 500 ms. `screen.on` is false while the line is away.
const DIR = '/x'
const ACK = `${DIR}/pane-4.ack`
const STATE = `${DIR}/pane-4.state`
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

function folder(on: On, clock: MockClock) {
  const files = new Map<string, string>()
  const module = { runs: true, draws: true }
  const screen = { on: true, from: 0 }
  const writes = { state: 0 }
  let tick = 0
  let stateAt = -Infinity
  let liveFrom = -Infinity
  let lastDraw = -Infinity
  const names = (text: string | undefined) => /\nsheet=\S/.test(text ?? '')
  const picture = (text: string | undefined) => text?.match(/sheet=.*\nmade=\d+/)?.[0]
  on('fs.read', ($, e) => {
    if (module.runs && e.path === `${DIR}/alive`) files.set(e.path, `${++tick}`)
    const t = clock.now()
    if (module.runs && module.draws && screen.on && e.path === ACK && t - stateAt < 1500 && names(files.get(STATE))) {
      const since = Math.max(liveFrom, screen.from)
      if (t - since >= (since - lastDraw < 1500 ? 20 : 500)) (lastDraw = t), files.set(ACK, `${++tick}`)
    }
    const s = files.get(e.path)
    return s === undefined ? { deny: 'ENOENT' } : { value: s }
  })
  on('fs.write', ($, e) => {
    if (e.path === STATE) {
      const t = clock.now()
      if (!names(e.text)) liveFrom = Infinity
      else if (t - stateAt >= 1500 || !names(files.get(STATE)) || picture(files.get(STATE)) !== picture(e.text)) liveFrom = t
      stateAt = t
      writes.state++
    }
    files.set(e.path, e.text)
    return { value: undefined }
  })
  // Every line the mod logs: a refusal ("drew no frame") or any other error.
  const logs: string[] = []
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  const frames: string[] = []
  on('process.run', async ($, e) => {
    frames.push(String(e.argv.at(-1)))
    await clock.sleep(100)
    return ok
  })
  return { files, module, screen, writes, logs, frames, state: () => files.get(STATE)?.replace(/beat=\d+\n$/, '') }
}

type Child = { type: string; props?: { key?: string; props?: { clock?: boolean; tag?: string; text?: string } }; children?: string[] }
async function children(ui: { drawn: () => Promise<unknown> }) {
  return ((await ui.drawn()) as { children: Child[] }).children
}
async function shape(ui: { drawn: () => Promise<unknown> }) {
  return (await children(ui)).map(c => (c.type === 'Text' ? `Text ${c.children?.join('')}` : `${c.type}:${c.props?.key}`))
}
const TEXT = ['Client:line']
const MARKED = (cells: number) => ['Client:line', `Text ${marker(cells)}`, 'Client:tail']
const named = (cells: number, sheet: string, made: number) =>
  `pane=4\ncells=${cells}\nframeMs=40\ncount=43\nwidth=${cells * 25}\nheight=48\nsheet=${sheet}\nmade=${made}\n`
const none = (cells: number) => `pane=4\ncells=${cells}\nframeMs=0\ncount=0\nwidth=${cells * 25}\nheight=48\nsheet=\nmade=0\n`
const REFUSED = 'rainbow-spinner: the WezTerm module drew no frame of this word'

// The line's clock, as hooks/spinner-client.tsx runs it: it posts only while
// the drawn line carries `clock: true`, with that line's tag and text.
async function clockOf(ui: { drawn: () => Promise<unknown> }) {
  const line = (await children(ui)).find(c => c.props?.key === 'line')?.props?.props
  return line?.clock === true ? { tag: line.tag!, text: line.text! } : undefined
}

// The line drawn for a second with its word marked and the module drawing it.
async function marked($: Engine, on: On) {
  const clock = mock.clock(on)
  mock.store(on, { style: 'holo' })
  mock.env(on, WEZ)
  const shared = folder(on, clock)
  on('command.register', () => ({ value: { command: 'spinner' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(1200)
  const ui = await $.ui.mount(SPINNER)
  await clock.advance(300)
  const start = clock.now()
  // One post of the line's clock; only a line that carries the clock posts.
  const post = async () => {
    const line = await clockOf(ui)
    if (line === undefined) throw new Error('the drawn line carries no clock to post')
    await ui.post({ t: clock.now() - start, ...line }, { in: 'line' })
  }
  // The line's clock ticking every 40 ms for this long.
  const drawnFor = async (ms: number) => {
    for (const end = clock.now() + ms; clock.now() < end; ) {
      await clock.advance(40)
      if ((await clockOf(ui)) !== undefined) await post()
    }
  }
  await drawnFor(1000)
  expect([await shape(ui), shared.state(), shared.logs, shared.files.has(ACK)]).toEqual([MARKED(9), named(9, 'pane-4-0.png', 1), [], true])
  return { ...shared, clock, ui, post, drawnFor }
}

type Shared = Awaited<ReturnType<typeof marked>>

// The line away for `ms`, then back.
async function away(s: Shared, ms: number) {
  s.screen.on = false
  await s.clock.advance(ms)
  s.screen.on = true
  s.screen.from = s.clock.now()
}

// The line back after a pause, as at a new turn minutes later: its first
// calls are a render, one post and a render, or posts alone (the render then
// is the one the mod asks for). After 70 s the module has removed the pane's
// state and ack.
for (const [ms, first] of [
  [5000, 'a render'],
  [5000, 'a post'],
  [5000, 'posts'],
  [70000, 'a post'],
  [70000, 'posts'],
] as const)
  test(`back after ${ms / 1000} s with ${first} first: the word is marked again, nothing refused`, async ($, on) => {
    const s = await marked($, on)
    await away(s, ms)
    if (ms >= 60000) s.files.delete(STATE), s.files.delete(ACK)
    if (first !== 'posts') {
      if (first === 'a post') await s.post()
      await s.ui.redraw()
    }
    await s.drawnFor(2500)
    expect([await shape(s.ui), s.state(), s.logs, s.frames.length]).toEqual([MARKED(9), named(9, 'pane-4-0.png', 1), [], 1])
    await s.ui.unmount()
  })

test('a refusal judged on a word does not drop the word that replaces it while the refusal is handled', async ($, on) => {
  // The next state read held 50 ms: the one the third refusal makes before
  // the word is dropped.
  const hold = { ms: 0, clock: undefined as MockClock | undefined }
  on('state.get', async ($, e, next) => {
    const ms = hold.ms
    hold.ms = 0
    if (ms > 0) await hold.clock?.sleep(ms)
    return next(e)
  })
  const s = await marked($, on)
  hold.clock = s.clock
  s.module.draws = false
  while (s.logs.length < 2) await s.drawnFor(40)
  hold.ms = 50
  const posted = s.post()
  await s.clock.settle()
  expect(s.logs).toEqual([REFUSED, REFUSED, REFUSED])
  // Meanwhile the line's word changes and changes back: a new word of the
  // same text, which drawn() has not judged.
  await s.ui.redraw({ ...SPINNER.props, word: 'Brewing' })
  await s.ui.redraw({ ...SPINNER.props })
  await s.clock.advance(50)
  await posted
  await s.clock.advance(300)
  expect([await shape(s.ui), s.state()]).toEqual([MARKED(9), named(9, 'pane-4-0.png', 1)])
  await s.ui.unmount()
})

test('a word the module stops drawing while its line is drawn goes back to text within about DRAWN_MS, and the state names no sheet', async ($, on) => {
  const s = await marked($, on)
  s.module.draws = false
  const from = s.clock.now()
  while ((await shape(s.ui)).length > 1 && s.clock.now() - from < 5000) await s.drawnFor(40)
  expect(s.clock.now() - from).toBeLessThanOrEqual(1700)
  expect([await shape(s.ui), s.state(), s.logs, s.frames.length]).toEqual([TEXT, none(9), [REFUSED, REFUSED, REFUSED], 1])
  await s.ui.unmount()
})

test('a word dropped to text stays text over pauses and renders: no sheet written, the state left alone', async ($, on) => {
  const s = await marked($, on)
  s.module.draws = false
  await s.drawnFor(2500)
  expect([await shape(s.ui), s.state()]).toEqual([TEXT, none(9)])
  const before = s.writes.state
  for (let k = 0; k < 5; k++) {
    await away(s, 3000)
    await s.ui.redraw()
    await s.drawnFor(500)
  }
  expect([await shape(s.ui), s.state(), s.frames.length, s.writes.state - before, s.logs.length]).toEqual([TEXT, none(9), 1, 0, 3])
  await s.ui.unmount()
})
