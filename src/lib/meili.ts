import { Meilisearch } from 'meilisearch'

// import.meta.env only exists under Vite; scripts/selfcheck.ts imports this file too.
const env = import.meta.env ?? ({} as ImportMetaEnv)

export const HOST = env.PUBLIC_MEILI_HOST || 'http://127.0.0.1:7700'
const KEY = env.PUBLIC_MEILI_SEARCH_KEY || ''

export const client = new Meilisearch({ host: HOST, apiKey: KEY })

export const HITS_PER_PAGE = 20
export const MAX_PAGES = 50

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
}

/** YouTube list ids only — anything else would be injected into the filter expression. */
const safePlaylist = (id: string) => (/^[\w-]{1,64}$/.test(id) ? id : '')

export async function search(
  q: string,
  { tab = 'v', page = 1, playlists = [] }: { tab?: Tab; page?: number; playlists?: string[] } = {},
): Promise<SearchResult> {
  const ids = playlists.map(safePlaylist).filter(Boolean)
  const at = Math.min(page, MAX_PAGES)
  // `locales` folds hamza/ta-marbuta at query time; `all` stops the split-off
  // definite article "ال" from matching the whole corpus.
  const common = {
    locales: ['ara'],
    matchingStrategy: 'all' as const,
    highlightPreTag: '<mark>',
    highlightPostTag: '</mark>',
  }

  const cueOpts = {
    ...common,
    page: tab === 'v' ? at : 1,
    hitsPerPage: tab === 'v' ? HITS_PER_PAGE : 0,
    attributesToHighlight: ['text'],
    ...(ids.length ? { filter: `playlist_ids IN [${ids.map((id) => `"${id}"`).join(', ')}]` } : {}),
  }
  const articleOpts = {
    ...common,
    page: tab === 'a' ? at : 1,
    hitsPerPage: tab === 'a' ? HITS_PER_PAGE : 0,
    attributesToHighlight: ['title', 'text'],
    // A hit is one paragraph out of an article; crop it to the words around the match.
    attributesToCrop: ['text'],
    cropLength: 40,
    cropMarker: '…',
  }

  // One round trip for both tabs: the inactive one asks for 0 hits, just its count. A deployment
  // whose Meilisearch has no `articles` index yet (or a search key still scoped to `cues`) fails
  // the whole multi-search, so fall back to the cue query alone rather than take search down.
  const { results } = await client
    .multiSearch({
      queries: [
        { indexUid: 'cues', q, ...cueOpts },
        { indexUid: 'articles', q, ...articleOpts },
      ],
    })
    .catch(async () => ({
      results: [
        await client.index('cues').search(q, cueOpts),
        { hits: [], totalHits: 0, page: 1, totalPages: 0, processingTimeMs: 0 },
      ],
    }))

  const [cues, articles] = results
  const active = tab === 'v' ? cues : articles
  const total = active.totalHits ?? 0
  return {
    tab,
    hits: active.hits as Cue[] | ArticleHit[],
    counts: { v: cues.totalHits ?? 0, a: articles.totalHits ?? 0 },
    total,
    totalIsCapped: total >= 1000,
    page: active.page ?? 1,
    totalPages: Math.min(active.totalPages ?? 1, MAX_PAGES),
    processingTimeMs: active.processingTimeMs,
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
