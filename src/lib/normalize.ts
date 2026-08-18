/**
 * Same folding tafrigh applies to `search_text`, so client-side filters
 * (in-video search) behave like Meilisearch does.
 */
const DIACRITICS = /[ً-ْٰـ]/g

export function normalize(text: string): string {
  return text
    .replace(DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}
