/**
 * Telegram channel posts -> data/articles/tg-<id>.json (+ their photos under public/tg/).
 * The channel is where the sheikh writes now that alkulify.com is 522, so it is a third article
 * source next to scripts/articles.ts (Blogger) and scripts/wayback.ts (archived WordPress).
 *
 * Voice notes are a separate corpus and are skipped, and with them the one-line "…👇" posts
 * that exist only to announce the voice note underneath — they carry no article.
 * Resumable: with no --after it picks up after the newest tg-* already on disk.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { chunk, decode } from '../src/lib/html.ts'

const CHANNEL = 'alkulife'
const DIR = new URL('../data/articles/', import.meta.url).pathname
const IMG = new URL('../public/tg/', import.meta.url).pathname
/** The oldest post asked for; anything before it is not part of this corpus. */
const FLOOR = 14988

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)

/** t.me and its photo CDN both hand back the odd 500 under load; one retry clears them. */
async function get(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url)
    if (res.ok || attempt === 3) return res
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
  }
}

await mkdir(DIR, { recursive: true })
await mkdir(IMG, { recursive: true })

const known = (await readdir(DIR))
  .map((f) => Number(/^tg-(\d+)\.json$/.exec(f)?.[1]))
  .filter((n) => Number.isFinite(n))
const after = Number(arg('after') ?? Math.max(FLOOR - 1, ...known))

/** `t.me/s/<channel>?after=<id>` is the only public read of a channel: 20 messages, oldest first. */
type Msg = { id: number; html: string }
const messages: Msg[] = []
const seen = new Set<number>()
for (let cursor = after; ; ) {
  const res = await get(`https://t.me/s/${CHANNEL}?after=${cursor}`)
  if (!res.ok) throw new Error(`t.me ${res.status} at after=${cursor}`)
  const page = await res.text()
  // Every message is one `tgme_widget_message_wrap`. That wrapper is the outermost element, so
  // slicing at the next one is enough — no need to balance the divs to find its close.
  const starts = [...page.matchAll(/<div class="tgme_widget_message_wrap/g)].map((m) => m.index)
  let last = cursor
  for (const [i, start] of starts.entries()) {
    const html = page.slice(start, starts[i + 1] ?? page.length)
    const id = Number(/data-post="[^/"]+\/(\d+)"/.exec(html)?.[1])
    if (!id || seen.has(id)) continue
    seen.add(id)
    messages.push({ id, html })
    last = Math.max(last, id)
  }
  if (last <= cursor) break
  cursor = last
  process.stdout.write(`\r${messages.length} messages up to ${cursor}`)
}
messages.sort((a, b) => a.id - b.id)
console.log(`\n${messages.length} messages after ${after}`)

/**
 * The message body, walked to its real close: a link preview sits in a sibling right after it.
 * `js-message_text` and not the `tgme_widget_message_text` class, which a reply also carries —
 * matching that one quotes the message being replied to and drops the reply itself.
 */
const bodyHtml = (html: string): string => {
  const open = /<div class="tgme_widget_message_text js-message_text"[^>]*>/.exec(html)
  if (!open) return ''
  const from = open.index + open[0].length
  const tags = /<div\b|<\/div>/g
  tags.lastIndex = from
  let depth = 1
  for (let t = tags.exec(html); t; t = tags.exec(html)) {
    depth += t[0] === '</div>' ? -1 : 1
    if (depth === 0) return html.slice(from, t.index)
  }
  return html.slice(from)
}

/**
 * Body html -> the lines the author typed. Not `lines()` from html.ts: that one folds the blank
 * lines away, and here they are the paragraph breaks. Bidi marks go too — the channel is full of
 * them, they render as nothing, and they only ever break a search or a title comparison.
 */
const textLines = (html: string): string[] =>
  decode(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[​‎‏]/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

const photos = (html: string) =>
  [
    ...html.matchAll(
      /<a class="tgme_widget_message_photo_wrap[^"]*"[^>]*style="([^"]*)"[^>]*>\s*<div class="tgme_widget_message_photo"[^>]*style="([^"]*)"/g,
    ),
  ]
    .map(([, wrap, inner]) => ({
      url: /background-image:url\('([^']+)'\)/.exec(wrap)?.[1],
      // Telegram's own display box. The numbers are not the natural size, but the ratio is, and
      // that is all `width`/`height` have to carry for the browser to reserve the right space.
      w: Math.round(Number(/width:(\d+(?:\.\d+)?)px/.exec(wrap)?.[1] ?? 0)) || 800,
      ratio: Number(/padding-top:(\d+(?:\.\d+)?)%/.exec(inner)?.[1] ?? 0) || 100,
    }))
    .filter((p) => p.url)

const isVoice = (m: Msg) => /tgme_widget_message_(voice|audio)/.test(m.html)

/**
 * Intrinsic size, read off the JPEG. Telegram's own `padding-top` is the crop box of its feed
 * and is capped at 4:3, so a 369x800 screenshot reports as 369x492 — reserving that leaves the
 * text under it jumping 300px on load. Returns null for anything that is not a JPEG.
 */
const jpegSize = (b: Buffer): { w: number; h: number } | null => {
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) {
      i++
      continue
    }
    const marker = b[i + 1]
    // SOF0..SOF15 carry the frame header; DHT/JPG/DAC sit in the same range and do not
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) }
    // standalone markers: no length field to skip over
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2
      continue
    }
    i += 2 + b.readUInt16BE(i + 2)
  }
  return null
}

