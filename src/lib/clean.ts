/**
 * YouTube's auto-captions inject sound-event tags mid-sentence ([موسيقى], [تصفيق], …).
 * They land in ~6% of chunks and break phrase search, so both the search index and
 * the on-page transcript strip them. tafrigh stays unmodified (PRD: shaping is ours).
 */
const TAG = /\[[^\]]{0,30}\]/g

export function clean(text: string): string {
  return text.replace(TAG, ' ').replace(/\s+/g, ' ').trim()
}

type Segment = { text: string; start: number; end: number }

/** Merge raw speech fragments up to 15 words, a 2 s gap, or a 20 s span. */
export function mergeSegments<T extends Segment>(segments: T[]): T[] {
  const merged: T[] = []
  let current: T | undefined

  for (const segment of segments) {
    if (!current) {
      current = { ...segment }
    } else if (
      current.text.split(' ').length >= 15 ||
      segment.start - current.end > 2 ||
      segment.end - current.start > 20
    ) {
      merged.push(current)
      current = { ...segment }
    } else {
      current.text += ` ${segment.text}`
      current.end = segment.end
    }
  }

  if (current) merged.push(current)
  return merged
}
