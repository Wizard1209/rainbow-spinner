import { expect, test } from 'claude-code/testing'
import { type Caps, type Env, type Facts, type Has, type Missing, type Verdict, type Why, box, check, classify, itermFont, needs, row, SAY, terminal } from '../hooks/core/caps'
import type { Style } from '../hooks/core/style'
import { bloom } from '../hooks/styles/bloom'
import { holo } from '../hooks/styles/holo'
import { FALLBACK, STYLES, TAGS } from '../hooks/styles/index'
import { temper } from '../hooks/styles/temper'

type Reason = keyof typeof SAY.why
const facts = (env: Env, more: Partial<Facts> = {}): Facts => ({ env, fullscreen: false, itermFont: undefined, imagesRefused: false, ...more })
const nameOf = (why: Why) => (Object.keys(SAY.why) as Reason[]).find(k => SAY.why[k] === why)
const askOf = (ask: string) => (Object.keys(SAY.why) as Reason[]).find(k => (SAY.why[k] as Why).ask === ask)
// A verdict as the table writes it: ok and the glyph, or the fallback, the reasons and the ask.
const say = (v: Verdict) =>
  v.ok
    ? v.plan.glyph === 'own' ? 'ok' : `ok, ${v.plan.glyph} glyph`
    : `→ ${v.instead}: ${v.why.map(m => nameOf(m.no)).join(' + ')}${v.ask === undefined ? '' : `, ask ${askOf(v.ask)}`}`
const verdict = (style: Style, f: Facts) => check(style, classify(f), FALLBACK)

const KITTY = { KITTY_WINDOW_ID: '1', TERM: 'xterm-kitty' }
const ITERM = { TERM_PROGRAM: 'iTerm.app' }
const PLAIN = { itermFont: 'Menlo-Regular 20' }
const NERDY = { itermFont: 'SymbolsNFM 13' }
const WEZ = { TERM_PROGRAM: 'WezTerm' }
const MODULE = '/plugins/rainbow-spinner/wezterm/rainbow-spinner.lua'
const NO_MODULE = { weztermModule: { runs: false, file: MODULE } }
const MODULE_RUNS = { weztermModule: { runs: true, file: MODULE } }
const REFUSED = { imagesRefused: true }
const MAIN = '→ temper: mainScreen, ask mainScreen'

