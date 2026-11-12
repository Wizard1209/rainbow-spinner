import { luma, type Rgb, srgb, tint, toRgb } from './colour'

// The interference colours of a thin film growing on metal, as steel shows
// them when tempered: bronze, purple, deep blue, teal, green, ...
const BRIGHTNESS = 0.8
const SATURATION = 1.5 // the film's own colours, deepened

// A film of optical path difference pathNm: I(λ) = sin²(πΔ/λ) under D65,
// integrated against the CIE 1931 observer (Wyman–Sloan–Shirley fit), scaled
// to BRIGHTNESS, deepened, and dimmed by fade toward black.
export function film(pathNm: number, fade = 1): Rgb {
  let X = 0
  let Y = 0
  let Z = 0
  for (const { lambda, light, xyz } of SPECTRUM) {
    const s = Math.sin((Math.PI * pathNm) / lambda)
    const power = light * s * s
    X += power * xyz[0]
    Y += power * xyz[1]
    Z += power * xyz[2]
  }
  const scale = BRIGHTNESS / WHITE_Y
  const linear = xyzToLinearSrgb(X * scale, Y * scale, Z * scale)
  return toRgb(tint(luma(linear), linear, SATURATION).map(v => srgb(Math.min(1, Math.max(0, v))) * fade * 255))
}

function cie(l: number): [number, number, number] {
  const g = (x: number, mu: number, s1: number, s2: number) => {
    const t = (x - mu) / (x < mu ? s1 : s2)
    return Math.exp(-0.5 * t * t)
  }
  return [
    1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2),
    0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1),
    1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8),
  ]
}

// D65 relative spectral power, a smooth fit good to a few percent over 380-730 nm.
function d65(l: number): number {
  return 100 + 18 * Math.sin((l - 380) / 70) - 0.0006 * (l - 460) ** 2 + 22 * Math.exp(-(((l - 460) / 40) ** 2))
}

function xyzToLinearSrgb(X: number, Y: number, Z: number): [number, number, number] {
  return [
    3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
    0.0557 * X - 0.204 * Y + 1.057 * Z,
  ]
}

// The light and the observer at every 5 nm, the same for every film: a band
// of films costs a sine per wavelength each.
const SPECTRUM = Array.from({ length: 71 }, (_, i) => {
  const lambda = 380 + 5 * i
  return { lambda, light: d65(lambda), xyz: cie(lambda) }
})
const WHITE_Y = SPECTRUM.reduce((sum, { light, xyz }) => sum + light * xyz[1], 0)
