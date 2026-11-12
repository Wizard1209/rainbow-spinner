import type { On } from 'claude-code'
import { chosen } from './command'
import { check, type Plan } from './core/caps'
import type { Style } from './core/style'
import { drawable, loopTime, type Png, picturePng, sheetPng } from './core/picture'
import { FALLBACK, findStyle } from './styles'
import type { LineProps } from './spinner-client'
import { capsOf, moduleSide, pictureTaken, picturesRefused } from './terminal'
import { marker } from './core/wezterm'
import { drawn, drop, ready, type Sheet, show } from './wezterm'

// A terminal the mod cannot tell refuses pictures while the Image draws its
// alt: a line's pictures refused this many times in a row turn them off.
const REFUSALS = 3

// What each spinner's pictures last showed, by requestId, so a redraw of the
// line (a new state, a resize) shows the running frame rather than the first,
// and a glyph's picture is sent only when it changes. The glyph is kept as
// the time of its frame: sprite() answers one object while a picture holds.
// Its plan is the one the line was drawn to, which the clock's posts follow.
type Shown = { plan: Plan; text: string; word?: Png; glyphAt?: number; refused: number }
const shown = new Map<string, Shown>()
const LINES = 32

// The word's pictures by style, text and time in the loop: a looping style's
// frames are made once (each PNG costs some milliseconds) and sent again from
// here. Enough for a few words' loops.
const wordPictures = new Map<string, Png>()
const WORD_PICTURES = 256

function wordPicture(style: Style, text: string, t: number): Png {
  const at = loopTime(style, t)
  if (style.loopMs === undefined) return picturePng(style.field, text, at)
  const key = `${style.tag} ${at} ${text}`
  let made = wordPictures.get(key)
  if (made === undefined) {
    made = picturePng(style.field, text, at)
    wordPictures.set(key, made)
    if (wordPictures.size > WORD_PICTURES) wordPictures.delete(wordPictures.keys().next().value!)
  }
  return made
}

function remember(id: string, line: Shown) {
  shown.delete(id)
  shown.set(id, line)
  for (const old of shown.keys()) {
    if (shown.size <= LINES) break
    shown.delete(old)
  }
}

// One loop of the word's frames in one sheet, for WezTerm's module.
function loop(style: Style, text: string): Sheet {
  const times = Array.from({ length: Math.ceil((style.loopMs ?? style.frameMs) / style.frameMs) }, (_, k) => loopTime(style, k * style.frameMs))
  return { ...sheetPng(style.field, text, times), count: times.length }
}

// Which parts of the line are pictures under the plan, and the style its text
// is drawn in: a word the atlas cannot draw, or one held back while WezTerm's
// module gets its frames, sends the whole line to text.
function parts(plan: Plan, text: string, held = false): { tag: string; word: boolean; glyph: boolean } {
  if (plan.word === 'picture' && (held || !drawable(text))) return { tag: FALLBACK.tag, word: false, glyph: false }
  return { tag: plan.tag, word: plan.word === 'picture', glyph: plan.glyph === 'picture' }
}

