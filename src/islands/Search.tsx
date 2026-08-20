import { useEffect, useMemo, useRef, useState } from 'react'
import {
  HITS_PER_PAGE,
  MAX_PAGES,
  highlight,
  search,
  type ArticleHit,
  type Cue,
  type LessonHit,
  type SearchResult,
  type Tab,
} from '../lib/meili'
import { arabicDate, duration, lessons as countLessons, timestamp } from '../lib/format'
import { normalize } from '../lib/normalize'
import { DirectionProvider } from '@base-ui/react/direction-provider'
import { Combobox } from '@base-ui/react/combobox'
import { CheckIcon, ChevronDownIcon } from 'lucide-react'
import { Input } from '@/components/ui/input'

type PlaylistOption = { id: string; title: string; count: number }
type Status = 'idle' | 'loading' | 'done' | 'error'

/** The URL is the state: ?q=<query>&t=v|a&pl=<playlistId>&pl=<…>&ty=<kind>&p=<page>. */
function readUrl() {
  const p = new URLSearchParams(location.search)
  return {
    q: p.get('q') ?? '',
    pl: p.getAll('pl'),
    ty: p.getAll('ty'),
    tab: (p.get('t') === 'a' ? 'a' : 'v') as Tab,
    page: Math.min(Math.max(Number(p.get('p')) || 1, 1), MAX_PAGES),
  }
}

