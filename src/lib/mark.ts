/** Client-side <mark>ing for the in-video transcript filter. Mirrors lib/meili's highlight. */
import { normalize } from './normalize.ts'

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const escape = (s: string) => s.replace(/[&<>]/g, (c) => ESCAPE[c])

/**
 * Escape first, then <mark> every word overlapping a match of the normalized query.
 * Folding shifts character offsets, so matches are mapped back word by word.
 */
export function markMatches(text: string, nq: string): string {
  // An empty query makes indexOf('') loop forever below — and there is nothing to mark.
  if (!nq) return escape(text)
  const words = text.split(/\s+/)
  const folded = words.map(normalize)
  let at = 0
  const offsets = folded.map((f) => {
    const start = at
    if (f) at += f.length + 1
    return start
  })
  const line = folded.filter(Boolean).join(' ')
  const hit = words.map(() => false)

  for (let i = line.indexOf(nq); i !== -1; i = line.indexOf(nq, i + 1)) {
    const end = i + nq.length
    for (let w = 0; w < words.length; w++) {
      if (folded[w] && offsets[w] < end && i < offsets[w] + folded[w].length) hit[w] = true
    }
  }
  return words
    .map((w, i) => (hit[i] ? `<mark>${escape(w)}</mark>` : escape(w)))
    .join(' ')
    .replace(/<\/mark> <mark>/g, ' ') // one continuous mark per phrase, as in search results
}
