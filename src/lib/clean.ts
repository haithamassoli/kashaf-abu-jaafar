/**
 * YouTube's auto-captions inject sound-event tags mid-sentence ([موسيقى], [تصفيق], …).
 * They land in ~6% of chunks and break phrase search, so both the search index and
 * the on-page transcript strip them. tafrigh stays unmodified (PRD: shaping is ours).
 */
const TAG = /\[[^\]]{0,30}\]/g

export function clean(text: string): string {
  return text.replace(TAG, ' ').replace(/\s+/g, ' ').trim()
}
