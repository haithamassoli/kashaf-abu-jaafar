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

export type SearchResult = {
  hits: Cue[]
  total: number
  totalIsCapped: boolean
  page: number
  totalPages: number
  processingTimeMs: number
}

/** YouTube list ids only — anything else would be injected into the filter expression. */
const safePlaylist = (id: string) => (/^[\w-]{1,64}$/.test(id) ? id : '')

export async function searchCues(
  q: string,
  { page = 1, playlist = '' }: { page?: number; playlist?: string } = {},
): Promise<SearchResult> {
  const res = await client.index('cues').search(q, {
    // `locales` folds hamza/ta-marbuta at query time; `all` stops the split-off
    // definite article "ال" from matching the whole corpus.
    locales: ['ara'],
    matchingStrategy: 'all',
    page: Math.min(page, MAX_PAGES),
    hitsPerPage: HITS_PER_PAGE,
    attributesToHighlight: ['text'],
    highlightPreTag: '<mark>',
    highlightPostTag: '</mark>',
    ...(safePlaylist(playlist) ? { filter: `playlist_ids = "${safePlaylist(playlist)}"` } : {}),
  })

  const total = res.totalHits ?? 0
  return {
    hits: res.hits as Cue[],
    total,
    totalIsCapped: total >= 1000,
    page: res.page ?? 1,
    totalPages: Math.min(res.totalPages ?? 1, MAX_PAGES),
    processingTimeMs: res.processingTimeMs,
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
