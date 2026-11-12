import type { Style } from './style'

// What the terminal can show, from facts the engine gathers, and what a style
// then draws: itself, or the fallback style, with the reasons it cannot and
// what to ask Claude for so that it can.

// Why a capability is missing: problem, a phrase for the user that names no
// version; ask, what to ask Claude for, never how to do it.
export type Why = { readonly problem: string; readonly ask?: string }

// Every word the mod says about a style: the reasons, the measured details
// (for Claude, in the row's brackets), the reply rows and the box.
export const SAY = {
  why: {
    mainScreen: { problem: "iTerm2 shows pictures only in Claude Code's fullscreen mode", ask: 'to turn on fullscreen mode' },
    unsupported: { problem: 'Claude Code draws no pictures in this terminal' },
    weztermModule: { problem: "WezTerm shows pictures only through the mod's WezTerm module", ask: "to set up the mod's WezTerm module" },
    refused: { problem: 'the terminal did not take the picture' },
    itermFont: { problem: 'the iTerm2 profile font has no plant icons' },
    unknownFont: { problem: 'the mod cannot tell whether this terminal draws the plant icons' },
  } satisfies Record<string, Why>,
  fullscreenOff: 'the session is on the main screen and no environment variable forbids fullscreen',
  fullscreenForbidden: (setting: string) => `${setting} forbids it`,
  weztermSetup: (file: string) => `the module is ${file}; it goes next to wezterm.lua, which calls dofile(wezterm.config_dir .. '/rainbow-spinner.lua').apply(config); panes opened after that draw the picture`,
  shown: (tag: string) => `spinner: ${tag}`,
  instead: (tag: string, instead: string, why: string) => `spinner: ${tag} → ${instead} · ${why}`,
  and: ', and ',
  box: (tag: string, instead: string, why: string) => `The ${tag} style is drawn as ${instead}: ${why}.`,
  ask: (ask: string) => `Ask Claude ${ask}.`,
  current: (tag: string, tags: readonly string[]) => `spinner: ${tag}; styles: ${tags.join(', ')}`,
  noStyle: (arg: string, tags: readonly string[]) => `spinner: no style "${arg}"; styles: ${tags.join(', ')}`,
} as const

// A capability is usable unless it is Missing; detail is what the mod measured.
export type Missing = { readonly no: Why; readonly detail?: string }
export type Has = 'yes' | 'unknown' | Missing
export type Caps = {
  readonly pictures: Has // a picture shows, still or swapped every frame: no terminal tells the two apart
  readonly nerdGlyphs: Has
}
type Cap = keyof Caps

export type Env = {
  readonly KITTY_WINDOW_ID?: string
  readonly TERM?: string
  readonly TERM_PROGRAM?: string
  readonly LC_TERMINAL?: string
  readonly WT_SESSION?: string
  readonly TMUX?: string
  readonly CLAUDE_CODE_NO_FLICKER?: string
  readonly CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN?: string
}
export type Facts = {
  readonly env: Env
  readonly fullscreen: boolean
  // The font iTerm2 draws past ASCII in; null: could not read; undefined: not iTerm2.
  readonly itermFont: string | null | undefined
  readonly imagesRefused: boolean
  // In WezTerm: whether it runs the mod's module, and the module's file; undefined: not WezTerm.
  readonly weztermModule?: { readonly runs: boolean; readonly file: string }
}

type Terminal = 'kitty' | 'ghostty' | 'wezterm' | 'iterm' | 'no-images' | 'other'

// First match wins: kitty keeps an inherited TERM_PROGRAM, and WT_SESSION is inherited too.
export function terminal(env: Env): Terminal {
  if (env.KITTY_WINDOW_ID !== undefined || env.TERM === 'xterm-kitty') return 'kitty'
  if (env.TERM_PROGRAM === 'ghostty' || env.TERM === 'xterm-ghostty') return 'ghostty'
  if (env.TERM_PROGRAM === 'WezTerm') return 'wezterm'
  // LC_TERMINAL is inherited by terminals started from an iTerm2 shell; it says iTerm2 only past ssh or tmux.
  if (env.TERM_PROGRAM === 'iTerm.app' || (env.LC_TERMINAL === 'iTerm2' && [undefined, 'tmux'].includes(env.TERM_PROGRAM))) return 'iterm'
  if (env.TERM_PROGRAM === 'Apple_Terminal' || env.WT_SESSION !== undefined) return 'no-images'
  return 'other'
}

// The engine's own reading of a flag variable.
const flag = (v: string | undefined) => v?.toLowerCase().trim()
const truthy = (v: string | undefined) => ['1', 'true', 'yes', 'on'].includes(flag(v) ?? '')
const falsy = (v: string | undefined) => ['0', 'false', 'no', 'off'].includes(flag(v) ?? '')

// The env setting that keeps Claude Code off the alternate screen, as NAME=value; /tui cannot override it.
function mainScreenForced(env: Env): string | undefined {
  if (falsy(env.CLAUDE_CODE_NO_FLICKER)) return `CLAUDE_CODE_NO_FLICKER=${env.CLAUDE_CODE_NO_FLICKER?.trim()}`
  if (truthy(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN)) return `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=${env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN?.trim()}`
  return undefined
}

const NERD = /Nerd|NF[MP]?\b/

const no = (why: Why, detail?: string): Missing => (detail === undefined ? { no: why } : { no: why, detail })
const missing = (h: Has): h is Missing => typeof h !== 'string'
const usable = (h: Has): boolean => !missing(h)

