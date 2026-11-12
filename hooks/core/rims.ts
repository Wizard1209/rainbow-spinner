import { BLACK, type Rgb } from './colour'
import type { Field } from './style'

type Rims = {
  readonly periodMs: number // a new rim leaves the centre this often
  readonly speed: number // letters per millisecond
  readonly width: number // letters a rim's colour band spans, from black to black
  readonly window: number // rims looked back over, in periods: enough for the oldest to clear the line
  readonly lut: readonly Rgb[] // the band, front to back
  readonly preRollMs?: number // how long the rims ran before the line appeared
}

// Rims spreading out from the line's centre one after another over black; as
// a rim passes a place, the place runs once through the band and goes back to
// black.
export function rims({ periodMs, speed, width, window, lut, preRollMs = 0 }: Rims): Field {
  return (x, t, line) => {
    const now = t + preRollMs
    const distance = Math.abs(x - line.centre)
    for (let born = now - (now % periodMs); born > now - window * periodMs && born >= 0; born -= periodMs) {
      const behind = (now - born) * speed - distance // letters behind the rim's front
      if (behind > 0 && behind < width) return lut[Math.round((behind / width) * (lut.length - 1))] ?? BLACK
    }
    return BLACK
  }
}
