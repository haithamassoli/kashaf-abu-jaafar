import { Meilisearch } from 'meilisearch'

// import.meta.env only exists under Vite; scripts/ import this file under tsx too. The
// globalThis hop is what keeps that fallback safe — a bare `process` would throw in the browser,
// and under Vite the first operand is truthy so the rest is never evaluated.
const env = import.meta.env ??
  (((globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env ??
    {}) as unknown as ImportMetaEnv)

export const HOST = env.PUBLIC_MEILI_HOST || 'http://127.0.0.1:7700'
const KEY = env.PUBLIC_MEILI_SEARCH_KEY || ''

// Without this the fetch is unbounded: a Meilisearch that stalls rather than refuses leaves the
// UI on «جارٍ البحث…» forever with no retry. ponytail: the fallback below re-requests once, so a
// dead host costs two timeouts before the error shows — bounded, which is the point.
export const client = new Meilisearch({ host: HOST, apiKey: KEY, timeout: 10_000 })

export const HITS_PER_PAGE = 20
export const MAX_PAGES = 50

/** Lessons to offer above the results. Three fit above the fold; more is a second result list. */
const LESSON_LIMIT = 3
/**
 * A lesson doc is a whole 42-minute transcript, so a common word matches most of the corpus and
 * «all words appear somewhere in it» stops being information. Measured against 1,584 lessons:
 * real questions land at 3–13% of the corpus, while «الصلاة» hits 95% and «حكم الصلاة» 66%.
 * 300 ≈ 19% sits in the gap. ponytail: absolute, not a ratio — revisit as the corpus grows.
 */
const LESSON_CEILING = 300

export type Cue = {
  id: string
  video_id: string
  title: string
  url: string
  start: number
  end: number
  text: string
  playlist_ids?: string[]
  upload_date?: string
  duration?: number
  channel?: string
  _formatted?: { text?: string }
}

/** One paragraph of an article; `articles` is distinct on articleId, so hits are one per article. */
export type ArticleHit = {
  id: string
  articleId: string
  type: string
  source: string
  title: string
  categories: string[]
  date: string | null
  n: number
  text: string
  _formatted?: { title?: string; text?: string }
}

/**
 * A whole lesson transcript as one document. `text` is searchable but never displayed —
 * it is ~9,000 words — so these carry no snippet by design.
 */
export type LessonHit = {
  id: string
  video_id: string
  title: string
  playlist_ids?: string[]
  upload_date?: string
  duration?: number
  _formatted?: { title?: string }
}

export type Tab = 'v' | 'a'

export type SearchResult = {
  tab: Tab
  hits: Cue[] | ArticleHit[]
  /** Both tabs' totals, so the tab strip can show counts without a second round trip. */
  counts: Record<Tab, number>
  total: number
  totalIsCapped: boolean
  page: number
  totalPages: number
  processingTimeMs: number
  /**
   * Nothing matched strictly — anywhere, including at lesson level — so these hits come from
   * a relaxed retry and must be labelled as such. The user asked a question; silently handing
   * back looser matches as if they were exact is the one thing worse than zero results.
   */
  widened: boolean
  /** Lessons whose transcript covers every query word. Empty when it would not be telling. */
  lessons: LessonHit[]
  /** Lesson matches found but suppressed as too broad to mean anything — for the empty state. */
  lessonsTotal: number
}

/** YouTube list ids only — anything else would be injected into the filter expression. */
const safePlaylist = (id: string) => (/^[\w-]{1,64}$/.test(id) ? id : '')
/** Article `type` is a closed set written by scripts/articles.ts. */
const ARTICLE_TYPES = new Set(['post', 'fatwa', 'book'])

const quote = (values: string[]) => values.map((v) => `"${v}"`).join(', ')

type Options = {
  tab?: Tab
  page?: number
  playlists?: string[]
  /** Article kinds to keep; empty means all of them. */
  types?: string[]
}

/**
 * `locales` folds hamza/ta-marbuta at query time. `all` is the strict pass: every word must
 * occur in the same document. On a ~148-word cue that is a hard ask — measured, 40% of real
 * questions return nothing under it — which is what `widen` below exists to catch.
 */
const common = {
  locales: ['ara'],
  highlightPreTag: '<mark>',
  highlightPostTag: '</mark>',
}

type Strategy = 'all' | 'frequency'

function pair(q: string, { tab = 'v', page = 1, playlists = [], types = [] }: Options, strategy: Strategy) {
  const ids = playlists.map(safePlaylist).filter(Boolean)
  const kinds = types.filter((t) => ARTICLE_TYPES.has(t))
  const at = Math.min(page, MAX_PAGES)
  const shared = { ...common, matchingStrategy: strategy }

  return [
    {
      indexUid: 'cues',
      q,
      ...shared,
      page: tab === 'v' ? at : 1,
      hitsPerPage: tab === 'v' ? HITS_PER_PAGE : 0,
      attributesToHighlight: ['text'],
      ...(ids.length ? { filter: `playlist_ids IN [${quote(ids)}]` } : {}),
    },
    {
      indexUid: 'articles',
      q,
      ...shared,
      page: tab === 'a' ? at : 1,
      hitsPerPage: tab === 'a' ? HITS_PER_PAGE : 0,
      attributesToHighlight: ['title', 'text'],
      // A hit is one paragraph out of an article; crop it to the words around the match.
      attributesToCrop: ['text'],
      cropLength: 40,
      cropMarker: '…',
      ...(kinds.length ? { filter: `type IN [${quote(kinds)}]` } : {}),
    },
  ]
}

const EMPTY = { hits: [], totalHits: 0, page: 1, totalPages: 0, processingTimeMs: 0 }

/**
 * One round trip for both tabs: the inactive one asks for 0 hits, just its count. A deployment
 * whose Meilisearch has no `articles` index yet (or a search key still scoped to `cues`) fails
 * the whole multi-search, so fall back to the cue query alone rather than take search down.
 */
async function both(queries: ReturnType<typeof pair>) {
  return client
    .multiSearch({ queries })
    .then((r) => r.results)
    .catch(async () => [await client.index('cues').search(queries[0].q, queries[0]), EMPTY])
}

/**
 * Lessons ride alongside rather than inside the multi-search: `lessons` is the newest index,
 * so it is the one most likely to be missing on a half-migrated deployment, and folding it into
 * the same request would take cues and articles down with it. Concurrent, so it costs no latency.
 */
async function lessonsFor(q: string, playlists: string[], strategy: Strategy) {
  const ids = playlists.map(safePlaylist).filter(Boolean)
  return client
    .index('lessons')
    .search(q, {
      ...common,
      matchingStrategy: strategy,
      hitsPerPage: LESSON_LIMIT,
      page: 1,
      attributesToHighlight: ['title'],
      ...(ids.length ? { filter: `playlist_ids IN [${quote(ids)}]` } : {}),
    })
    .catch(() => null)
}

export async function search(q: string, options: Options = {}): Promise<SearchResult> {
  const { tab = 'v', playlists = [] } = options

  const [strict, lessonRes] = await Promise.all([
    both(pair(q, options, 'all')),
    lessonsFor(q, playlists, 'all'),
  ])

  let [cues, articles] = strict
  const lessonsTotal = lessonRes?.totalHits ?? 0
  // A single word matches nearly every lesson, so the block is only meaningful for a phrase.
  const telling = q.trim().split(/\s+/).length >= 2 && lessonsTotal > 0 && lessonsTotal <= LESSON_CEILING
  const lessons = telling ? ((lessonRes?.hits ?? []) as LessonHit[]) : []

  // Widen when nothing is SHOWN, not when nothing was found: a query can match 494 lessons and
  // still be suppressed by the ceiling above, and «494 matches» plus a blank page is the worst
  // of both. `frequency` drops the rarest term first — loose, so it stays the last resort and
  // gets labelled rather than passed off as an exact match.
  let widened = false
  if (!cues.totalHits && !articles.totalHits && !lessons.length && q.trim()) {
    const relaxed = await both(pair(q, options, 'frequency'))
    if (relaxed[0].totalHits || relaxed[1].totalHits) {
      ;[cues, articles] = relaxed
      widened = true
    }
  }

  const active = tab === 'v' ? cues : articles
  const total = active.totalHits ?? 0
  return {
    tab,
    hits: active.hits as Cue[] | ArticleHit[],
    counts: { v: cues.totalHits ?? 0, a: articles.totalHits ?? 0 },
    total,
    totalIsCapped: total >= 1000,
    page: active.page ?? 1,
    // A widened query has no meaningful tail — page 40 of a loose match is noise, so cap it.
    totalPages: widened ? Math.min(active.totalPages ?? 1, 1) : Math.min(active.totalPages ?? 1, MAX_PAGES),
    processingTimeMs: active.processingTimeMs,
    widened,
    lessons,
    lessonsTotal,
  }
}

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const MARK = /(<mark>|<\/mark>)/g
const ARTICLE = 'ال|أل|إل|آل|ٱل'
const LONE_ARTICLE = new RegExp(`<mark>(${ARTICLE})</mark>`, 'g')
// a merged highlight can end on the article of the *next* word — push it back out
const TRAILING_ARTICLE = new RegExp(`\\s(${ARTICLE})</mark>`, 'g')

/**
 * Meilisearch marks every matched token, including the definite article it splits
 * off and each word of a phrase separately. Escape the text, keep only <mark>,
 * then tidy: drop article-only marks and merge marks that are adjacent.
 */
export function highlight(formatted: string | undefined, fallback: string): string {
  const raw = formatted ?? fallback
  const html = raw
    .split(MARK)
    .map((part) => (part === '<mark>' || part === '</mark>' ? part : part.replace(/[&<>]/g, (c) => ESCAPE[c])))
    .join('')

  return html
    .replace(/<\/mark>(\s*)<mark>/g, '$1')
    .replace(TRAILING_ARTICLE, '</mark> $1')
    // last: pushing a trailing article out can itself leave a mark holding only an article
    .replace(LONE_ARTICLE, '$1')
}
