import { useEffect, useRef, useState } from 'react'
import { HITS_PER_PAGE, MAX_PAGES, highlight, searchCues, type SearchResult } from '../lib/meili'
import { arabicDate, timestamp } from '../lib/format'

type PlaylistOption = { id: string; title: string; count: number }
type Status = 'idle' | 'loading' | 'done' | 'error'

/** The URL is the state: ?q=<query>&pl=<playlistId>&p=<page>. */
function readUrl() {
  const p = new URLSearchParams(location.search)
  return {
    q: p.get('q') ?? '',
    pl: p.get('pl') ?? '',
    page: Math.min(Math.max(Number(p.get('p')) || 1, 1), MAX_PAGES),
  }
}

function pushUrl(q: string, pl: string, page: number) {
  const p = new URLSearchParams()
  if (q) p.set('q', q)
  if (pl) p.set('pl', pl)
  if (page > 1) p.set('p', String(page))
  const qs = p.toString()
  const url = location.pathname + (qs ? `?${qs}` : '')
  if (url !== location.pathname + location.search) history.pushState(null, '', url)
}

export default function Search({ playlists }: { playlists: PlaylistOption[] }) {
  const [q, setQ] = useState('')
  const [pl, setPl] = useState('')
  const [asked, setAsked] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [result, setResult] = useState<SearchResult | null>(null)
  const seq = useRef(0)
  const top = useRef<HTMLDivElement>(null)

  // Only the newest request may set state; older responses are ignored.
  const run = async (query: string, playlist: string, page: number) => {
    const id = ++seq.current
    const text = query.trim()
    setPl(playlist)
    setAsked(text)
    if (!text) {
      setStatus('idle')
      setResult(null)
      return
    }
    setStatus('loading')
    try {
      const res = await searchCues(text, { page, playlist })
      if (id !== seq.current) return
      if (res.hits.length === 0 && res.totalPages >= 1 && page > res.totalPages) {
        go(text, playlist, res.totalPages)
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
      const pl = known.has(u.pl) ? u.pl : ''
      setQ(u.q)
      run(u.q, pl, u.page)
    }
    sync()
    addEventListener('popstate', sync)
    return () => removeEventListener('popstate', sync)
  }, [])

  const go = (query: string, playlist: string, page: number) => {
    pushUrl(query.trim(), playlist, page)
    run(query, playlist, page)
  }

  const goPage = (page: number) => {
    go(asked, pl, page)
    top.current?.focus({ preventScroll: true })
    top.current?.scrollIntoView()
  }

  const changePlaylist = (value: string) => {
    setPl(value)
    if (q.trim()) go(q, value, 1)
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
          <input
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
            className="h-12 min-w-0 flex-1 rounded-xl border border-border-strong bg-surface px-4 text-base text-fg placeholder:text-muted"
          />
          <button
            type="submit"
            className="h-12 shrink-0 rounded-xl bg-accent px-6 font-medium text-accent-fg transition-opacity hover:opacity-90"
          >
            بحث
          </button>
        </div>

        {playlists.length > 0 && (
          <div className="mt-3 flex items-center gap-3">
            <label htmlFor="search-pl" className="shrink-0 text-sm text-muted">
              قائمة التشغيل
            </label>
            <select
              id="search-pl"
              value={pl}
              onChange={(e) => changePlaylist(e.target.value)}
              className="h-11 min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-3 text-sm text-fg sm:max-w-xs"
            >
              <option value="">كل القوائم</option>
              {playlists.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({p.count})
                </option>
              ))}
            </select>
          </div>
        )}
      </form>

      <div
        ref={top}
        tabIndex={-1}
        className="mt-10 scroll-mt-20 outline-none"
        aria-live="polite"
        aria-atomic="true"
      >
        {status === 'idle' && (
          <p className="text-sm text-muted">اكتب كلمة أو عبارة من كلام الشيخ، ثم اضغط «بحث».</p>
        )}
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
            {result.hits.map((cue) => {
              const date = arabicDate(cue.upload_date)
              return (
                <li key={cue.id}>
                  <a
                    href={`/v/${cue.video_id}?t=${Math.floor(cue.start)}`}
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
