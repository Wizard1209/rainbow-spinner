import type { Style } from '../core/style'
import { bloom } from './bloom'
import { holo } from './holo'
import { temper } from './temper'

// The default: the mod draws nothing, and the engine draws its own lines.
export const OFF = 'off'

// The styles the mod draws, in the order /spinner lists them. The first is the
// one a style is drawn as where the terminal cannot show it.
export const STYLES: readonly Style[] = [temper, holo, bloom]
export const FALLBACK: Style = STYLES[0]!
// Every tag /spinner takes.
export const TAGS: readonly string[] = [OFF, ...STYLES.map(s => s.tag)]

// The style a tag names; undefined (off) for off and for anything else.
export function findStyle(tag: unknown): Style | undefined {
  return STYLES.find(s => s.tag === tag)
}

export function tagOf(tag: unknown): string {
  return findStyle(tag)?.tag ?? OFF
}
