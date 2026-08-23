/**
 * YouTube's auto-captions inject sound-event tags mid-sentence ([موسيقى], [تصفيق], …).
 * They land in ~6% of chunks and break phrase search, so both the search index and
 * the on-page transcript strip them. tafrigh stays unmodified (PRD: shaping is ours).
 */
const TAG = /\[[^\]]{0,30}\]/g

// High-confidence ض/ظ mistakes repeated by the captioning services. Keep this list narrow:
// words such as محظور, فضيعة, القرظي and فظلت are valid and must survive unchanged.
const TYPO =
  /موظوع|فظائل|تفظيل|تفظل|افظل|يفظل|نفظل|مفظل|فظلاء|ايظا|رافظ|ظرب|ظعيف|ظعف|ظبط|(?<!ع)ظمن|ظرور|وظع|رظوان|(?<!ق)رظي|رظا|رمظان|قظايا|قظية|قظاء|قظاة|قظائ|ظح|غظب|الوعض|ضاهر/g
const CORRECTIONS: Record<string, string> = {
  موظوع: 'موضوع',
  فظائل: 'فضائل',
  تفظيل: 'تفضيل',
  تفظل: 'تفضل',
  افظل: 'افضل',
  يفظل: 'يفضل',
  نفظل: 'نفضل',
  مفظل: 'مفضل',
  فظلاء: 'فضلاء',
  ايظا: 'ايضا',
  رافظ: 'رافض',
  ظرب: 'ضرب',
  ظعيف: 'ضعيف',
  ظعف: 'ضعف',
  ظبط: 'ضبط',
  ظمن: 'ضمن',
  ظرور: 'ضرور',
  وظع: 'وضع',
  رظوان: 'رضوان',
  رظي: 'رضي',
  رظا: 'رضا',
  رمظان: 'رمضان',
  قظايا: 'قضايا',
  قظية: 'قضية',
  قظاء: 'قضاء',
  قظاة: 'قضاة',
  قظائ: 'قضائ',
  ظح: 'ضح',
  غظب: 'غضب',
  الوعض: 'الوعظ',
  ضاهر: 'ظاهر',
}
const WORD = /[ء-ي]+/g
const WORD_CORRECTIONS: Record<string, string> = {
  بعظ: 'بعض',
  بعظا: 'بعضا',
  بعظه: 'بعضه',
  بعظها: 'بعضها',
  بعظهم: 'بعضهم',
  بعظهما: 'بعضهما',
  بعظهن: 'بعضهن',
  بعظنا: 'بعضنا',
  بعظكم: 'بعضكم',
  بعظك: 'بعضك',
  بعظي: 'بعضي',
  البعظ: 'البعض',
  ببعظ: 'ببعض',
  ببعظه: 'ببعضه',
  ببعظهم: 'ببعضهم',
  لبعظ: 'لبعض',
  لبعظهم: 'لبعضهم',
  لبعظكم: 'لبعضكم',
  للبعظ: 'للبعض',
  وبعظ: 'وبعض',
  وبعظا: 'وبعضا',
  وبعظه: 'وبعضه',
  وبعظها: 'وبعضها',
  وبعظهم: 'وبعضهم',
  فبعظ: 'فبعض',
  فبعظهم: 'فبعضهم',
  فظل: 'فضل',
  فظلا: 'فضلا',
  فظله: 'فضله',
  فظلها: 'فضلها',
  فظلهم: 'فضلهم',
  فظلهما: 'فضلهما',
  فظلنا: 'فضلنا',
  فظلك: 'فضلك',
  فظلكم: 'فضلكم',
  فظلي: 'فضلي',
  الفظل: 'الفضل',
  والفظل: 'والفضل',
  بفظل: 'بفضل',
  بفظله: 'بفضله',
  بفظلها: 'بفضلها',
  بفظلهم: 'بفضلهم',
  لفظل: 'لفضل',
  حظور: 'حضور',
  الحظور: 'الحضور',
  حظورها: 'حضورها',
  لحظور: 'لحضور',
  فبحظور: 'فبحضور',
  فضيع: 'فظيع',
  الفضيع: 'الفظيع',
  فضيعين: 'فظيعين',
}

export function clean(text: string): string {
  return text
    .replace(TAG, ' ')
    .replace(TYPO, (typo) => CORRECTIONS[typo])
    .replace(WORD, (word) => WORD_CORRECTIONS[word] ?? word)
    .replace(/\s+/g, ' ')
    .trim()
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
