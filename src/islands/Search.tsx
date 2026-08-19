import { useEffect, useRef, useState } from 'react'
import {
  HITS_PER_PAGE,
  MAX_PAGES,
  highlight,
  search,
  type ArticleHit,
  type Cue,
  type SearchResult,
  type Tab,
} from '../lib/meili'
import { arabicDate, timestamp } from '../lib/format'
import { DirectionProvider } from '@base-ui/react/direction-provider'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type PlaylistOption = { id: string; title: string; count: number }
type Status = 'idle' | 'loading' | 'done' | 'error'

/** The URL is the state: ?q=<query>&t=v|a&pl=<playlistId>&pl=<…>&p=<page>. */
function readUrl() {
  const p = new URLSearchParams(location.search)
  return {
    q: p.get('q') ?? '',
    pl: p.getAll('pl'),
    tab: (p.get('t') === 'a' ? 'a' : 'v') as Tab,
    page: Math.min(Math.max(Number(p.get('p')) || 1, 1), MAX_PAGES),
  }
}

function pushUrl(q: string, pl: string[], page: number, tab: Tab) {
  const p = new URLSearchParams()
  if (q) p.set('q', q)
  if (tab === 'a') p.set('t', 'a')
  for (const id of pl) p.append('pl', id)
  if (page > 1) p.set('p', String(page))
  const qs = p.toString()
  const url = location.pathname + (qs ? `?${qs}` : '')
  if (url !== location.pathname + location.search) history.pushState(null, '', url)
}

/** 0 selected means "no filter", so the trigger says «all» rather than staying empty. */
function playlistLabel(ids: string[], playlists: PlaylistOption[]) {
  if (ids.length === 0) return 'كل القوائم'
  if (ids.length === 1) return playlists.find((p) => p.id === ids[0])?.title ?? 'قائمة واحدة'
  if (ids.length === 2) return 'قائمتان'
  return `${ids.length} ${ids.length <= 10 ? 'قوائم' : 'قائمة'}`
}

const KIND: Record<string, string> = { post: 'مقالة', fatwa: 'فتوى', book: 'كتاب' }

