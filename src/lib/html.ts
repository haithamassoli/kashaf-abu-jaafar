/**
 * HTML -> paragraphs, shared by the article ingests (Blogger feed, Wayback WP pages, Telegram).
 * The first two are the same Word-pasted markup: MSO conditional comments, <o:p>, nested divs.
 */
const ENTITY: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rlm: '\u200f',
  lrm: '\u200e',
}

export const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#[0-9]+|\w+);/gi, (m, e: string) => {
    if (e[0] !== '#') return ENTITY[e.toLowerCase()] ?? m
    const hex = e[1] === 'x' || e[1] === 'X'
    const code = parseInt(hex ? e.slice(2) : e.slice(1), hex ? 16 : 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : m
  })

export const lines = (html: string): string[] =>
  html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((p) => decode(p).replace(/\s+/g, ' ').trim())
    .filter(Boolean)

// The author hard-wraps: 99% of source lines are under 100 chars, so one doc per line would
// split phrases across documents and kill recall. Glue them back into ~paragraph-sized chunks.
const CHUNK = 500

export function chunk(lines: string[]): string[] {
  const out: string[] = []
  let buf = ''
  for (const line of lines) {
    buf = buf ? `${buf} ${line}` : line
    if (buf.length >= CHUNK) {
      out.push(buf)
      buf = ''
    }
  }
  if (buf) out.push(buf)
  return out
}

export const paragraphs = (html: string): string[] => chunk(lines(html))

/** Match titles across the two sources: same post, different diacritics/punctuation/spacing. */
export const titleKey = (t: string): string =>
  decode(t)
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, '')
