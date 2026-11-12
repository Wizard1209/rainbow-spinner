import { FILM_BAND } from './film-band'
import type { Style } from '../core/style'
import { rims } from '../core/rims'

const PERIOD_MS = 1700
const WINDOW = 16 // rims in flight: at 3 letters apart they reach some 49 letters out

// temper's rims, ten times slower and ten times narrower: a band is about
// two letters wide, so the film's colours run on inside each letter, which
// only a picture of the word can show. The rims start already spread over
// the whole line instead of leaving the middle from black.
export const holo: Style = {
  tag: 'holo',
  output: 'image',
  // A frame every 40 ms: the band moves a twenty-fourth of a letter per
  // frame. With one loop's pictures kept, the line costs the Claude Code
  // process in kitty about a fifth of a core (bench/).
  frameMs: 40,
  // A rim leaves every PERIOD_MS, and the pre-roll keeps the window full.
  loopMs: PERIOD_MS,
  field: rims({ periodMs: PERIOD_MS, speed: 0.0018, width: 2.2, window: WINDOW, lut: FILM_BAND, preRollMs: WINDOW * PERIOD_MS }),
}
