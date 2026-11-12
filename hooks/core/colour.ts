export type Rgb = readonly [number, number, number] // 0..255 integers

export const BLACK: Rgb = [0, 0, 0]

export function hex(c: Rgb): string {
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('')
}

// Channels rounded and held to 0..255.
export function toRgb(v: readonly number[]): Rgb {
  return v.map(c => Math.round(Math.min(255, Math.max(0, c)))) as unknown as Rgb
}

// Grey with k of the colour c's departure from it.
export function tint(grey: number, c: readonly number[], k: number): number[] {
  return c.map(v => grey + (v - grey) * k)
}

export function luma(c: readonly number[]): number {
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0)
}

const linear = (v: number) => {
  const s = v / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
// A linear-light channel 0..1 as sRGB's encoded 0..1.
export function srgb(v: number): number {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
}

export function oklab(c: Rgb): [number, number, number] {
  const [r, g, b] = c.map(linear) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

// How far apart two colours look: the OKLab distance.
export function distance(a: Rgb, b: Rgb): number {
  const [l1, a1, b1] = oklab(a)
  const [l2, a2, b2] = oklab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

function oklchLinear(l: number, c: number, h: number): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ]
}

// OKLCh lightness, chroma and hue (degrees) as sRGB. Where sRGB cannot hold
// that chroma at that hue, the chroma gives way: clipping a channel instead
// would shift the hue and the lightness.
export function fromOklch(l: number, c: number, h: number): Rgb {
  const fits = (chroma: number) => oklchLinear(l, chroma, h).every(v => v >= -1e-6 && v <= 1 + 1e-6)
  let held = c
  if (!fits(c)) {
    let [lo, hi] = [0, c]
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2
      if (fits(mid)) lo = mid
      else hi = mid
    }
    held = lo
  }
  return toRgb(oklchLinear(l, held, h).map(v => 255 * srgb(Math.min(1, Math.max(0, v)))))
}

// A table of `size` colours along sample(0..1), re-spaced so that every step
// is an equal distance in OKLab: where the colour turns fast, the table slows.
export function evenLut(sample: (u: number) => Rgb, size: number): Rgb[] {
  const SAMPLES = 2048
  const colours = Array.from({ length: SAMPLES }, (_, k) => sample(k / (SAMPLES - 1)))
  const labs = colours.map(oklab)
  const along = [0]
  for (let k = 1; k < SAMPLES; k++) {
    const [a, b] = [labs[k - 1]!, labs[k]!]
    along.push(along[k - 1]! + Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]))
  }
  const total = along[SAMPLES - 1] ?? 1
  const lut: Rgb[] = []
  let k = 0
  for (let i = 0; i < size; i++) {
    const target = (i / (size - 1)) * total
    while (k < SAMPLES - 1 && (along[k + 1] ?? total) < target) k++
    lut.push(colours[k] ?? BLACK)
  }
  return lut
}