function pushUrl(q: string, pl: string[], ty: string[], page: number, tab: Tab) {
  const p = new URLSearchParams()
  if (q) p.set('q', q)
  if (tab === 'a') p.set('t', 'a')
  for (const id of pl) p.append('pl', id)
  for (const t of ty) p.append('ty', t)
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
/** Three kinds, so chips rather than a dropdown: one tap to narrow, one to undo. */
const KINDS: [string, string][] = [
  ['post', 'مقالات'],
  ['fatwa', 'فتاوى'],
  ['book', 'كتب'],
]

/** Result links carry the query so the lesson page can pinpoint the phrase, not just the cue. */
function lessonHref(videoId: string, query: string, t?: number) {
  const p = new URLSearchParams()
  if (t !== undefined) p.set('t', String(Math.floor(t)))
  if (query) p.set('q', query)
  return `/v/${videoId}/?${p}`
}

export default function Search({ playlists }: { playlists: PlaylistOption[] }) {
  const [q, setQ] = useState('')
  const [pl, setPl] = useState<string[]>([])
  const [ty, setTy] = useState<string[]>([])
  const [tab, setTab] = useState<Tab>('v')
  const [asked, setAsked] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [result, setResult] = useState<SearchResult | null>(null)
  const seq = useRef(0)
  const top = useRef<HTMLDivElement>(null)
  // The combobox filters `items` through itemToStringLabel, so ids are the items and the
  // map turns one back into its playlist.
  const byId = useMemo(() => new Map(playlists.map((p) => [p.id, p])), [playlists])
  const ids = useMemo(() => [...byId.keys()], [byId])

  // Only the newest request may set state; older responses are ignored.
  const run = async (query: string, playlist: string[], kinds: string[], page: number, next: Tab) => {
    const id = ++seq.current
    const text = query.trim()
    setPl(playlist)
    setTy(kinds)
    setTab(next)
    setAsked(text)
    if (!text) {
      setStatus('idle')
      setResult(null)
      return
    }
    setStatus('loading')
    try {
      const res = await search(text, { tab: next, page, playlists: playlist, types: kinds })
      if (id !== seq.current) return
      if (res.hits.length === 0 && res.totalPages >= 1 && page > res.totalPages) {
        go(text, playlist, kinds, res.totalPages, next)
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
    const kinds = new Set(KINDS.map(([k]) => k))
    const sync = () => {
      const u = readUrl()
      // a stale or hand-edited pl= would filter everything away while the select still
      // showed "كل القوائم" — drop it instead
      const pl = u.pl.filter((id) => known.has(id))
      const ty = u.ty.filter((t) => kinds.has(t))
      setQ(u.q)
      run(u.q, pl, ty, u.page, u.tab)
    }
    sync()
    addEventListener('popstate', sync)
    return () => removeEventListener('popstate', sync)
  }, [])

  const go = (query: string, playlist: string[], kinds: string[], page: number, next: Tab = tab) => {
    pushUrl(query.trim(), playlist, kinds, page, next)
    run(query, playlist, kinds, page, next)
  }

  const goPage = (page: number) => {
    go(asked, pl, ty, page)
    top.current?.focus({ preventScroll: true })
    top.current?.scrollIntoView()
  }

  const changePlaylist = (value: string[]) => {
    setPl(value)
    if (q.trim()) go(q, value, ty, 1)
  }

  const toggleKind = (kind: string) => {
    const next = ty.includes(kind) ? ty.filter((t) => t !== kind) : [...ty, kind]
    setTy(next)
    if (q.trim()) go(q, pl, next, 1)
  }

  const changeTab = (next: Tab) => {
    if (next === tab) return
    setTab(next)
    if (asked) go(asked, pl, ty, 1, next)
  }

  const from = result ? (result.page - 1) * HITS_PER_PAGE + 1 : 0
  const to = result ? from + result.hits.length - 1 : 0

  return (
    <div className="mt-8">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          go(q, pl, ty, 1)
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
              <Combobox.Root
                multiple
                items={ids}
                value={pl}
                onValueChange={changePlaylist}
                itemToStringLabel={(id: string) => byId.get(id)?.title ?? id}
                // One playlist title is fully vowelised, and the default collator filter is
                // literal — typing «السلف» matched nothing. Fold both sides the way search does.
                filter={(id: string, query: string) =>
                  normalize(byId.get(id)?.title ?? id).includes(normalize(query))
                }
              >
                {/* aria-label, not aria-labelledby: eab3908 removed the visible label but kept
                    the reference, and a dangling one beats the trigger's own text — the
                    combobox ended up with no accessible name at all (a11y 95 -> 100). */}
                <Combobox.Trigger
                  aria-label="قائمة التشغيل"
                  className="flex h-11 min-w-0 flex-1 items-center justify-between gap-2 rounded-lg border border-border-strong bg-surface px-3 text-sm text-fg transition-colors hover:bg-surface-2 sm:max-w-xs"
                >
                  <span className="truncate">{playlistLabel(pl, playlists)}</span>
                  <ChevronDownIcon className="size-4 shrink-0 text-muted" />
                </Combobox.Trigger>
                <Combobox.Portal>
                  <Combobox.Positioner sideOffset={4} className="z-50">
                    <Combobox.Popup
                      aria-label="قائمة التشغيل"
                      className="w-(--anchor-width) max-w-(--available-width) overflow-hidden rounded-lg bg-surface text-fg shadow-md ring-1 ring-border"
                    >
                      <Combobox.Input
                        placeholder="ابحث في القوائم"
                        className="h-11 w-full border-b border-border bg-transparent px-3 text-base outline-none placeholder:text-muted"
                      />
                      <Combobox.Empty>
                        <p className="px-3 py-4 text-sm text-muted">لا قوائم مطابقة</p>
                      </Combobox.Empty>
                      <Combobox.List className="max-h-64 overflow-y-auto overscroll-contain p-1">
                        {(id: string) => (
                          <Combobox.Item
                            key={id}
                            value={id}
                            className="relative flex cursor-default items-center gap-2 rounded-md py-2 pe-8 ps-2 text-sm outline-none select-none data-highlighted:bg-surface-2"
                          >
                            <span className="truncate">{byId.get(id)?.title}</span>
                            <span className="digits shrink-0 text-xs text-muted">
                              ({byId.get(id)?.count})
                            </span>
                            <Combobox.ItemIndicator className="absolute end-2 flex size-4 items-center justify-center">
                              <CheckIcon className="size-4" />
                            </Combobox.ItemIndicator>
                          </Combobox.Item>
                        )}
                      </Combobox.List>
                    </Combobox.Popup>
                  </Combobox.Positioner>
                </Combobox.Portal>
              </Combobox.Root>
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

        {tab === 'a' && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {KINDS.map(([kind, label]) => {
              const on = ty.includes(kind)
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleKind(kind)}
                  className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm transition-colors ${
                    on
                      ? 'border-accent bg-accent-soft font-medium text-accent'
                      : 'border-border-strong text-muted hover:bg-surface-2 hover:text-fg'
                  }`}
                >
                  {label}
                </button>
              )
            })}
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
          (result.total === 0 && result.lessons.length === 0 ? (
            <div className="text-fg">
              <p>{`لا نتائج لـ "${asked}"`}</p>
              <ul className="mt-3 space-y-1 text-sm text-muted">
                <li>جرّب كلمات أقل، أو الكلمات الأساسية وحدها دون أدوات الاستفهام.</li>
                {(pl.length > 0 || ty.length > 0) && <li>أو أزل التصفية، فقد تكون النتيجة خارجها.</li>}
                {/* A zero here often means «not transcribed yet», not «he never said it». Saying
                    so is the difference between a dead end and a reason to come back. */}
                <li>
                  التفريغ ما زال جاريًا: فُرّغ حتى الآن نحو <span className="digits">1600</span> درس
                  من نحو <span className="digits">4000</span> على القناة.
                </li>
              </ul>
            </div>
          ) : result.widened ? (
            // ponytail: no heuristic separates a near-miss from nonsense here — measured, a real
            // question matched 1/3 of its words while gibberish matched 3/3 — so we label the
            // results loosely and hand over the same advice the empty state gives.
            <div>
              <p className="text-sm text-fg">
                {`لم نجد تطابقًا تامًّا لـ "${asked}"، وهذه أقرب ما وجدنا`}
              </p>
              <p className="mt-1 text-sm text-muted">
                للنتائج الدقيقة جرّب الكلمات الأساسية وحدها، دون أدوات الاستفهام.
              </p>
            </div>
          ) : result.total === 0 ? (
            <p className="text-sm text-muted">{`لا مقاطع تطابق "${asked}" حرفيًّا، لكن هذه الدروس تتناوله`}</p>
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

      {status === 'done' && result && result.lessons.length > 0 && (tab === 'v' || result.total === 0) && (
        <section aria-labelledby="lessons-heading" className="mt-4">
          <h2 id="lessons-heading" className="text-sm font-medium text-fg">
            دروس تتناول سؤالك
          </h2>
          <p className="mt-1 text-xs text-muted">
            كل كلمات سؤالك وردت في هذه الدروس، وإن تفرّقت في مواضع منها
          </p>
          <ul className="mt-3 space-y-2">
            {result.lessons.map((l: LessonHit) => (
              <li key={l.id}>
                <a
                  href={lessonHref(l.video_id, asked)}
                  className="card block border-accent/30 bg-accent-soft/40 p-4 transition-colors hover:bg-accent-soft"
                >
                  <h3
                    className="text-base font-medium text-fg"
                    dangerouslySetInnerHTML={{ __html: highlight(l._formatted?.title, l.title) }}
                  ></h3>
                  <p className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                    {l.duration && <span className="digits">{duration(l.duration)}</span>}
                    {l.duration && l.upload_date && <span aria-hidden="true">·</span>}
                    {l.upload_date && <span>{arabicDate(l.upload_date)}</span>}
                  </p>
                </a>
              </li>
            ))}
          </ul>
          {result.lessonsTotal > result.lessons.length && (
            <p className="mt-2 text-xs text-muted">من أصل {countLessons(result.lessonsTotal)}</p>
          )}
        </section>
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
                        <p className="mt-3 text-xs text-muted"><bdi>{arabicDate(a.date)}</bdi></p>
                      )}
                    </a>
                  </li>
                ))
              : (result.hits as Cue[]).map((cue) => {
                const date = arabicDate(cue.upload_date)
                return (
                  <li key={cue.id}>
                    <a
                      href={lessonHref(cue.video_id, asked, cue.start)}
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
