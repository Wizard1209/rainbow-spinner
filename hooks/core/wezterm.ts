// What the mod and its WezTerm module (wezterm/rainbow-spinner.lua) say to
// each other through their folder: the cells the word's picture covers, and
// the state file the module draws by.

// Blank braille: it draws empty, and nothing else on the line uses it, so the
// module can find the word's cells on the screen.
const MARK = '⠀'

export function marker(cells: number): string {
  return MARK.repeat(cells)
}

type State = {
  readonly pane: string // WezTerm's id of the pane the line is in
  readonly cells: number
  readonly frameMs: number
  readonly count: number
  readonly width: number // a frame's size in pixels; frame k is the sheet's band from y = k × height
  readonly height: number
  readonly sheet: string | undefined // the file in the folder that holds the frames; undefined: no picture
  readonly made: number // how many sheets the mod had written when it wrote this one
  readonly beat: number
}

// One `key=value` a line, `beat` last: the module takes a read that does not
// end in it for one caught halfway through a write.
export function stateText(s: State): string {
  return `pane=${s.pane}\ncells=${s.cells}\nframeMs=${s.frameMs}\ncount=${s.count}\nwidth=${s.width}\nheight=${s.height}\nsheet=${s.sheet ?? ''}\nmade=${s.made}\nbeat=${s.beat}\n`
}

// Which of the two slots a word's sheet goes in: the one that holds it
// already, else the one the state did not name last, which the module may
// still be reading.
export function slotFor(slots: readonly (string | undefined)[], named: number | undefined, text: string): number {
  const kept = slots.indexOf(text)
  return kept >= 0 ? kept : named === 0 ? 1 : 0
}

// Whether the module wrote a file between two reads of it: it writes a new
// value every time, and an empty read is one caught halfway through a write.
export function changed(before: string | undefined, after: string | undefined): boolean {
  return after !== undefined && after !== '' && after !== before
}
