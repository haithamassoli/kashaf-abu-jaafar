/** HH:MM:SS (or MM:SS under an hour). Western digits per the PRD. */
export function timestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

/** "2h 14min" style, for video/playlist length. */
export function duration(seconds: number): string {
  const total = Math.round(seconds / 60)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m} د`
  return m === 0 ? `${h} س` : `${h} س ${m} د`
}

/** ISO date -> Arabic-labelled Gregorian date with Western digits. */
const DATE = new Intl.DateTimeFormat('ar-u-nu-latn', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

export function arabicDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(`${iso}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? '' : DATE.format(date)
}

export function youtubeUrl(videoId: string, t?: number): string {
  return t ? `https://youtu.be/${videoId}?t=${Math.floor(t)}` : `https://youtu.be/${videoId}`
}

/**
 * Arabic counted nouns (تمييز العدد). The form follows the last two digits:
 * 1 → مفرد, 2 → مثنى (and the numeral is dropped), 3–10 → جمع,
 * 11–99 → مفرد منصوب, and a round hundred/thousand → مفرد.
 */
function counted(n: number, one: string, two: string, few: string, many: string): string {
  if (n === 2) return two
  const num = n.toLocaleString('en-US')
  if (n === 0) return `0 ${few}`
  const r = n % 100
  if (r === 0 || r === 1) return `${num} ${one}`
  if (r === 2) return `${num} ${two}`
  if (r <= 10) return `${num} ${few}`
  return `${num} ${many}`
}

export const lessons = (n: number) => counted(n, 'درس', 'درسان', 'دروس', 'درسًا')
export const hours = (n: number) => counted(n, 'ساعة', 'ساعتان', 'ساعات', 'ساعة')
export const lists = (n: number) => counted(n, 'قائمة', 'قائمتان', 'قوائم', 'قائمة')
export const articles = (n: number) => counted(n, 'مقالة', 'مقالتان', 'مقالات', 'مقالة')

/** Wrap Western digit runs so they stay LTR-ordered and tabular inside Arabic text. */
export const withDigits = (s: string) =>
  // One run per number, group separators included — `3,333` must not split into `3` and `333`.
  s.replace(/\d+(?:,\d{3})*/g, '<span class="digits">$&</span>')
