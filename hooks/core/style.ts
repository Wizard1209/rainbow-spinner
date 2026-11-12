import type { Rgb } from './colour'
import type { Rgba } from './rgba'

// What a spinner style is. A style draws nothing itself: it is a colour field
// over the spinner line, and the core samples it at each letter (text output)
// or at each pixel column of the word (image output).

// Places on the line, in letters: the glyph at x = 0, a space at 1, the word's
// letter k at letterAt(k), then the tail (time and state). x may be fractional.
export type Line = { readonly centre: number } // the middle of glyph, space and word: (letters + 1) / 2

export function letterAt(k: number): number {
  return k + 2
}

export function lineOf(text: string): Line {
  return { centre: letterAt(Array.from(text).length - 1) / 2 }
}

// The colour at place x, t wall milliseconds after the line appeared.
export type Field = (x: number, t: number, line: Line) => Rgb

export type Glyph = { readonly ch: string; readonly rgb: Rgb }

export type Style = {
  readonly tag: string // what /spinner takes: lowercase letters and hyphens
  readonly output: 'text' | 'image' // image: the word drawn as a picture, where the terminal can
  readonly frameMs: number // each frame costs the engine a redraw of the line, about 2.3 ms of CPU
  // The field repeats every loopMs: an image style's word pictures are made
  // for one loop and kept, instead of anew each frame.
  readonly loopMs?: number
  readonly field: Field
  readonly glyph?: (t: number) => Glyph // absent: the core's star, in the field's colour at x = 0
  // glyph() spells Nerd Font codepoints: drawn as text only where the
  // terminal draws those, elsewhere as its sprite, or the fallback style.
  readonly nerdGlyph?: boolean
  // The glyph as a picture over its cell and the space after it, where the
  // terminal can; glyph() stays its text. A new picture is sent only when the
  // object returned changes, so a style returns the same one while it holds.
  // A still picture, changing no faster than about every 0.5 s: only an image word is a stream.
  readonly sprite?: (t: number) => Rgba
}