export default function Search({ playlists }: { playlists: PlaylistOption[] }) {
  const [q, setQ] = useState('')
  const [pl, setPl] = useState<string[]>([])
  const [tab, setTab] = useState<Tab>('v')
  const [asked, setAsked] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [result, setResult] = useState<SearchResult | null>(null)
  const seq = useRef(0)
  const top = useRef<HTMLDivElement>(null)

  // Only the newest request may set state; older responses are ignored.
  const run = async (query: string, playlist: string[], page: number, next: Tab) => {
    const id = ++seq.current
    const text = query.trim()
    setPl(playlist)
    setTab(next)
    setAsked(text)
    if (!text) {
      setStatus('idle')
      setResult(null)
      return
    }
    setStatus('loading')
    try {
      const res = await search(text, { tab: next, page, playlists: playlist })
      if (id !== seq.current) return
      if (res.hits.length === 0 && res.totalPages >= 1 && page > res.totalPages) {
        go(text, playlist, res.totalPages, next)
        return
      }
      setResult(res)
      setStatus('done')
    } catch {
      if (id !== seq.current) return
      setResult(null)
      setStatus('error')
    }
  }

  useEffect(() => {
    const known = new Set(playlists.map((p) => p.id))
    const sync = () => {
      const u = readUrl()
      // a stale or hand-edited pl= would filter everything away while the select still
      // showed "كل القوائم" — drop it instead
      const pl = u.pl.filter((id) => known.has(id))
      setQ(u.q)
      run(u.q, pl, u.page, u.tab)
    }
    sync()
    addEventListener('popstate', sync)
    return () => removeEventListener('popstate', sync)
  }, [])

  const go = (query: string, playlist: string[], page: number, next: Tab = tab) => {
    pushUrl(query.trim(), playlist, page, next)
    run(query, playlist, page, next)
  }

  const goPage = (page: number) => {
    go(asked, pl, page)
    top.current?.focus({ preventScroll: true })
    top.current?.scrollIntoView()
  }

  const changePlaylist = (value: string[]) => {
    setPl(value)
    if (q.trim()) go(q, value, 1)
  }

  const changeTab = (next: Tab) => {
    if (next === tab) return
    setTab(next)
    if (asked) go(asked, pl, 1, next)
  }

  const from = result ? (result.page - 1) * HITS_PER_PAGE + 1 : 0
  const to = result ? from + result.hits.length - 1 : 0

  return (
    <div className="mt-8">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          go(q, pl, 1)
        }}
      >
        <label htmlFor="search-q" className="sr-only">
          ابحث في نصوص الدروس
        </label>
        <div className="flex gap-2">
          <Input
            id="search-q"
            data-search-input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="مثال: كفارة اليمين"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            className="h-12 min-w-0 flex-1 rounded-xl border-border-strong bg-surface px-4 text-base md:text-base"
          />
          <button
            type="submit"
            className="h-12 shrink-0 rounded-xl bg-accent px-6 font-medium text-accent-fg transition-opacity hover:opacity-90"
          >
            بحث
          </button>
        </div>

        {playlists.length > 0 && tab === 'v' && (
          <div className="mt-3 flex items-center gap-3">
            {/* Base UI takes direction from context, not the <html dir> the page uses. */}
            <DirectionProvider direction="rtl">
              <Select multiple value={pl} onValueChange={changePlaylist}>
                {/* Not aria-labelledby: eab3908 removed the visible label but kept the
                    reference, and a dangling one beats the trigger's own text — the
                    combobox ended up with no accessible name at all (a11y 95 -> 100). */}
                <SelectTrigger
                  aria-label="قائمة التشغيل"
                  className="h-11 min-w-0 flex-1 border-border-strong bg-surface px-3 text-fg sm:max-w-xs"
                >
                  <SelectValue>{() => playlistLabel(pl, playlists)}</SelectValue>
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  {playlists.map((p) => (
                    <SelectItem key={p.id} value={p.id} className="py-2">
                      <span className="truncate">{p.title}</span>
                      <span className="digits shrink-0 text-xs text-muted">({p.count})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DirectionProvider>
            {pl.length > 0 && (
              <button
                type="button"
                onClick={() => changePlaylist([])}
                className="shrink-0 text-sm text-muted underline underline-offset-4 hover:text-fg"
              >
                إلغاء
              </button>
            )}
          </div>
        )}
      </form>

      {result && (
        <nav aria-label="نوع النتائج" className="mt-6 flex gap-2 border-b border-border">
          {(
            [
              ['v', 'فيديوهات', result.counts.v],
              ['a', 'مقالات', result.counts.a],
            ] as [Tab, string, number][]
          ).map(([key, label, n]) => (
            <button
              key={key}
              type="button"
              aria-pressed={tab === key}
              onClick={() => changeTab(key)}
              className={`-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm transition-colors ${
                tab === key
                  ? 'border-accent font-medium text-fg'
                  : 'border-transparent text-muted hover:text-fg'
              }`}
            >
              {label}
              <span className="digits text-xs">{n >= 1000 ? '+1000' : n}</span>
            </button>
          ))}
        </nav>
      )}

      <div
        ref={top}
        tabIndex={-1}
        className="mt-10 scroll-mt-20 outline-none"
        aria-live="polite"
        aria-atomic="true"
      >
        {status === 'loading' && <p className="text-sm text-muted">جارٍ البحث…</p>}
        {status === 'error' && <p className="text-fg">تعذّر الاتصال بالبحث، حاول لاحقًا</p>}
        {status === 'done' &&
          result &&
          (result.total === 0 ? (
            <p className="text-fg">{`لا نتائج لـ "${asked}"`}</p>
          ) : (
            <p className="text-sm text-muted">
              النتائج من <span className="digits">{from}</span> إلى{' '}
              <span className="digits">{to}</span> من أصل{' '}
              <span className="digits">{result.totalIsCapped ? '+1000' : result.total}</span>
            </p>
          ))}
      </div>

      {status === 'loading' && (
        <ul className="mt-4 space-y-3" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="card animate-pulse p-4">
              <div className="h-4 w-2/5 rounded bg-surface-2"></div>
              <div className="mt-5 h-3 w-full rounded bg-surface-2"></div>
              <div className="mt-3 h-3 w-4/5 rounded bg-surface-2"></div>
            </li>
          ))}
        </ul>
      )}

      {status === 'done' && result && result.hits.length > 0 && (
        <>
          <ul className="mt-4 space-y-3">
            {result.tab === 'a'
              ? (result.hits as ArticleHit[]).map((a) => (
                  <li key={a.id}>
                    <a
                      href={`/a/${a.articleId}/#p${a.n}`}
                      className="card block p-4 transition-colors hover:bg-surface-2"
                    >
                      <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                        <span className="rounded-full bg-surface-2 px-2 py-0.5">
                          {KIND[a.type] ?? 'مقالة'}
                        </span>
                        {a.categories.slice(0, 2).map((c) => (
                          <span key={c}>{c}</span>
                        ))}
                      </p>
                      <h2
                        className="mt-2 text-base font-medium text-fg"
                        dangerouslySetInnerHTML={{
                          __html: highlight(a._formatted?.title, a.title),
                        }}
                      ></h2>
                      <p
                        className="prose-naskh mt-2 line-clamp-3 text-muted"
                        dangerouslySetInnerHTML={{
                          __html: highlight(a._formatted?.text, a.text),
                        }}
                      ></p>
                      {a.date && (
                        <p className="digits mt-3 text-xs text-muted">{arabicDate(a.date)}</p>
                      )}
                    </a>
                  </li>
                ))
              : (result.hits as Cue[]).map((cue) => {
                const date = arabicDate(cue.upload_date)
                return (
                  <li key={cue.id}>
                    <a
                      href={`/v/${cue.video_id}/?t=${Math.floor(cue.start)}`}
                      className="card block p-4 transition-colors hover:bg-surface-2"
                    >
                      <h2 className="text-base font-medium text-fg">{cue.title}</h2>
                      <p
                        className="prose-naskh mt-2 line-clamp-3 text-muted"
                        dangerouslySetInnerHTML={{
                          __html: highlight(cue._formatted?.text, cue.text),
                        }}
                      ></p>
                      <p className="mt-3 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                        <span className="digits">{timestamp(cue.start)}</span>
                        {date && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{date}</span>
                          </>
                        )}
                      </p>
                    </a>
                  </li>
                )
                })}
          </ul>

          {result.totalPages > 1 && (
            <nav className="mt-8 flex items-center justify-between gap-3" aria-label="تصفّح النتائج">
              <button
                type="button"
                onClick={() => goPage(result.page - 1)}
                disabled={result.page <= 1}
                className="h-11 rounded-lg border border-border-strong px-4 text-sm text-fg transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40"
              >
                السابق
              </button>
              <p className="text-sm text-muted">
                صفحة <span className="digits">{result.page}</span> من{' '}
                <span className="digits">{result.totalPages}</span>
              </p>
              <button
                type="button"
                onClick={() => goPage(result.page + 1)}
                disabled={result.page >= result.totalPages}
                className="h-11 rounded-lg border border-border-strong px-4 text-sm text-fg transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40"
              >
                التالي
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  )
}
