import type { CoreEngineInterface } from 'claude-code'
import { cellH, cellW } from './core/atlas'
import { changed, slotFor, stateText } from './core/wezterm'

// The mod's side of the holo word in WezTerm: it writes the word's frames as
// one PNG sheet and a state file it renews while the line is drawn, and the
// WezTerm module (wezterm/rainbow-spinner.lua) places the frame over the line's
// marker cells. Why and how to set it up: wezterm/README.md.
//
// The two sides compare no clocks (a WSL clock drifts from Windows'): each
// shows it works by changing a file the other watches: the module `alive` and
// `<key>.ack`, the mod the state's beat.
type Host = Pick<CoreEngineInterface, 'env' | 'fs' | 'process' | 'clock' | 'ui'>

// Where the two sides meet: the folder the module's apply() puts in the
// environment of what WezTerm starts, this session's pane, and its name there.
export type Side = { readonly dir: string; readonly pane: string; readonly key: string }

const ALIVE_MS = 1200 // the module writes `alive` at least every half second
const LOOK_MS = 20 // the module's tick while a line is drawn
const BEAT_MS = 300 // the module takes a state unchanged for 1.5 s for a line that ended
const DRAWN_MS = 1500 // a word the module has not drawn for this long is refused
const AWAY_MS = 1000 // a line gone for this long comes back to a module that ticks slowly

// The module's apply() puts the folder in the environment, and WezTerm the
// pane: without both there is no module to draw the word, and the mod reads
// and writes nothing. Read once.
let side: Promise<Side | undefined> | undefined
export function sideOf($: Pick<Host, 'env'>): Promise<Side | undefined> {
  side ??= (async () => {
    const dir = await $.env.get('RAINBOW_SPINNER_WEZTERM_DIR')
    const pane = await $.env.get('WEZTERM_PANE')
    if (dir === undefined || dir === '' || pane === undefined || pane === '') return undefined
    return { dir, pane, key: `pane-${pane}` }
  })()
  return side
}

async function read($: Host, path: string): Promise<string | undefined> {
  return $.fs.read(path).then(
    s => s.trim(),
    () => undefined,
  )
}

// Whether the module runs: it changes `alive` while it does. The answer is
// measured from the last read, so a read at session start spares the wait.
type Reading = { readonly text: string | undefined; readonly at: number }
let last: Reading | undefined
let asked: Promise<boolean> | undefined
let runs: boolean | undefined

async function reading($: Host, side: Side): Promise<Reading> {
  const text = await read($, `${side.dir}/alive`)
  // The module writes only into a folder that is there: the first session makes it.
  if (text === undefined) await writeState($, side)
  return { text, at: await $.clock.now() }
}

export async function look($: Host, side: Side) {
  last ??= await reading($, side).catch(() => undefined)
}

export function moduleRuns($: Host, side: Side): Promise<boolean> {
  asked ??= (async () => {
    const before = last ?? (await reading($, side))
    const left = ALIVE_MS - ((await $.clock.now()) - before.at)
    if (left > 0) await $.clock.sleep(left)
    last = await reading($, side)
    return (runs = changed(before.text, last.text))
  })().catch(() => (runs = false))
  return asked
}

// For a drawing, which does not wait: undefined while the answer needs a
// wait, after which the line is drawn again.
export async function moduleRunsNow($: Host, side: Side): Promise<boolean | undefined> {
  if (runs !== undefined) return runs
  if (asked === undefined && last !== undefined && (await $.clock.now()) - last.at >= ALIVE_MS) return moduleRuns($, side)
  void moduleRuns($, side).then(() => $.ui.invalidate('ui.render'))
  return undefined
}

// At each /spinner the module is asked again.
export function forget() {
  asked = undefined
  runs = undefined
}

// The word's frames, stacked top to bottom in one PNG.
export type Sheet = { readonly png: string; readonly count: number }

// The word the line shows, by the line's requestId: its sheet's slot once
// it is written and named in the state, the last ack the mod saw, and whether
// drawn() last judged that the module drew none of its frames.
type Word = { readonly line: string; readonly text: string; slot?: number; ack?: string; ackAt?: number; undrawn?: boolean; dropped?: boolean }
let word: Word | undefined
const slots: ({ text: string; count: number; frameMs: number; made: number } | undefined)[] = []
let made = 0
let named: number | undefined
let beat = 0
let beatAt = 0
let jobs: Promise<void> = Promise.resolve()
let writes: Promise<void> = Promise.resolve()

// The line puts out its marker cells only once the word's sheet and state
// are in place and the module has looked at them; until then it is text.
export function ready(line: string, text: string): boolean {
  return word?.line === line && word.text === text && word.ackAt !== undefined && word.dropped !== true
}