// The expected verdicts: terminal and state, holo, bloom.
const TABLE: readonly (readonly [string, Facts, string, string])[] = [
  ['kitty', facts(KITTY), 'ok', 'ok, nerd glyph'],
  ['Ghostty', facts({ TERM_PROGRAM: 'ghostty' }), 'ok', 'ok, nerd glyph'],
  ['iTerm2 fullscreen, plain font', facts(ITERM, { fullscreen: true, ...PLAIN }), 'ok', 'ok, picture glyph'],
  ['iTerm2 fullscreen, Nerd font', facts(ITERM, { fullscreen: true, ...NERDY }), 'ok', 'ok, nerd glyph'],
  ['iTerm2 main screen, plain font', facts(ITERM, PLAIN), MAIN, '→ temper: itermFont + mainScreen, ask mainScreen'],
  ['iTerm2 main screen, Nerd font', facts(ITERM, NERDY), MAIN, 'ok, nerd glyph'],
  ['iTerm2, NO_FLICKER=0, plain font', facts({ ...ITERM, CLAUDE_CODE_NO_FLICKER: '0' }, PLAIN), MAIN, '→ temper: itermFont + mainScreen, ask mainScreen'],
  ['iTerm2, DISABLE_ALTERNATE_SCREEN=1, Nerd font', facts({ ...ITERM, CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' }, NERDY), MAIN, 'ok, nerd glyph'],
  ['iTerm2, font unreadable', facts(ITERM, { itermFont: null }), MAIN, '→ temper: unknownFont + mainScreen, ask mainScreen'],
  ['WezTerm', facts(WEZ, NO_MODULE), '→ temper: weztermModule, ask weztermModule', 'ok, nerd glyph'],
  ["WezTerm with the mod's module", facts(WEZ, MODULE_RUNS), 'ok', 'ok, nerd glyph'],
  ['Windows Terminal', facts({ WT_SESSION: 'abc' }), '→ temper: unsupported', '→ temper: unknownFont + unsupported'],
  ['Terminal.app', facts({ TERM_PROGRAM: 'Apple_Terminal' }), '→ temper: unsupported', '→ temper: unknownFont + unsupported'],
  ['tmux without KITTY_WINDOW_ID', facts({ TERM_PROGRAM: 'tmux', TMUX: '/tmp/tmux-501/default,1,0' }), 'ok', 'ok, picture glyph'],
  ['tmux in iTerm2, plain font', facts({ TERM_PROGRAM: 'tmux', LC_TERMINAL: 'iTerm2', TMUX: '/tmp/tmux-501/default,1,0' }, PLAIN), 'ok', 'ok, picture glyph'],
  ['tmux in iTerm2, Nerd font', facts({ TERM_PROGRAM: 'tmux', LC_TERMINAL: 'iTerm2', TMUX: '/tmp/tmux-501/default,1,0' }, NERDY), 'ok', 'ok, nerd glyph'],
  ['VS Code started from an iTerm2 shell', facts({ TERM_PROGRAM: 'vscode', LC_TERMINAL: 'iTerm2' }), 'ok', 'ok, picture glyph'],
  ['an unknown terminal', facts({}), 'ok', 'ok, picture glyph'],
  ['kitty, refused', facts(KITTY, REFUSED), '→ temper: refused', 'ok, nerd glyph'],
  ['iTerm2 fullscreen, refused, plain font', facts(ITERM, { fullscreen: true, ...PLAIN, ...REFUSED }), '→ temper: refused', '→ temper: itermFont + refused'],
  ['an unknown terminal, refused', facts({}, REFUSED), '→ temper: refused', '→ temper: unknownFont + refused'],
]

for (const [name, f, holoSays, bloomSays] of TABLE)
  test(`${name}: holo ${holoSays}, bloom ${bloomSays}`, () => {
    expect([say(verdict(holo, f)), say(verdict(bloom, f))]).toEqual([holoSays, bloomSays])
  })

// Each ask, done, as classify will next see it.
const DONE: Partial<Record<Reason, (f: Facts) => Facts>> = {
  mainScreen: f => ({ ...f, fullscreen: true }),
  weztermModule: f => ({ ...f, ...MODULE_RUNS }),
}

test('every ask a verdict makes turns it ok once done, and each ask is made somewhere', () => {
  const asked = new Set<Reason>()
  for (const [, f] of TABLE)
    for (const style of STYLES) {
      const v = verdict(style, f)
      if (v.ok || v.ask === undefined) continue
      const reason = askOf(v.ask)!
      asked.add(reason)
      expect([style.tag, verdict(style, DONE[reason]!(f)).ok]).toEqual([style.tag, true])
    }
  const asks = (Object.keys(SAY.why) as Reason[]).filter(k => 'ask' in SAY.why[k])
  expect([...asked].sort()).toEqual(asks.sort())
  expect(Object.keys(DONE).sort()).toEqual(asks.sort())
})

// The boxes and rows, word for word: a change of wording is the table in caps.ts and this.
test('the words: every row and box /spinner gives', () => {
  const FORBIDDEN = { CLAUDE_CODE_NO_FLICKER: '0' }
  const MAIN_BOX = ["The holo style is drawn as temper: iTerm2 shows pictures only in Claude Code's fullscreen mode.", 'Ask Claude to turn on fullscreen mode.']
  const cases: readonly (readonly [Style, Facts, string, readonly string[] | undefined])[] = [
    [holo, facts(ITERM, PLAIN), "spinner: holo → temper · iTerm2 shows pictures only in Claude Code's fullscreen mode (the session is on the main screen and no environment variable forbids fullscreen)", MAIN_BOX],
    [holo, facts({ ...ITERM, ...FORBIDDEN }, PLAIN), "spinner: holo → temper · iTerm2 shows pictures only in Claude Code's fullscreen mode (CLAUDE_CODE_NO_FLICKER=0 forbids it)", MAIN_BOX],
    [
      bloom,
      facts(ITERM, PLAIN),
      "spinner: bloom → temper · the iTerm2 profile font has no plant icons (Menlo-Regular), and iTerm2 shows pictures only in Claude Code's fullscreen mode (the session is on the main screen and no environment variable forbids fullscreen)",
      ["The bloom style is drawn as temper: the iTerm2 profile font has no plant icons, and iTerm2 shows pictures only in Claude Code's fullscreen mode.", 'Ask Claude to turn on fullscreen mode.'],
    ],
    [
      bloom,
      facts(ITERM, { itermFont: null }),
      "spinner: bloom → temper · the mod cannot tell whether this terminal draws the plant icons, and iTerm2 shows pictures only in Claude Code's fullscreen mode (the session is on the main screen and no environment variable forbids fullscreen)",
      ["The bloom style is drawn as temper: the mod cannot tell whether this terminal draws the plant icons, and iTerm2 shows pictures only in Claude Code's fullscreen mode.", 'Ask Claude to turn on fullscreen mode.'],
    ],
    [bloom, facts(WEZ), 'spinner: bloom', undefined],
    [
      holo,
      facts(WEZ, NO_MODULE),
      `spinner: holo → temper · WezTerm shows pictures only through the mod's WezTerm module (the module is ${MODULE}; it goes next to wezterm.lua, which calls dofile(wezterm.config_dir .. '/rainbow-spinner.lua').apply(config); panes opened after that draw the picture)`,
      ["The holo style is drawn as temper: WezTerm shows pictures only through the mod's WezTerm module.", "Ask Claude to set up the mod's WezTerm module."],
    ],
    [holo, facts(WEZ, MODULE_RUNS), 'spinner: holo', undefined],
    [holo, facts(KITTY, REFUSED), 'spinner: holo → temper · the terminal did not take the picture', undefined],
    [bloom, facts({ TERM_PROGRAM: 'Apple_Terminal' }), 'spinner: bloom → temper · the mod cannot tell whether this terminal draws the plant icons, and Claude Code draws no pictures in this terminal', undefined],
    [bloom, facts({}, REFUSED), 'spinner: bloom → temper · the mod cannot tell whether this terminal draws the plant icons, and the terminal did not take the picture', undefined],
    [bloom, facts(ITERM, { fullscreen: true, ...PLAIN, ...REFUSED }), 'spinner: bloom → temper · the iTerm2 profile font has no plant icons (Menlo-Regular), and the terminal did not take the picture', undefined],
    [holo, facts(KITTY), 'spinner: holo', undefined],
  ]
  for (const [style, f, rowSays, boxSays] of cases) {
    const v = verdict(style, f)
    expect([row(style.tag, v), box(style.tag, v)]).toEqual([rowSays, boxSays])
  }
  expect(SAY.shown('off')).toBe('spinner: off')
  expect(SAY.current('holo', TAGS)).toBe('spinner: holo; styles: off, temper, holo, bloom')
  expect(SAY.noStyle('x', TAGS)).toBe('spinner: no style "x"; styles: off, temper, holo, bloom')
})

test('each reason is one short phrase, and a reason about pictures says so', () => {
  for (const [key, why] of Object.entries(SAY.why) as [Reason, Why][]) {
    expect([key, why.problem.length <= 70, /^[^.]+$/.test(why.problem)]).toEqual([key, true, true])
    if ('ask' in why) expect([key, why.ask!.length <= 45, /^[^.]+$/.test(why.ask!)]).toEqual([key, true, true])
  }
  const details = [SAY.fullscreenOff, SAY.fullscreenForbidden('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=true')]
  for (const detail of details) expect([detail, detail.length <= 140]).toEqual([detail, true])
  for (const [, f] of TABLE) {
    const { pictures } = classify(f)
    if (typeof pictures !== 'string') expect(pictures.no.problem).toMatch(/\bpictures?\b/)
  }
})

// What is missing is the mod's to say, how to get it Claude's: no row names a
// command, and no box a command or a path; a row may name a file for Claude.
test('no row or box names a command', () => {
  for (const [name, f] of TABLE)
    for (const style of STYLES) {
      const v = verdict(style, f)
      const said = row(style.tag, v)
      expect([name, said, /(^|[\s(])\/[a-z][\w-]*($|[^\w/-])/.test(said)]).toEqual([name, said, false])
      for (const said of box(style.tag, v) ?? []) expect([name, said, said.includes('/')]).toEqual([name, said, false])
    }
})

test('the details in a row are what was measured', () => {
  for (const [style, f, detail] of [
    [bloom, facts(ITERM, { itermFont: 'Menlo-Regular 12' }), '(Menlo-Regular)'],
    [bloom, facts(ITERM, { fullscreen: true, itermFont: 'Monaco 9.5', ...REFUSED }), '(Monaco)'],
    [holo, facts({ ...ITERM, CLAUDE_CODE_NO_FLICKER: ' False ' }), '(CLAUDE_CODE_NO_FLICKER=False forbids it)'],
    [holo, facts({ ...ITERM, CLAUDE_CODE_NO_FLICKER: 'off' }), '(CLAUDE_CODE_NO_FLICKER=off forbids it)'],
    [holo, facts({ ...ITERM, CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: 'YES' }), '(CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=YES forbids it)'],
  ] as const)
    expect(row(style.tag, verdict(style, f))).toContain(detail)
})

for (const [env, expected] of [
  [{ KITTY_WINDOW_ID: '3', TERM_PROGRAM: 'WezTerm' }, 'kitty'],
  [{ KITTY_WINDOW_ID: '3', TERM_PROGRAM: 'iTerm.app' }, 'kitty'],
  [{ TERM: 'xterm-kitty' }, 'kitty'],
  [{ TERM: 'xterm-ghostty' }, 'ghostty'],
  [{ LC_TERMINAL: 'iTerm2' }, 'iterm'],
  [{ LC_TERMINAL: 'iTerm2', TERM_PROGRAM: 'tmux' }, 'iterm'],
  [{ LC_TERMINAL: 'iTerm2', TERM_PROGRAM: 'vscode' }, 'other'],
  [{ WT_SESSION: 'abc', TERM_PROGRAM: 'WezTerm' }, 'wezterm'],
  [{ WT_SESSION: 'abc' }, 'no-images'],
  [{ TERM_PROGRAM: 'tmux', TMUX: '/tmp/tmux' }, 'other'],
  [{}, 'other'],
] as const)
  test(`${JSON.stringify(env)} is ${expected}`, () => {
    expect(terminal(env)).toBe(expected)
  })

test('needs: the ways to draw each style as itself, best first', () => {
  const nerdSprite = { nerdGlyph: true, sprite: bloom.sprite }
  for (const [style, expected] of [
    [temper, [[]]],
    [holo, [['pictures']]],
    [bloom, [['nerdGlyphs'], ['pictures']]],
    [{ ...holo, tag: 'image-nerd-sprite', ...nerdSprite }, [['nerdGlyphs', 'pictures'], ['pictures']]],
    [{ ...temper, tag: 'plain-sprite', sprite: bloom.sprite }, [[]]],
    [{ ...temper, tag: 'nerd-only', nerdGlyph: true }, [['nerdGlyphs']]],
  ] as const)
    expect([style.tag, needs(style)]).toEqual([style.tag, expected])
  expect(STYLES.map(m => m.tag).sort()).toEqual(['bloom', 'holo', 'temper'])
})

const HAS: readonly Has[] = ['yes', 'unknown', ...Object.values(SAY.why).map((no): Missing => ({ no }))]
const ALL_CAPS: readonly Caps[] = HAS.flatMap(pictures => HAS.map(nerdGlyphs => ({ pictures, nerdGlyphs })))

test('the fallback style draws as itself under every caps, and every other style falls back to its plan', () => {
  expect(ALL_CAPS.length).toBe(64)
  for (const caps of ALL_CAPS) {
    const v = check(FALLBACK, caps, FALLBACK)
    expect(v.ok).toBe(true)
    for (const style of STYLES) {
      const w = check(style, caps, FALLBACK)
      if (!w.ok) expect([w.instead, w.plan, w.why.length > 0]).toEqual([FALLBACK.tag, v.plan, true])
    }
  }
})

test('unknown never warns', () => {
  const caps: Caps = { pictures: 'unknown', nerdGlyphs: 'unknown' }
  for (const style of STYLES) expect([style.tag, check(style, caps, FALLBACK).ok]).toEqual([style.tag, true])
})

test('bloom without Nerd glyphs draws its sprite, and names the font before the ask for fullscreen', () => {
  const font: Missing = { no: SAY.why.itermFont, detail: 'Menlo-Regular' }
  const main: Missing = { no: SAY.why.mainScreen, detail: SAY.fullscreenOff }
  expect(check(bloom, { nerdGlyphs: font, pictures: 'yes' }, FALLBACK)).toEqual({ ok: true, plan: { tag: 'bloom', word: 'text', glyph: 'picture' } })
  expect(check(bloom, { nerdGlyphs: font, pictures: main }, FALLBACK)).toEqual({
    ok: false,
    plan: { tag: 'temper', word: 'text', glyph: 'own' },
    instead: 'temper',
    why: [font, main],
    ask: SAY.why.mainScreen.ask,
  })
})

test('a sprite without nerdGlyph draws as itself with no pictures, its glyph as text', () => {
  const caps: Caps = { pictures: { no: SAY.why.mainScreen }, nerdGlyphs: { no: SAY.why.unknownFont } }
  expect(check({ ...temper, tag: 'plain-sprite', sprite: bloom.sprite }, caps, FALLBACK)).toEqual({
    ok: true,
    plan: { tag: 'plain-sprite', word: 'text', glyph: 'own' },
  })
})

test('a way held back by two reasons asks for nothing, and a reason is named once', () => {
  const imageNerd: Style = { ...holo, tag: 'image-nerd-sprite', nerdGlyph: true, sprite: bloom.sprite }
  const font: Missing = { no: SAY.why.itermFont }
  const main: Missing = { no: SAY.why.mainScreen }
  const refused: Missing = { no: SAY.why.refused }
  expect(check(imageNerd, { nerdGlyphs: font, pictures: main }, FALLBACK)).toMatchObject({ why: [font, main], ask: SAY.why.mainScreen.ask })
  const v = check(imageNerd, { nerdGlyphs: font, pictures: refused }, FALLBACK)
  expect(v).toMatchObject({ why: [font, refused] })
  expect(v.ok || v.ask).toBe(undefined)
})

// iTerm2's profiles as plutil prints them; only the keys read.
const PROFILES = [
  { Name: 'Default', Guid: 'g-default', 'Normal Font': 'Monaco 12', 'Non Ascii Font': 'Monaco 12', 'Use Non-ASCII Font': false },
  { Name: 'Meslo', Guid: 'g-meslo', 'Normal Font': 'MesloLGS-NF-Regular 13', 'Non Ascii Font': 'Monaco 12', 'Use Non-ASCII Font': false },
  { Name: 'JetBrains', Guid: 'g-jb', 'Normal Font': 'JetBrainsMonoNerdFontMono-Regular 13', 'Use Non-ASCII Font': 0 },
  { Name: 'Menlo', Guid: 'g-menlo', 'Normal Font': 'Menlo-Regular 20', 'Non Ascii Font': 'Monaco 12', 'Use Non-ASCII Font': false },
  { Name: 'Icons past ASCII', Guid: 'g-icons', 'Normal Font': 'Menlo-Regular 13', 'Non Ascii Font': 'SymbolsNFM 13', 'Use Non-ASCII Font': true },
  { Name: 'Nerd but not past ASCII', Guid: 'g-split', 'Normal Font': 'Hack Nerd Font Mono 13', 'Non Ascii Font': 'Monaco 12', 'Use Non-ASCII Font': 1 },
  { Name: 'No font', Guid: 'g-none' },
]

for (const [which, font, nerd] of [
  [{ name: 'Meslo' }, 'MesloLGS-NF-Regular 13', 'yes'],
  [{ name: 'JetBrains' }, 'JetBrainsMonoNerdFontMono-Regular 13', 'yes'],
  [{ name: 'Icons past ASCII' }, 'SymbolsNFM 13', 'yes'],
  [{ name: 'Menlo' }, 'Menlo-Regular 20', { no: SAY.why.itermFont, detail: 'Menlo-Regular' }],
  [{ name: 'Nerd but not past ASCII' }, 'Monaco 12', { no: SAY.why.itermFont, detail: 'Monaco' }],
  [{ guid: 'g-default\n' }, 'Monaco 12', { no: SAY.why.itermFont, detail: 'Monaco' }],
  [{ name: 'a profile iTerm2 does not list' }, null, { no: SAY.why.unknownFont }],
  [{ name: 'No font' }, null, { no: SAY.why.unknownFont }],
] as const)
  test(`iTerm2 profile ${JSON.stringify(which)}: font ${font}`, () => {
    const got = itermFont(PROFILES, which)
    expect([got, classify(facts(ITERM, { itermFont: got })).nerdGlyphs]).toEqual([font, nerd])
  })

test('profiles that are not a list give no font', () => {
  expect([itermFont(undefined, { name: 'Menlo' }), itermFont({}, { guid: 'g-menlo' })]).toEqual([null, null])
})
