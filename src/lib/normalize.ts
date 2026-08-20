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

/**
 * charabia splits a word-initial `ال` into its own token but leaves `وال/فال/بال/كال/لل`
 * whole, so a search for `الصلاة` never reaches `والصلاة` — 61% of cues were unreachable
 * from the bare form. Map each prefixed spelling back to the stem charabia *would* have
 * produced; scripts/index.ts feeds it to Meilisearch `synonyms`, which also gets the
 * prefixed word highlighted natively. Settings-only: no document re-index.
 */
const PREFIXED = /^(?:[وف][بكل]?|[بكل])ال(.+)$|^(?:[وف])?لل(.+)$/
const ARABIC = /[ء-ي]+/g

export function articleStem(word: string): string | null {
  // لفظ الجلالة elides a lam: الله -> [ال][له], so لله strips to له, not to ه
  if (word === 'لله' || word === 'ولله' || word === 'فلله') return 'له'
  const m = PREFIXED.exec(word)
  return m ? (m[1] ?? m[2]) : null
}

/**
 * stem -> every prefixed spelling of it that occurs in the corpus, AND each prefixed spelling
 * back to its stem. Meilisearch synonyms are one-way, so the reverse is not free: without it a
 * reader who writes «الاستماع للأغاني» or «الاحتفال بالمولد» — the natural phrasings — queries a
 * token with no key at all, and `للاغاني` matches 0 cues while `اغاني` matches 1,158.
 */
export function articleSynonyms(texts: Iterable<string>): Record<string, string[]> {
  const map = new Map<string, Set<string>>()
  const add = (key: string, value: string) => {
    let set = map.get(key)
    if (!set) map.set(key, (set = new Set()))
    set.add(value)
  }
  for (const t of texts)
    for (const w of normalize(t).match(ARABIC) ?? []) {
      const stem = articleStem(w)
      if (!stem) continue
      add(stem, w)
      add(w, stem)
    }
  return Object.fromEntries([...map].map(([k, v]) => [k, [...v]]))
}
