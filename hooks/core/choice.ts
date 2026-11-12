// What `/spinner <arg>` asks for: the tag it names, an unknown tag, or with
// no argument (null) the style that is on.
export function choose(tags: readonly string[], arg: string): { tag: string } | { unknown: string } | null {
  const wanted = arg.trim().toLowerCase()
  if (wanted === '') return null
  return tags.includes(wanted) ? { tag: wanted } : { unknown: wanted }
}