type Image = { src: string; w: number; h: number }
type Draft = { id: number; date: string; lines: string[]; images: Image[] }
const drafts: Draft[] = []
let voice = 0
let headers = 0

for (const [i, m] of messages.entries()) {
  if (m.id < FLOOR) continue
  if (isVoice(m)) {
    voice++
    continue
  }
  const lines = textLines(bodyHtml(m.html))
  const text = lines.join('\n')
  // The "…👇" pointer: a title for the voice note underneath it, and nothing else.
  if (!text || (messages[i + 1] && isVoice(messages[i + 1]) && text.length < 200)) {
    headers++
    continue
  }

  const images: Image[] = []
  for (const [n, p] of photos(m.html).entries()) {
    const ext = /\.(jpe?g|png|webp)$/i.exec(new URL(p.url!).pathname)?.[1]?.toLowerCase() ?? 'jpg'
    const name = `tg-${m.id}-${n}.${ext}`
    const res = await get(p.url!)
    if (!res.ok) {
      console.warn(`\n${m.id}: photo ${res.status}, skipped`)
      continue
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    await writeFile(IMG + name, bytes)
    const size = jpegSize(bytes) ?? { w: p.w, h: Math.round((p.w * p.ratio) / 100) }
    images.push({ src: `/tg/${name}`, ...size })
  }

  const prev = drafts[drafts.length - 1]
  // Past Telegram's 4,096-character limit the author splits a post himself, closing one message
  // with `=` and opening the next with it. Two documents there would cut a sentence in half.
  if (prev && lines[0] === '=') {
    if (prev.lines.at(-1) === '=') prev.lines.pop()
    prev.lines.push(...lines.slice(1))
    prev.images.push(...images)
    continue
  }
  const date = /<a class="tgme_widget_message_date"[^>]*><time datetime="([^"]+)"/.exec(m.html)?.[1]
  drafts.push({ id: m.id, date: (date ?? '').slice(0, 10), lines, images })
}

/** No message carries a title, so the opening line is it — extended when it is an interjection. */
const titleOf = (lines: string[]) => {
  let t = lines[0]
  if (t.length < 30 && lines[1]) t = `${t} ${lines[1]}`
  if (t.length <= 100) return t
  const cut = t.slice(0, 100)
  return `${cut.slice(0, cut.lastIndexOf(' ')) || cut}…`
}

for (const d of drafts) {
  await writeFile(
    `${DIR}tg-${d.id}.json`,
    JSON.stringify({
      id: `tg-${d.id}`,
      type: 'post',
      source: 'telegram',
      title: titleOf(d.lines),
      date: d.date || null,
      modified: null,
      categories: [],
      url: `https://t.me/${CHANNEL}/${d.id}`,
      images: d.images,
      // Same ~500-character chunks as the other two ingests, so `#p<n>` means the same thing.
      paragraphs: chunk(d.lines),
    }),
  )
}

const pics = drafts.reduce((n, d) => n + d.images.length, 0)
console.log(
  `done: ${drafts.length} articles, ${pics} photos in public/tg/ ` +
    `(skipped ${voice} voice notes and ${headers} of their headers)`,
)
