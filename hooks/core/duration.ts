// As the engine writes a duration: 42s, 3m 7s, 1h 2m 5s, 1d 1h 0m.
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  let d = Math.floor(ms / 86_400_000)
  let h = Math.floor((ms % 86_400_000) / 3_600_000)
  let m = Math.floor((ms % 3_600_000) / 60_000)
  let s = Math.round((ms % 60_000) / 1000)
  if (s === 60) (s = 0), m++
  if (m === 60) (m = 0), h++
  if (h === 24) (h = 0), d++
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${s}s`
  return `${m}m ${s}s`
}
