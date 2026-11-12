import { evenLut, type Rgb } from '../core/colour'
import { film } from '../core/film'

// The band a rim carries, front to back: path difference FIRST_PATH_NM to
// LAST_PATH_NM, risen out of black and sunk back over EMERGE, in 256 steps an
// equal distance apart to the eye.
const FIRST_PATH_NM = 380 // first bronze, past the white of thinner films
const LAST_PATH_NM = 1300 // the second order's violet, blue and green
const EMERGE = 0.12 // share of the band at each end over which the colour rises out of black and sinks back

const ease = (v: number) => {
  const c = Math.min(1, Math.max(0, v))
  return c * c * (3 - 2 * c)
}

export const FILM_BAND: readonly Rgb[] = evenLut(
  u => film(FIRST_PATH_NM + (LAST_PATH_NM - FIRST_PATH_NM) * u, ease(u / EMERGE) * ease((1 - u) / EMERGE)),
  256,
)
