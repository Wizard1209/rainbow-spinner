import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, StateDollar } from 'claude-code'
import { type Caps, classify, type Facts, itermFont, terminal } from './core/caps'
import { forget, look, moduleRuns, moduleRunsNow, type Side, sideOf } from './wezterm'

// What the terminal is, gathered once a session and again at each /spinner,
// so a font the user has just changed is seen. Kept in the module, which
// lives as long as the session: a drawing may not write state.
type Host = Pick<CoreEngineInterface, 'env' | 'process' | 'fs' | 'clock' | 'ui' | 'plugin'> & StateDollar
// side: in WezTerm, where the mod meets its WezTerm module, when that is set up.
type Gathered = Pick<Facts, 'env' | 'itermFont'> & { readonly side?: Side }
let gathered: Promise<Gathered> | undefined

// One picture taken proves the terminal shows them; a session that has had
// none taken and then sees a line's pictures refused draws without them.
const imagesRefused = atom({ plugin: 'rainbow-spinner', key: 'imagesRefused' } as const, false)
const imagesShown = atom({ plugin: 'rainbow-spinner', key: 'imagesShown' } as const, false)

export async function pictureTaken($: StateDollar) {
  if (!(await read($, imagesShown))) await update($, imagesShown, () => true)
}

export async function picturesRefused($: StateDollar) {
  if (!(await read($, imagesShown))) await update($, imagesRefused, () => true)
}

export function refresh() {
  gathered = undefined
  forget()
}

// At session start: the module's first sign of life is read, so that the
// answer needs no wait when the line is first drawn.
export async function start($: Host) {
  const { side } = await (gathered ??= gather($))
  if (side !== undefined) await look($, side)
}

// A drawing does not wait for the module's answer (wait: false): until it
// comes the line is drawn without the module, and then drawn again.
export async function capsOf($: Host, fullscreen: boolean, wait = false): Promise<Caps> {
  const { side, ...facts } = await (gathered ??= gather($))
  const runs = side === undefined ? false : wait ? await moduleRuns($, side) : await moduleRunsNow($, side)
  const weztermModule = terminal(facts.env) === 'wezterm' ? { runs: runs === true, file: `${$.plugin.root}/wezterm/rainbow-spinner.lua` } : undefined
  return classify({ ...facts, weztermModule, fullscreen, imagesRefused: await read($, imagesRefused) })
}

// Where the WezTerm module draws the word, when it runs.
export async function moduleSide($: Host): Promise<Side | undefined> {
  const { side } = await (gathered ??= gather($))
  return side !== undefined && (await moduleRunsNow($, side)) === true ? side : undefined
}

async function gather($: Host): Promise<Gathered> {
  const env = {
    KITTY_WINDOW_ID: await $.env.get('KITTY_WINDOW_ID'),
    TERM: await $.env.get('TERM'),
    TERM_PROGRAM: await $.env.get('TERM_PROGRAM'),
    LC_TERMINAL: await $.env.get('LC_TERMINAL'),
    WT_SESSION: await $.env.get('WT_SESSION'),
    TMUX: await $.env.get('TMUX'),
    CLAUDE_CODE_NO_FLICKER: await $.env.get('CLAUDE_CODE_NO_FLICKER'),
    CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: await $.env.get('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN'),
  }
  const term = terminal(env)
  return {
    env,
    itermFont: term === 'iterm' ? await itermProfileFont($).catch(() => null) : undefined,
    side: term === 'wezterm' && env.TMUX === undefined ? await sideOf($) : undefined,
  }
}

async function itermProfileFont($: Host): Promise<string | null> {
  const prefs = `${await $.env.get('HOME')}/Library/Preferences/com.googlecode.iterm2.plist`
  const extract = async (key: string, format: 'json' | 'raw') => {
    const { exitCode, stdout } = await $.process.run(['plutil', '-extract', key, format, '-o', '-', prefs])
    if (exitCode !== 0) throw new Error(`plutil: ${exitCode}`)
    return stdout
  }
  const profiles: unknown = JSON.parse(await extract('New Bookmarks', 'json'))
  const name = await $.env.get('ITERM_PROFILE')
  return itermFont(profiles, name !== undefined ? { name } : { guid: await extract('Default Bookmark Guid', 'raw') })
}
