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

/**
 * Semantic search. Cue and article vectors are computed by scripts/embed.ts and stored with
 * `regenerate: false`; at query time Meilisearch embeds only the question, through the Ollama
 * that runs beside it. This is what lets a reader ask «هل للصداق حد أعلى» and reach a lesson
 * that never uses the word حد — the keyword leg alone found 9 of 29 eval answers, the two
 * together find far more.
 */
const EMBEDDER = 'default'
/**
 * How much of the ranking the vector gets, 0 = keyword only. Swept on both question sets:
 * 0.3 buys nothing, 0.6 through 1.0 are identical (24/29 and 15/25 before the floor below).
 * 0.7 sits in the middle of that plateau and keeps the keyword leg contributing the exactness
 * and the <mark>s a purely semantic hit has none of.
 */
const SEMANTIC_RATIO = 0.7
/**
 * Keyword search could not invent a hit: every result contained every word. A vector always
 * returns its nearest neighbour however far away it is, so without a floor `totalHits` becomes
 * «the whole corpus» for every query, the counts stop meaning anything, and nonsense gets a
 * confident page of results. This floor is what keeps «لا نتائج» and the widened fallback real.
 *
 * Measured over both question sets: the best hit for the eight nonsense questions tops out at
 * 0.762, real questions start at 0.758 — the bands touch, so the floor is a choice, not a
 * separation. 0.765 sends all eight to the labelled «أقرب ما وجدنا» path; 0.75 would buy one
 * more answer on the tuned set and let one nonsense query through as a confident result, which
 * is the trade round 1 already refused.
 */
const SCORE_FLOOR = 0.765

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
  start: number
  text: string
  upload_date?: string
  _formatted?: { text?: string }
}

/** One paragraph of an article; `articles` is distinct on articleId, so hits are one per article. */
export type ArticleHit = {
  id: string
  articleId: string
  type: string
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

/**
 * The relaxed retry stays keyword-only: it runs *because* the hybrid pass found nothing above
 * the floor, so asking the same vectors again would return the same rejects, and a query worth
 * widening for is one whose words exist somewhere — that is `frequency`'s job, not the vector's.
 */
function pair(q: string, { tab = 'v', page = 1, playlists = [], types = [] }: Options, strategy: Strategy) {
  const ids = playlists.map(safePlaylist).filter(Boolean)
  const kinds = types.filter((t) => ARTICLE_TYPES.has(t))
  const at = Math.min(page, MAX_PAGES)
  const shared = {
    ...common,
    matchingStrategy: strategy,
    ...(strategy === 'all'
      ? { hybrid: { embedder: EMBEDDER, semanticRatio: SEMANTIC_RATIO }, rankingScoreThreshold: SCORE_FLOOR }
      : {}),
  }

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

/** Same queries with the vector half removed — what search looks like if the embedder is gone. */
const keywordOnly = (queries: ReturnType<typeof pair>) =>
  queries.map(({ hybrid, rankingScoreThreshold, ...rest }) => {
    void hybrid
    void rankingScoreThreshold
    return rest
  })

/**
 * Caddy refuses at 30 requests / 10 s per IP, and its 429 arrives here looking like any other
 * failure. The fallbacks below exist for a missing embedder, not for a closed door: retrying a
 * refusal is how a rate limit turns into three times the traffic it was built to stop.
 */
export const rateLimited = (e: unknown) =>
  (e as { response?: { status?: number } } | null)?.response?.status === 429

/** One round trip for both tabs: the inactive one asks for 0 hits, just its count. */
async function both(queries: ReturnType<typeof pair>) {
  return client
    .multiSearch({ queries })
    .then((r) => r.results)
    // Two ways this fails, and neither should take search down. The embedder can be missing or
    // its Ollama down — the box runs both services — so retry keyword-only, which is worse
    // but is still the whole corpus. Failing that, a deployment whose Meilisearch has no
    // `articles` index yet (or a key still scoped to `cues`) fails the multi-search itself, so
    // fall back to the cue query alone.
    .catch((e) => {
      if (rateLimited(e)) throw e
      return client.multiSearch({ queries: keywordOnly(queries) }).then((r) => r.results)
    })
    .catch(async (e) => {
      if (rateLimited(e)) throw e
      // `indexUid` belongs to multi-search only; passing it to a single-index search is a 400,
      // which turned this fallback into a second failure instead of a rescue.
      const { indexUid, q, ...rest } = keywordOnly(queries)[0]
      void indexUid
      return [await client.index('cues').search(q, rest), EMPTY]
    })
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

/**
 * A tab switch and a back button re-ask a question already answered — same words, same filters,
 * two more round trips to a box that embeds the query on one shared core. Keyed on everything
 * that changes the answer; closing the tab empties it, which is as fresh as a session needs
 * to be (`save` below is what stretches it from the document to the tab).
 * ponytail: bounded FIFO, no TTL — add one if the index starts changing under a live reader.
 */
const CACHE_MAX = 50
const cache = new Map<string, SearchResult>()

const cacheKey = (q: string, { tab = 'v', page = 1, playlists = [], types = [] }: Options) =>
  // sorted: ?pl=a&pl=b and ?pl=b&pl=a are the same question
  JSON.stringify([q.trim(), tab, Math.min(page, MAX_PAGES), [...playlists].sort(), [...types].sort()])

/**
 * The Map dies with the document, and a back button that misses the bfcache *is* a new
 * document — which is the whole «I pressed back and it searched again» complaint. sessionStorage
 * is per-tab and dies with the tab, the same lifetime the Map was already scoped to.
 * The try/catch is also the environment guard: under tsx there is no sessionStorage at all.
 */
const SAVED = 'kaj:q:'

const save = (key: string, result: SearchResult) => {
  const json = JSON.stringify(result)
  try {
    sessionStorage.setItem(SAVED + key, json)
  } catch {
    // Full (or unavailable). Ours is the only thing here worth dropping, and the newest answer
    // is the one a back button is about to ask for.
    try {
      for (const k of Object.keys(sessionStorage)) if (k.startsWith(SAVED)) sessionStorage.removeItem(k)
      sessionStorage.setItem(SAVED + key, json)
    } catch {}
  }
}

/**
 * The cached answer, or undefined. Synchronous on purpose: awaiting a resolved promise still
 * costs a render, and that render is the «جارٍ البحث…» flash that makes a cached tab look
 * like it went back to the server.
 */
export const peek = (q: string, options: Options = {}): SearchResult | undefined => {
  const key = cacheKey(q, options)
  const hit = cache.get(key)
  if (hit) return hit
  try {
    const json = sessionStorage.getItem(SAVED + key)
    if (!json) return undefined
    const result = JSON.parse(json) as SearchResult
    cache.set(key, result)
    return result
  } catch {
    return undefined
  }
}

export async function search(q: string, options: Options = {}): Promise<SearchResult> {
  const { tab = 'v', playlists = [] } = options
  const key = cacheKey(q, options)
  const hit = peek(q, options)
  if (hit) return hit

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
  const result: SearchResult = {
    tab,
    hits: active.hits as Cue[] | ArticleHit[],
    counts: { v: cues.totalHits ?? 0, a: articles.totalHits ?? 0 },
    total,
    totalIsCapped: total >= 1000,
    page: active.page ?? 1,
    // A widened query has no meaningful tail — page 40 of a loose match is noise, so cap it.
    totalPages: widened ? Math.min(active.totalPages ?? 1, 1) : Math.min(active.totalPages ?? 1, MAX_PAGES),
    widened,
    lessons,
    lessonsTotal,
  }

  cache.set(key, result)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  save(key, result)
  return result
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