export function spinner(on: On) {
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const chosenStyle = findStyle(await chosen($))
    if (chosenStyle === undefined) return next(e)

    const { Box, Client, Image, Text } = $.ui.resolve(e)
    const said = e.props.message ?? e.props.word
    const text = said + (said.endsWith('…') ? '' : e.props.suffix)
    const { plan } = check(chosenStyle, await capsOf($, e.viewport?.isFullscreen ?? false), FALLBACK)
    // In WezTerm the mod's module draws the word, once it has the word's sheet.
    const side = plan.word === 'picture' && drawable(text) ? await moduleSide($) : undefined
    if (side !== undefined) await show($, side, e.requestId, text, chosenStyle.frameMs, () => loop(chosenStyle, text))
    const pictured = parts(plan, text, side !== undefined && !ready(e.requestId, text))
    const line = { text, activity: e.props.mode, tag: pictured.tag }
    if (!pictured.word && !pictured.glyph) {
      const props: LineProps = { ...line, part: 'line' }
      return (
        <Box flexDirection="row">
          <Client key="line" module="./spinner-client.tsx" props={props} />
        </Box>
      )
    }

    // Between the pictures the line stays text. Its first text keeps the key
    // "line", so falling back to text keeps its instance and its clock, which
    // posts the times the pictures' frames are drawn at.
    const style = plan.tag === chosenStyle.tag ? chosenStyle : FALLBACK
    const last = shown.get(e.requestId)
    const kept = last?.plan.tag === plan.tag ? last : undefined
    const wordSource = pictured.word ? (kept?.text === text && kept.word !== undefined ? kept.word : wordPicture(style, text, 0)) : undefined
    const glyphAt = pictured.glyph ? (kept?.glyphAt ?? 0) : undefined
    remember(e.requestId, { plan, text, word: wordSource, glyphAt, refused: last?.refused ?? 0 })
    // Where the picture is refused its alt shows, for the frames until the
    // line falls back to text: a Nerd Font glyph would be a missing-glyph box
    // there, so a plain dot stands in.
    const alt = style.nerdGlyph === true ? '·' : (style.glyph?.(glyphAt ?? 0).ch ?? ' ')
    const glyph =
      glyphAt !== undefined ? (
        <Image key="glyph" source={style.sprite!(glyphAt)} columns={2} rows={1} alt={alt} />
      ) : (
        <Client key="line" module="./spinner-client.tsx" props={{ ...line, part: 'glyph', clock: true }} />
      )
    const after: LineProps = { ...line, part: wordSource !== undefined ? 'tail' : 'word+tail', clock: glyphAt !== undefined }
    const rest = <Client key={after.clock ? 'line' : 'tail'} module="./spinner-client.tsx" props={after} />
    const cells = Array.from(text).length
    // In WezTerm the module places the word's picture over its marker cells.
    const word =
      wordSource === undefined ? undefined : side !== undefined ? (
        <Text key="word">{marker(cells)}</Text>
      ) : (
        <Image key="word" source={wordSource} columns={cells} rows={1} alt={text} />
      )
    return <Box flexDirection="row">{word !== undefined ? [glyph, word, rest] : [glyph, rest]}</Box>
  })

  // Each post of the line's clock asks for its pictures at that time, sent as
  // blits: no redraw. The word's goes every frame (the engine sends nothing
  // for a source equal to the one shown), the glyph's only when it changes.
  on('ui.message', { component: 'Spinner', element: 'line' }, async ($, e, next) => {
    const { t, tag, text } = (e.data ?? {}) as { t?: unknown; tag?: unknown; text?: unknown }
    const last = shown.get(e.requestId)
    const style = findStyle(tag)
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || typeof text !== 'string' || last === undefined || last.plan.tag !== tag || style === undefined) return next(e)
    const pictured = parts(last.plan, text)
    const side = pictured.word ? await moduleSide($) : undefined
    const word = pictured.word && side === undefined ? wordPicture(style, text, t) : undefined
    const glyph = pictured.glyph ? style.sprite!(t) : undefined
    if (word === undefined && glyph === undefined && side === undefined) return next(e)

    const now: Shown = { plan: last.plan, text, word: last.text === text ? last.word : undefined, glyphAt: last.glyphAt, refused: last.refused }
    const glyphShown = now.glyphAt !== undefined ? style.sprite?.(now.glyphAt) : undefined
    let taken = false
    if (side !== undefined) {
      const result = await drawn($, side, e.requestId, text)
      if (result === 'drawn') {
        now.refused = 0
        taken = true
      } else if (result !== 'pending') {
        now.refused++
        $.ui.log(`rainbow-spinner: ${result.fail}`, { to: 'debug' })
      }
    }
    for (const [key, source] of [['word', word], ['glyph', glyph !== glyphShown ? glyph : undefined]] as const) {
      if (source === undefined) continue
      const result = await $.ui.blit({ requestId: e.requestId, key, source }).catch((err: unknown) => ({ deny: String(err) }))
      if (result.deny === undefined) {
        if (key === 'word') now.word = source
        else now.glyphAt = t
        now.refused = 0
        taken = true
      } else now.refused++
    }
    remember(e.requestId, now)
    if (taken) await pictureTaken($)
    else if (now.refused >= REFUSALS) {
      await picturesRefused($)
      // WezTerm's marker cells are blank without the module's picture.
      if (side !== undefined) await drop($, side, e.requestId, text)
    }
    return {}
  })
}
