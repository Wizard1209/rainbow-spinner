import type { On } from 'claude-code'
import { chosen } from './command'
import { box, check } from './core/caps'
import { FALLBACK, findStyle } from './styles'
import { capsOf } from './terminal'

// The row's text: under the plugin's name, as the engine passes it, or bare;
// the reasons after the fallback are left to row().
const DEGRADED = /^(?:rainbow-spinner: )?spinner: ([a-z-]+) → [a-z-]+(?: · |$)/

// A /spinner row whose style this terminal cannot show draws as a box with the
// reasons and what to ask Claude, for as long as the style is still the chosen
// one and there is still something to ask for.
export function warning(on: On) {
  on('ui.render', { component: 'CommandOutput', props: { command: 'spinner' } }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const style = findStyle(DEGRADED.exec(e.props.text)?.[1])
    if (style === undefined || findStyle(await chosen($)) !== style) return next(e)
    const said = box(style.tag, check(style, await capsOf($, e.viewport?.isFullscreen ?? false), FALLBACK))
    if (said === undefined) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
        <Text color="inactive">{said[0]}</Text>
        <Text color="text">{said[1]}</Text>
      </Box>
    )
  })
}
