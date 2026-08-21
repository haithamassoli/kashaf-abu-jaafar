import type { APIRoute } from 'astro'
import { allArticles } from '../../lib/data'

const LABEL: Record<string, string> = { post: 'مقالة', fatwa: 'فتوى', book: 'كتاب' }

/**
 * Newest first; the undated few sink to the bottom rather than to 1970.
 * `[...page].astro` imports this so the 20 MB of article JSON is read once, not twice.
 */
export const rows = allArticles()
  .map((a) => ({
    id: a.id,
    title: a.title,
    date: a.date,
    // The type is only worth showing when it isn't the default; otherwise the topic is.
    tag: a.type === 'post' ? (a.categories[0] ?? '') : (LABEL[a.type] ?? ''),
  }))
  .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.title.localeCompare(b.title, 'ar'))

/**
 * `[id, title, isoDate, tag]` — keys repeated 3,333 times cost more than the values do.
 * 520 KB raw / ~111 KB gzip: too big to inline into all 67 pages, so search and sort
 * fetch it once, on the first keystroke.
 */
export const GET: APIRoute = () =>
  new Response(JSON.stringify(rows.map((r) => [r.id, r.title, r.date ?? '', r.tag])), {
    headers: { 'content-type': 'application/json' },
  })
