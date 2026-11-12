import type { Rgb } from './colour'

// A picture as ImageSource's bytes form: width*height RGBA pixels, base64.
export type Rgba = { rgba: string; width: number; height: number }

type Base64Able = Uint8Array & { toBase64: () => string }

export function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}

export function rgba(px: Uint8Array, width: number, height: number): Rgba {
  return { rgba: (px as Base64Able).toBase64(), width, height }
}

// A picture of one colour over an alpha mask (base64, width*height bytes).
export function inked(rgb: Rgb, alpha: string, width: number, height: number): Rgba {
  const px = new Uint8Array(width * height * 4)
  fromBase64(alpha).forEach((v, i) => {
    if (v !== 0) px.set([rgb[0], rgb[1], rgb[2], v], i * 4)
  })
  return rgba(px, width, height)
}
