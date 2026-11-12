import type { On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'

// Which terminals bloom draws as Nerd Font text (one Client, the whole line),
// which with its glyph as a picture, and which as temper text.

const SPINNER = {
  plugin: 'rainbow-spinner',
  component: 'Spinner',
  requestId: 'main',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40, isFullscreen: true },
  props: { word: 'Sauteing', message: null, suffix: '…', mode: 'thinking' },
} as const
const TEXT = ['Client:line bloom']
const PICTURE = ['Image:glyph', 'Client:line bloom']
const TEMPER = ['Client:line temper']
const said = (expected: readonly string[]) => (expected === TEXT ? 'text' : expected === PICTURE ? 'a picture' : 'temper text')

// The row's children as `type:key`, and the style a text part is drawn in.
async function drawn($: Engine): Promise<string[]> {
  const ui = await $.ui.mount(SPINNER)
  const tree = (await ui.drawn()) as { children: { type: string; props: { key?: string; props?: { tag?: string } } }[] }
  await ui.unmount()
  return tree.children.map(c => `${c.type}:${c.props.key}${c.props.props?.tag ? ` ${c.props.props.tag}` : ''}`)
}

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// iTerm2's profiles as plutil prints them; only the keys the mod reads.
const PROFILES = [
  { Name: 'Default', Guid: 'g-default', 'Normal Font': 'Monaco 12', 'Non Ascii Font': 'Monaco 12', 'Use Non-ASCII Font': false },
  { Name: 'Meslo', Guid: 'g-meslo', 'Normal Font': 'MesloLGS-NF-Regular 13', 'Non Ascii Font': 'Monaco 12', 'Use Non-ASCII Font': false },
  { Name: 'JetBrains', Guid: 'g-jb', 'Normal Font': 'JetBrainsMonoNerdFontMono-Regular 13', 'Non Ascii Font': 'Monaco 12', 'Use Non-ASCII Font': 0 },
  { Name: 'Menlo', Guid: 'g-menlo', 'Normal Font': 'Menlo-Regular 20', 'Non Ascii Font': 'Monaco 12', 'Use Non-ASCII Font': 0 },
  { Name: 'Icons past ASCII', Guid: 'g-icons', 'Normal Font': 'Menlo-Regular 13', 'Non Ascii Font': 'SymbolsNFM 13', 'Use Non-ASCII Font': true },
  { Name: 'Nerd but not past ASCII', Guid: 'g-split', 'Normal Font': 'Hack Nerd Font Mono 13', 'Non Ascii Font': 'Monaco 12', 'Use Non-ASCII Font': 1 },
]
const ITERM = { TERM_PROGRAM: 'iTerm.app', HOME: '/Users/someone' }
const PREFS = '/Users/someone/Library/Preferences/com.googlecode.iterm2.plist'

// Answers the plist reads; records each argv.
function iterm(on: On, defaultGuid = 'g-default') {
  const runs: (readonly string[])[] = []
  on('process.run', ($, e) => {
    runs.push(e.argv)
    const key = e.argv[2]
    return ok(key === 'New Bookmarks' ? JSON.stringify(PROFILES) : `${defaultGuid}\n`)
  })
  return runs
}

for (const [name, env, expected] of [
  ['kitty', { KITTY_WINDOW_ID: '3', TERM: 'xterm-kitty' }, TEXT],
  ['kitty under tmux', { KITTY_WINDOW_ID: '3', TERM_PROGRAM: 'tmux' }, TEXT],
  ['Ghostty', { TERM_PROGRAM: 'ghostty' }, TEXT],
  ['WezTerm', { TERM_PROGRAM: 'WezTerm' }, TEXT],
  ['Terminal.app', { TERM_PROGRAM: 'Apple_Terminal' }, TEMPER],
  ['a terminal that names nothing', {}, PICTURE],
] as const)
  test(`${name}: bloom is ${said(expected)}`, async ($, on) => {
    mock.store(on, { style: 'bloom' })
    mock.env(on, env)
    expect(await drawn($)).toEqual(expected)
  })

for (const [profile, expected] of [
  ['Meslo', TEXT],
  ['JetBrains', TEXT],
  ['Icons past ASCII', TEXT],
  ['Menlo', PICTURE],
  ['Default', PICTURE],
  ['Nerd but not past ASCII', PICTURE],
  ['a profile iTerm2 does not list', PICTURE],
] as const)
  test(`iTerm2 fullscreen with the profile ${profile}: bloom is ${said(expected)}`, async ($, on) => {
    mock.store(on, { style: 'bloom' })
    mock.env(on, { ...ITERM, ITERM_PROFILE: profile })
    const runs = iterm(on)
    expect(await drawn($)).toEqual(expected)
    expect(runs).toEqual([['plutil', '-extract', 'New Bookmarks', 'json', '-o', '-', PREFS]])
  })

test("iTerm2 without ITERM_PROFILE reads the default profile's fonts", async ($, on) => {
  mock.store(on, { style: 'bloom' })
  mock.env(on, ITERM)
  const runs = iterm(on, 'g-meslo')
  expect(await drawn($)).toEqual(TEXT)
  expect(runs.map(argv => argv[2])).toEqual(['New Bookmarks', 'Default Bookmark Guid'])
})

for (const [failure, answer] of [
  ['plutil cannot run', { deny: 'no such command' }],
  ['plutil fails', { value: { exitCode: 1, stdout: '', stderr: 'No value at that key path', isStdoutTruncated: false, isStderrTruncated: false } }],
  ['plutil prints no JSON', ok('Could not extract')],
  ['the profiles are not a list', ok('{}')],
] as const)
  test(`iTerm2 fullscreen where ${failure}: bloom is a picture`, async ($, on) => {
    mock.store(on, { style: 'bloom' })
    mock.env(on, { ...ITERM, ITERM_PROFILE: 'Meslo' })
    on('process.run', () => answer)
    expect(await drawn($)).toEqual(PICTURE)
  })

test('the terminal is asked once a session, and again at each /spinner', async ($, on) => {
  mock.store(on, { style: 'temper' })
  mock.env(on, { ...ITERM, ITERM_PROFILE: 'Meslo' })
  const runs = iterm(on)
  await drawn($)
  await drawn($)
  expect(runs).toHaveLength(1)
  await $.command.run({ command: 'spinner', args: 'bloom', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  for (let i = 0; i < 3; i++) expect(await drawn($)).toEqual(TEXT)
  expect(runs).toHaveLength(2)
})

test('only iTerm2 has its profile read', async ($, on) => {
  mock.store(on, { style: 'bloom' })
  mock.env(on, { TERM_PROGRAM: 'WezTerm', HOME: '/Users/someone' })
  const runs = iterm(on)
  await drawn($)
  expect(runs).toHaveLength(0)
})
