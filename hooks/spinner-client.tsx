import type { ClientSurface } from 'claude-code'
import { type Frame, type Span, textFrame } from './core/line'
import { FALLBACK, findStyle } from './styles'

// The part of the line an instance draws as text: all of it, or what the
// pictures leave: the glyph before a pictured word, the time and state after
// it, or the word and tail after a pictured glyph. The instance with `clock`
// posts the time of every frame, which the pictures are drawn at.
export type LineProps = {
  tag: string
  text: string
  activity: string
  part: 'line' | 'glyph' | 'tail' | 'word+tail'
  clock?: boolean
}

const styleFor = (tag: string) => findStyle(tag) ?? FALLBACK

// Each instance's clock. Its timer outlives the call that started it, so it
// reads the newest props from here; and it is kept from the first call, since
// several calls can come before the first setState lands.
type Clock = { props: LineProps; readonly start: number; ms: number; stop: () => void; shown?: string }
const clocks = new WeakMap<object, Clock>()

export default function SpinnerLine(props: LineProps, surface: ClientSurface<{ t: number }>) {
  const { Text } = surface.elements
  const clock = clocks.get(surface) ?? { props, start: Date.now(), ms: 0, stop: () => {} }
  if (!clocks.has(surface)) {
    clocks.set(surface, clock)
    surface.setState({ t: 0 })
  }
  clock.props = props
  // A line falling back from a picture to text keeps its instance and its
  // start, and from then on ticks at the text style's rate.
  const ms = styleFor(props.tag).frameMs
  if (clock.ms !== ms) {
    clock.stop()
    clock.ms = ms
    clock.stop = surface.every(ms, () => tick(surface, clock))
  }

  const frame = frameOf(props, surface.state?.t ?? 0)
  const glyph = (
    <Text weight="bold" color={frame.glyph.colour}>
      {frame.glyph.text}
    </Text>
  )
  const runs = (spans: Span[]) => spans.map(s => <Text color={s.colour}>{s.text}</Text>)
  // One Text of coloured spans: the engine lays out a single line instead of
  // a row of one-letter boxes.
  if (props.part === 'glyph') {
    return (
      <Text>
        {glyph}
        {' '}
      </Text>
    )
  }
  if (props.part === 'tail') return <Text>{runs(frame.tail)}</Text>
  // The glyph's picture covers the space before the word too.
  if (props.part === 'word+tail') return <Text>{runs([...unspaced(frame.word), ...frame.tail])}</Text>
  return (
    <Text>
      {glyph}
      {runs(frame.word)}
      {runs(frame.tail)}
    </Text>
  )
}

function tick(surface: ClientSurface<{ t: number }>, clock: Clock) {
  const p = clock.props
  // Wall time: the frame clock's ticks do not come exactly frameMs apart.
  const t = Date.now() - clock.start
  if (p.clock === true) surface.post({ t, tag: p.tag, text: p.text })
  const shown = JSON.stringify(partOf(p, frameOf(p, t)))
  if (shown !== clock.shown) {
    clock.shown = shown
    surface.setState({ t })
  }
}

function frameOf(p: LineProps, t: number): Frame {
  return textFrame(styleFor(p.tag), p.text, p.activity, t)
}

function partOf(p: LineProps, f: Frame): unknown {
  return p.part === 'glyph' ? f.glyph : p.part === 'tail' ? f.tail : p.part === 'word+tail' ? [f.word, f.tail] : f
}

function unspaced([first, ...rest]: Span[]): Span[] {
  if (first === undefined) return []
  const text = first.text.slice(1)
  return text === '' ? rest : [{ ...first, text }, ...rest]
}