export function classify(f: Facts): Caps {
  const term = terminal(f.env)
  return { pictures: picturesOf(f, term), nerdGlyphs: nerdGlyphsOf(f, term) }
}

function picturesOf(f: Facts, term: Terminal): Has {
  if (f.imagesRefused) return no(SAY.why.refused)
  if (f.env.TMUX !== undefined) return 'unknown'
  switch (term) {
    case 'kitty':
    case 'ghostty':
      return 'yes'
    case 'iterm': {
      if (f.fullscreen) return 'yes'
      const forced = mainScreenForced(f.env)
      return no(SAY.why.mainScreen, forced === undefined ? SAY.fullscreenOff : SAY.fullscreenForbidden(forced))
    }
    case 'wezterm':
      if (f.weztermModule?.runs === true) return 'yes'
      return no(SAY.why.weztermModule, f.weztermModule && SAY.weztermSetup(f.weztermModule.file))
    case 'no-images':
      return no(SAY.why.unsupported)
    case 'other':
      return 'unknown'
  }
}

// Never unknown: a guessed Nerd glyph risks a missing-glyph box. kitty,
// Ghostty and WezTerm carry the plant's glyphs in their own fonts.
function nerdGlyphsOf(f: Facts, term: Terminal): Has {
  switch (term) {
    case 'kitty':
    case 'ghostty':
    case 'wezterm':
      return 'yes'
    case 'iterm':
      if (typeof f.itermFont !== 'string') return no(SAY.why.unknownFont)
      // The font as iTerm2 keeps it, "Name Size"; the detail names the font.
      return NERD.test(f.itermFont) ? 'yes' : no(SAY.why.itermFont, f.itermFont.replace(/ [\d.]+$/, ''))
    default:
      return no(SAY.why.unknownFont)
  }
}

// The ways to draw a style as itself, best first, each the caps it takes.
export function needs(style: Style): readonly (readonly Cap[])[] {
  const glyph: Cap[][] = style.nerdGlyph ? [['nerdGlyphs'], ...(style.sprite ? [['pictures' as const]] : [])] : [[]]
  return style.output === 'image' ? glyph.map(alt => (alt.includes('pictures') ? alt : [...alt, 'pictures'])) : glyph
}

export type Plan = { readonly tag: string; readonly word: 'picture' | 'text'; readonly glyph: 'nerd' | 'picture' | 'own' }
export type Verdict =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly plan: Plan; readonly instead: string; readonly why: readonly Missing[]; readonly ask?: string }

function planOf(style: Style, caps: Caps): Plan {
  const glyph = style.nerdGlyph && caps.nerdGlyphs === 'yes' ? 'nerd' : style.sprite && usable(caps.pictures) ? 'picture' : 'own'
  return { tag: style.tag, word: style.output === 'image' ? 'picture' : 'text', glyph }
}

export function check(style: Style, caps: Caps, fallback: Style): Verdict {
  const alts = needs(style)
  if (alts.some(alt => alt.every(c => usable(caps[c])))) return { ok: true, plan: planOf(style, caps) }
  return { ok: false, plan: planOf(fallback, caps), instead: fallback.tag, ...named(alts, caps) }
}

// The reasons to name and what to ask for. The ways are walked in order, each
// naming the reasons its caps are missing; a way held back by one reason with
// an ask stops the walk, and that ask is the ask: done, it opens the way.
function named(alts: readonly (readonly Cap[])[], caps: Caps): { why: readonly Missing[]; ask?: string } {
  const why: Missing[] = []
  for (const alt of alts) {
    const held = [...new Set(alt.map(c => caps[c]).filter(missing))]
    for (const m of held) if (!why.includes(m)) why.push(m)
    const ask = held.length === 1 ? held[0]?.no.ask : undefined
    if (ask !== undefined) return { why, ask }
  }
  return { why }
}

const said = (m: Missing, detail: boolean) => m.no.problem + (detail && m.detail !== undefined ? ` (${m.detail})` : '')

// The /spinner reply row, which Claude reads: the reasons with what was measured.
export function row(tag: string, v: Verdict): string {
  return v.ok ? SAY.shown(tag) : SAY.instead(tag, v.instead, v.why.map(m => said(m, true)).join(SAY.and))
}

// The box drawn in place of the row while there is something to ask for: the reasons, then the ask.
export function box(tag: string, v: Verdict): readonly [string, string] | undefined {
  if (v.ok || v.ask === undefined) return undefined
  return [SAY.box(tag, v.instead, v.why.map(m => said(m, false)).join(SAY.and)), SAY.ask(v.ask)]
}

// iTerm2's profiles as `plutil -extract 'New Bookmarks' json` gives them: the
// font the chosen profile draws past ASCII in, or null when it cannot be told.
export function itermFont(profiles: unknown, which: { readonly name: string } | { readonly guid: string }): string | null {
  if (!Array.isArray(profiles)) return null
  const p: Record<string, unknown> | undefined = profiles.find(p =>
    'name' in which ? p?.Name === which.name : p?.Guid === which.guid.trim(),
  )
  if (p === undefined) return null
  const nonAscii = p['Use Non-ASCII Font'] === true || p['Use Non-ASCII Font'] === 1
  const font = nonAscii ? p['Non Ascii Font'] : p['Normal Font']
  return typeof font === 'string' ? font : null
}