// Whether a word's line has been away: neither renewed nor seen drawn, as
// while Claude Code asks the user something.
async function away($: Host, w: Word): Promise<boolean> {
  return ready(w.line, w.text) && (await $.clock.now()) - Math.max(beatAt, w.ackAt!) >= AWAY_MS
}

// At a render: a new word, or one whose line has been away, has the state
// name no sheet at once, so the module takes the previous picture away; then
// its sheet is written, named, and the line drawn again.
export async function show($: Host, side: Side, line: string, text: string, frameMs: number, sheet: () => Sheet) {
  if (word?.line === line && word.text === text && !(await away($, word))) return
  const mine: Word = { line, text }
  word = mine
  jobs = jobs
    .then(() => (word === mine ? name($, side, mine, frameMs, sheet) : undefined))
    .catch((err: unknown) => $.ui.log(`rainbow-spinner: ${String(err)}`, { to: 'debug' }))
}

async function name($: Host, side: Side, mine: Word, frameMs: number, sheet: () => Sheet) {
  await writeState($, side)
  const slot = slotFor(slots.map(s => s?.text), named, mine.text)
  if (slots[slot]?.text !== mine.text) {
    slots[slot] = undefined
    const film = sheet()
    const wrote = await $.process.run(['sh', '-c', 'base64 -d > "$1"', 'sh', `${side.dir}/${side.key}-${slot}.png`], { stdin: film.png })
    if (wrote.exitCode !== 0) throw new Error(`writing the sheet: ${wrote.stderr.trim()}`)
    slots[slot] = { text: mine.text, count: film.count, frameMs, made: ++made }
  }
  if (word !== mine) return
  const ack = await read($, `${side.dir}/${side.key}.ack`)
  mine.slot = named = slot
  await writeState($, side)
  // The module ticks every half second while it draws nothing: at its second
  // tick from here it has read the state, and from then ticks fast.
  let seen = await read($, `${side.dir}/alive`)
  let ticks = 0
  for (let waited = 0; ticks < 2 && waited < ALIVE_MS; waited += LOOK_MS) {
    await $.clock.sleep(LOOK_MS)
    const now = await read($, `${side.dir}/alive`)
    if (changed(seen, now)) (seen = now), ticks++
  }
  if (word !== mine) return
  if (ticks < 2) return dropWord($, side, mine)
  mine.ack = ack
  mine.ackAt = await $.clock.now()
  $.ui.invalidate('ui.render')
}

// At each post of a drawn line's clock, once every BEAT_MS: the state
// renewed, and whether the module has drawn the word since the last renewal.
// A line back from away is not judged: its next render names the word again.
export async function drawn($: Host, side: Side, line: string, text: string): Promise<'drawn' | 'pending' | { readonly fail: string }> {
  const mine = word
  if (mine === undefined || !ready(line, text)) return 'pending'
  if (await away($, mine)) {
    $.ui.invalidate('ui.render')
    return 'pending'
  }
  const now = await $.clock.now()
  if (now - beatAt >= BEAT_MS) {
    await writeState($, side)
    const ack = await read($, `${side.dir}/${side.key}.ack`)
    if (changed(mine.ack, ack)) {
      mine.ack = ack
      mine.ackAt = now
      mine.undrawn = false
      return 'drawn'
    }
  }
  if (now - mine.ackAt! <= DRAWN_MS) return 'pending'
  mine.undrawn = true
  return { fail: 'the WezTerm module drew no frame of this word' }
}

// A word the module does not draw stays text: the line's word, when drawn()
// judged that very word undrawn.
export async function drop($: Host, side: Side, line: string, text: string) {
  if (word?.line === line && word.text === text && word.undrawn === true) await dropWord($, side, word)
}

async function dropWord($: Host, side: Side, w: Word) {
  if (w !== word || w.dropped === true) return
  w.dropped = true
  await writeState($, side)
  $.ui.invalidate('ui.render')
}

// One write at a time, each of the state as it is when the write starts.
function writeState($: Host, side: Side): Promise<void> {
  writes = writes
    .catch(() => {})
    .then(async () => {
      const w = word
      const s = w?.slot !== undefined && w.dropped !== true ? slots[w.slot] : undefined
      beat++
      const text = stateText({
        pane: side.pane,
        cells: w === undefined ? 0 : Array.from(w.text).length,
        frameMs: s?.frameMs ?? 0,
        count: s?.count ?? 0,
        width: w === undefined ? 0 : Array.from(w.text).length * cellW,
        height: cellH,
        sheet: s === undefined ? undefined : `${side.key}-${w!.slot}.png`,
        made: s?.made ?? 0,
        beat,
      })
      await $.fs.write(`${side.dir}/${side.key}.state`, text)
      beatAt = await $.clock.now()
    })
  return writes
}
