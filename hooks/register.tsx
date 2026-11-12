import type { Register } from 'claude-code'
import { command } from './command'
import { spinner } from './spinner'
import { warning } from './warning'

// The spinner line under the chat in the chosen style (styles/), /spinner to
// choose it, and the box its row draws as where there is something to ask
// Claude so the terminal shows that style. With the default style, off, every
// line is the engine's.
export const register: Register = on => {
  spinner(on)
  command(on)
  warning(on)
}
