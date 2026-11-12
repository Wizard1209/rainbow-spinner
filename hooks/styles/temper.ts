import { FILM_BAND } from './film-band'
import type { Style } from '../core/style'
import { rims } from '../core/rims'

// The line rests in deep black. Rims spread out from the middle of the word
// one after another; as a rim passes a letter, the letter runs once through
// the film's colours and sinks back into black. Each letter is one colour.
export const temper: Style = {
  tag: 'temper',
  output: 'text',
  frameMs: 40,
  field: rims({ periodMs: 1700, speed: 0.018, width: 22, window: 6, lut: FILM_BAND }),
}
