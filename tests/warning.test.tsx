import type { On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'
import { box, check, classify, type Env, row as rowOf } from '../hooks/core/caps'
import { FALLBACK, findStyle } from '../hooks/styles'

// A /spinner switch on each terminal: the row it prints, the box the row draws
// as where there is something to ask Claude for, and the line drawn after it,
// which agree. The words are the core's: tests/caps.test.ts pins them.

const SCREEN = (isFullscreen: boolean) => ({ columns: 120, rows: 40, isFullscreen })

async function run($: Engine, args: string, fullscreen: boolean) {
  const { text } = await $.command.run({ command: 'spinner', args, origin: { kind: 'composer' }, presentation: { isFullscreen: fullscreen, columns: 120 } })
  return text ?? ''
}

// The engine's own row, beneath the mod's hook.
function engineRow(on: On) {
  on('ui.render', { component: 'CommandOutput' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`engine: ${e.props.text}`}</Text>
  })
}

// What the row draws: `box: <its one text>`, or the engine's row. The row's
// text comes as the engine keeps it, under the plugin's name, unless `named`
// is ''.
async function row($: Engine, text: string, fullscreen: boolean, surface: 'terminal' | 'desktop' = 'terminal', named = 'rainbow-spinner: ') {
  const ui = await $.ui.mount({
    plugin: 'rainbow-spinner',
    component: 'CommandOutput',
    surface,
    viewport: SCREEN(fullscreen),
    props: { command: 'spinner', args: '', text: `${named}${text}`, isErrored: false },
  })
  const boxes = await ui.findAll({ type: 'Box' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  return boxes.length === 0 ? texts.join('') : `box: ${texts.join('|')}`
}

// The spinner line's parts as `type:key`, with the style a text part is drawn in.
async function line($: Engine, fullscreen: boolean) {
  const ui = await $.ui.mount({
    plugin: 'rainbow-spinner',
    component: 'Spinner',
    requestId: 'main',
    surface: 'terminal',
    viewport: SCREEN(fullscreen),
    props: { word: 'Sauteing', message: null, suffix: '…', mode: 'thinking' },
  })
  const tree = (await ui.drawn()) as { children: { type: string; props: { key?: string; props?: { tag?: string } } }[] }
  await ui.unmount()
  return tree.children.map(c => `${c.type}:${c.props.key}${c.props.props?.tag ? ` ${c.props.props.tag}` : ''}`).join(', ')
}

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const profiles = (font: string) => JSON.stringify([{ Name: 'Default', 'Normal Font': font, 'Use Non-ASCII Font': false }])

// iTerm2 whose profile draws in the font fontNow() names at each read.
function iterm(on: On, fontNow: () => string, env: Env & { ITERM_PROFILE: string; HOME: string } = ITERM) {
  mock.env(on, env)
  on('process.run', () => ok(profiles(fontNow())))
}

const KITTY = { KITTY_WINDOW_ID: '1', TERM: 'xterm-kitty' }
const ITERM = { TERM_PROGRAM: 'iTerm.app', ITERM_PROFILE: 'Default', HOME: '/Users/someone' }
const FORCED = { ...ITERM, CLAUDE_CODE_NO_FLICKER: '0' }
const WEZ = { TERM_PROGRAM: 'WezTerm' }
const PLAIN = 'Menlo-Regular 20'
// The module file the WezTerm row names: the mod's own, in this folder.
const MODULE = new URL('../wezterm/rainbow-spinner.lua', (import.meta as { url: string }).url).pathname
const HOLO_PICTURE = 'Client:line holo, Image:word, Client:tail holo'
const TEMPER = 'Client:line temper'

// What the core says for a style on a terminal: the row, and what the row draws as.
function said(tag: string, env: Env, fullscreen: boolean, itermFont?: string) {
  const weztermModule = env === WEZ ? { runs: false, file: MODULE } : undefined
  const v = check(findStyle(tag)!, classify({ env, fullscreen, itermFont: itermFont ?? (env === ITERM || env === FORCED ? PLAIN : undefined), imagesRefused: false, weztermModule }), FALLBACK)
  const b = box(tag, v)
  return { row: rowOf(tag, v), drawn: b === undefined ? `engine: rainbow-spinner: ${rowOf(tag, v)}` : `box: ${b.join('|')}` }
}

for (const [name, env, fullscreen, style, boxed, shown] of [
  ['kitty', KITTY, false, 'holo', false, HOLO_PICTURE],
  ['kitty', KITTY, false, 'bloom', false, 'Client:line bloom'],
  ['iTerm2 fullscreen', ITERM, true, 'holo', false, HOLO_PICTURE],
  ['iTerm2 on the main screen', ITERM, false, 'holo', true, TEMPER],
  ['iTerm2 on the main screen', ITERM, false, 'bloom', true, TEMPER],
  ['iTerm2 with the main screen forced', FORCED, false, 'holo', true, TEMPER],
  ['WezTerm', WEZ, false, 'bloom', false, 'Client:line bloom'],
  ['WezTerm without the module', WEZ, false, 'holo', true, TEMPER],
  ['Terminal.app', { TERM_PROGRAM: 'Apple_Terminal' }, false, 'holo', false, TEMPER],
  ['Terminal.app', { TERM_PROGRAM: 'Apple_Terminal' }, false, 'bloom', false, TEMPER],
  ['a terminal that names nothing', {}, false, 'holo', false, HOLO_PICTURE],
] as const)
  test(`${name}, /spinner ${style}: ${boxed ? 'a box' : 'the row'}`, async ($, on) => {
    mock.store(on)
    if (env === ITERM || env === FORCED) iterm(on, () => PLAIN, env as typeof FORCED)
    else mock.env(on, env)
    engineRow(on)
    const text = await run($, style, fullscreen)
    const expected = said(style, env, fullscreen)
    expect([text, await row($, text, fullscreen), await line($, fullscreen)]).toEqual([expected.row, expected.drawn, shown])
    expect(expected.drawn.startsWith('box: ')).toBe(boxed)
  })

test('the box: the reasons in grey, then the ask in the text colour, in a round warning border', async ($, on) => {
  mock.store(on)
  iterm(on, () => PLAIN)
  const text = await run($, 'bloom', false)
  const ui = await $.ui.mount({ plugin: 'rainbow-spinner', component: 'CommandOutput', surface: 'terminal', viewport: SCREEN(false), props: { command: 'spinner', args: '', text, isErrored: false } })
  const [frame] = await ui.findAll({ type: 'Box' })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  expect([frame?.props.borderStyle, frame?.props.borderColor, frame?.props.flexDirection]).toEqual(['round', 'warning', 'column'])
  const [reasons, ask] = said('bloom', ITERM, false).drawn.slice('box: '.length).split('|')
  expect(texts.map(t => [t.text, t.props.color])).toEqual([
    [reasons, 'inactive'],
    [ask, 'text'],
  ])
})

test('an ask done takes the box away: the row is drawn plain once the terminal can show the style', async ($, on) => {
  mock.store(on)
  let font = PLAIN
  iterm(on, () => font)
  engineRow(on)
  const holo = await run($, 'holo', false)
  // After /tui fullscreen the session is resumed fullscreen.
  expect([await row($, holo, false), await row($, holo, true)]).toEqual([said('holo', ITERM, false).drawn, `engine: rainbow-spinner: ${holo}`])

  const bloom = await run($, 'bloom', false)
  expect(await row($, bloom, false)).toEqual(said('bloom', ITERM, false).drawn)
  font = 'SymbolsNFM 13'
  // The next /spinner reads the profile again.
  expect(await run($, 'bloom', false)).toBe(said('bloom', ITERM, false, font).row)
  expect([await row($, bloom, false), await line($, false)]).toEqual([`engine: rainbow-spinner: ${bloom}`, 'Client:line bloom'])
})

test('a box is about the chosen style: once another is chosen, the old row is drawn plain', async ($, on) => {
  mock.store(on)
  iterm(on, () => PLAIN)
  engineRow(on)
  const holo = await run($, 'holo', false)
  expect(await row($, holo, false)).toBe(said('holo', ITERM, false).drawn)
  await run($, 'temper', false)
  expect(await row($, holo, false)).toBe(`engine: rainbow-spinner: ${holo}`)
  await run($, 'off', false)
  expect(await row($, holo, false)).toBe(`engine: rainbow-spinner: ${holo}`)
  await run($, 'holo', false)
  expect(await row($, holo, false)).toBe(said('holo', ITERM, false).drawn)
})

test('rows that are not a put-off style, and other surfaces, are the engine’s', async ($, on) => {
  mock.store(on)
  iterm(on, () => PLAIN)
  engineRow(on)
  const holo = await run($, 'holo', false)
  for (const text of ['spinner: holo', 'spinner: off', 'spinner: holo; styles: off, temper, holo, bloom', 'spinner: no style "x"; styles: off, temper, holo, bloom', 'spinner: rainbow → temper'])
    expect(await row($, text, false)).toBe(`engine: rainbow-spinner: ${text}`)
  expect(await row($, holo, false, 'desktop')).toBe(`engine: rainbow-spinner: ${holo}`)
  // A row without its reasons still draws the box.
  expect(await row($, 'spinner: holo → temper', false)).toBe(said('holo', ITERM, false).drawn)
})

test('the row draws the same whether its text comes under the plugin’s name or bare', async ($, on) => {
  mock.store(on)
  iterm(on, () => PLAIN)
  engineRow(on)
  const holo = await run($, 'holo', false)
  const drawn = said('holo', ITERM, false).drawn
  expect([await row($, holo, false, 'terminal', ''), await row($, holo, false)]).toEqual([drawn, drawn])
  expect(await row($, 'spinner: holo', false, 'terminal', '')).toBe('engine: spinner: holo')
})
