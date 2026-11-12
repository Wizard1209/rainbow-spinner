import type { CoreEngineInterface, On } from 'claude-code'
import { check, row, SAY } from './core/caps'
import { choose } from './core/choice'
import { FALLBACK, findStyle, OFF, TAGS, tagOf } from './styles'
import { capsOf, refresh, start } from './terminal'

// The stored choice.
export async function chosen($: Pick<CoreEngineInterface, 'store'>): Promise<unknown> {
  return $.store.get('style')
}

// /spinner <tag> picks a style and keeps it in the store, so it outlives the
// session; a bare /spinner names the style that is on and lists the styles.
// Where this terminal cannot show the style, the row says which style the line
// is drawn in and why, with what was measured: it is what Claude reads.
// The command waits for the turn to end, so a line never changes style halfway.
export function command(on: On) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'spinner', description: 'Switch the spinner style', argumentHint: `[${TAGS.join('|')}]` })
    if (findStyle(await chosen($)) !== undefined) void start($)
    return next(e)
  })

  on('command.run', { command: 'spinner' }, async ($, e) => {
    const picked = choose(TAGS, e.args)
    if (picked === null) return { text: SAY.current(tagOf(await chosen($)), TAGS) }
    if ('unknown' in picked) return { text: SAY.noStyle(picked.unknown, TAGS) }
    await $.store.set('style', picked.tag)
    const style = findStyle(picked.tag)
    if (style === undefined) return { text: SAY.shown(OFF) }
    refresh()
    return { text: row(style.tag, check(style, await capsOf($, e.presentation.isFullscreen, true), FALLBACK)) }
  })
}
