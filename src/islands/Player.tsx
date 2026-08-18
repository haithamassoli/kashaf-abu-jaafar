import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { timestamp, youtubeUrl } from '../lib/format'
import { normalize } from '../lib/normalize'

type Segment = { s: number; e: number; t: string }

type Props = { videoId: string; segments: Segment[]; title: string }

type YTPlayer = {
  destroy(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  playVideo(): void
  getCurrentTime(): number
  getIframe(): HTMLIFrameElement
}

declare global {
  interface Window {
    YT?: {
      Player: new (el: HTMLElement, options: unknown) => YTPlayer
      PlayerState: { PLAYING: number }
    }
    onYouTubeIframeAPIReady?: () => void
  }
}

const API_SRC = 'https://www.youtube.com/iframe_api'
/** Embedding disabled / removed by the uploader. */
const EMBED_ERRORS = new Set([101, 150, 153])

let apiReady: Promise<NonNullable<Window['YT']>> | undefined

/** The IFrame API is a global singleton, so the script may only be injected once. */
function loadApi(): Promise<NonNullable<Window['YT']>> {
  apiReady ??= new Promise((resolve) => {
    if (window.YT?.Player) return resolve(window.YT)
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      resolve(window.YT!)
    }
    if (!document.querySelector(`script[src="${API_SRC}"]`)) {
      const script = document.createElement('script')
      script.src = API_SRC
      document.head.append(script)
    }
  })
  return apiReady
}

/** Last segment that has started at `t`, or -1 before the first one. */
function indexAt(segments: Segment[], t: number): number {
  let lo = 0
  let hi = segments.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segments[mid].s <= t) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const escape = (s: string) => s.replace(/[&<>]/g, (c) => ESCAPE[c])

/**
 * Escape first, then <mark> every word overlapping a match of the normalized query.
 * Folding shifts character offsets, so matches are mapped back word by word.
 */
function markMatches(text: string, nq: string): string {
  const words = text.split(/\s+/)
  const folded = words.map(normalize)
  let at = 0
  const offsets = folded.map((f) => {
    const start = at
    if (f) at += f.length + 1
    return start
  })
  const line = folded.filter(Boolean).join(' ')
  const hit = words.map(() => false)

  for (let i = line.indexOf(nq); i !== -1; i = line.indexOf(nq, i + 1)) {
    const end = i + nq.length
    for (let w = 0; w < words.length; w++) {
      if (folded[w] && offsets[w] < end && i < offsets[w] + folded[w].length) hit[w] = true
    }
  }
  return words
    .map((w, i) => (hit[i] ? `<mark>${escape(w)}</mark>` : escape(w)))
    .join(' ')
    .replace(/<\/mark> <mark>/g, ' ') // one continuous mark per phrase, as in search results
}

export default function Player({ videoId, segments, title }: Props) {
  const [active, setActive] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [follow, setFollow] = useState(true)
  const [query, setQuery] = useState('')
  const [announced, setAnnounced] = useState('')
  const [toast, setToast] = useState('')

  const playerRef = useRef<YTPlayer | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const timeRef = useRef(0)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const start = Math.max(0, Math.floor(Number(new URLSearchParams(location.search).get('t')) || 0))
    timeRef.current = start
    setActive(indexAt(segments, start))

    let cancelled = false
    loadApi().then((YT) => {
      if (cancelled || !hostRef.current) return
      // The API replaces its target node with the iframe, so hand it a node React does not own.
      const target = hostRef.current.appendChild(document.createElement('div'))
      playerRef.current = new YT.Player(target, {
        videoId,
        host: 'https://www.youtube-nocookie.com',
        width: '100%',
        height: '100%',
        playerVars: {
          start,
          autoplay: start ? 1 : 0,
          hl: 'ar',
          rel: 0,
          playsinline: 1,
          origin: location.origin,
        },
        events: {
          onReady: (e: { target: YTPlayer }) => {
            e.target.getIframe().title = title
          },
          onStateChange: (e: { data: number }) => setPlaying(e.data === YT.PlayerState.PLAYING),
          onError: (e: { data: number }) => {
            if (EMBED_ERRORS.has(e.data)) setBlocked(true)
          },
        },
      })
    })

    return () => {
      cancelled = true
      try {
        playerRef.current?.destroy()
      } catch {}
      playerRef.current = null
    }
  }, [videoId, segments, title])

  // Follow playback: 500 ms is well under the ~9 s segment length.
  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => {
      const t = playerRef.current?.getCurrentTime()
      if (typeof t !== 'number') return
      timeRef.current = t
      const i = indexAt(segments, t)
      setActive((prev) => (prev === i ? prev : i))
    }, 500)
    return () => clearInterval(id)
  }, [playing, segments])

  useEffect(() => {
    if (!follow || active < 0) return
    const list = listRef.current
    const row = list?.querySelector<HTMLElement>(`[data-seg="${active}"]`)
    if (!list || !row) return
    list.scrollTo({
      top: row.offsetTop - list.clientHeight / 2 + row.clientHeight / 2,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    })
  }, [active, follow])

  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const flash = useCallback((message: string) => {
    setToast(message)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2000)
  }, [])

  const seek = useCallback(
    (index: number) => {
      const { s } = segments[index]
      timeRef.current = s
      setActive(index)
      playerRef.current?.seekTo(s, true)
      playerRef.current?.playVideo()
      history.replaceState(null, '', `?t=${Math.floor(s)}`)
    },
    [segments],
  )

  const copy = useCallback(
    async (index: number) => {
      const url = `${location.origin}/v/${videoId}?t=${Math.floor(segments[index].s)}`
      try {
        await navigator.clipboard.writeText(url)
        flash('تم النسخ')
      } catch {
        flash('تعذّر النسخ')
      }
    },
    [flash, segments, videoId],
  )

  const folded = useMemo(() => segments.map((seg) => normalize(seg.t)), [segments])

  const rows = useMemo(() => {
    const nq = normalize(query)
    if (!nq) return segments.map((seg, i) => ({ i, seg, html: '' }))
    const matched: { i: number; seg: Segment; html: string }[] = []
    for (let i = 0; i < segments.length; i++) {
      if (folded[i].includes(nq)) matched.push({ i, seg: segments[i], html: markMatches(segments[i].t, nq) })
    }
    return matched
  }, [folded, query, segments])

  useEffect(() => {
    const id = setTimeout(
      () => setAnnounced(query.trim() ? (rows.length ? `النتائج: ${rows.length}` : 'لا نتائج') : ''),
      600,
    )
    return () => clearTimeout(id)
  }, [query, rows.length])

  return (
    <div className="mt-6 grid items-start gap-6 lg:grid-cols-2 lg:gap-8">
      <div className="sticky top-14 z-10 -mx-4 bg-bg px-4 pb-3 pt-2 lg:top-20 lg:mx-0 lg:px-0 lg:pt-0">
        <div
          ref={hostRef}
          className={
            blocked
              ? 'hidden'
              : 'aspect-video w-full overflow-hidden rounded-xl bg-surface-2 [&>iframe]:size-full'
          }
        />
        {blocked && (
          <div className="card flex aspect-video w-full flex-col items-center justify-center gap-4 p-6 text-center">
            <p className="text-muted">تعذّر تشغيل الفيديو هنا، شاهده على يوتيوب</p>
            <a
              href={youtubeUrl(videoId, timeRef.current)}
              rel="noopener"
              className="inline-flex min-h-11 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg"
            >
              افتح في يوتيوب
            </a>
          </div>
        )}
      </div>

      <section aria-label="التفريغ" className="min-w-0">
        <div className="-mx-2 flex flex-wrap items-center gap-x-4 gap-y-2 bg-bg px-2 py-2 lg:sticky lg:top-14 lg:z-20">
          <input
            type="search"
            data-search-input=""
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث داخل الفيديو"
            aria-label="ابحث داخل الفيديو"
            className="h-11 min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-3 text-sm placeholder:text-muted"
          />
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => setFollow(e.target.checked)}
              className="size-4 accent-accent"
            />
            متابعة تلقائية
          </label>
        </div>

        <p className="min-h-6 pt-1 text-sm text-muted">
          {query.trim() &&
            (rows.length ? (
              <>
                النتائج: <span className="digits">{rows.length}</span>
              </>
            ) : (
              'لا نتائج'
            ))}
        </p>
        <span aria-live="polite" className="sr-only">
          {announced}
        </span>

        <a
          href="#after-transcript"
          className="sr-only focus:not-sr-only focus:mb-2 focus:inline-flex focus:h-11 focus:items-center focus:rounded-lg focus:bg-accent focus:px-4 focus:text-accent-fg"
        >
          تخطَّ التفريغ
        </a>

        <ol
          ref={listRef}
          className="relative mt-1 h-[55dvh] overflow-y-auto overscroll-contain rounded-lg lg:h-[calc(100dvh-10rem)] lg:pe-1"
        >
          {rows.map(({ i, seg, html }) => (
            <Row
              key={i}
              index={i}
              seg={seg}
              html={html}
              active={i === active}
              onSeek={seek}
              onCopy={copy}
            />
          ))}
        </ol>
        <div id="after-transcript" tabIndex={-1} className="outline-none" />
      </section>

      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center"
      >
        {toast && <span className="card px-4 py-2 text-sm shadow-lg">{toast}</span>}
      </div>
    </div>
  )
}

type RowProps = {
  index: number
  seg: Segment
  html: string
  active: boolean
  onSeek: (index: number) => void
  onCopy: (index: number) => void
}

const Row = memo(function Row({ index, seg, html, active, onSeek, onCopy }: RowProps) {
  return (
    <li
      data-seg={index}
      onClick={() => {
        // Let the reader select transcript text without jumping the player.
        if (!getSelection()?.toString()) onSeek(index)
      }}
      className={`group flex scroll-mt-72 cursor-pointer items-start gap-2 rounded-lg border-s-2 pe-1 ps-2 transition-colors lg:scroll-mt-28 ${
        active ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-surface-2'
      }`}
    >
      <button
        type="button"
        aria-label={`تشغيل من ${timestamp(seg.s)}`}
        onClick={(e) => {
          e.stopPropagation()
          onSeek(index)
        }}
        className="inline-flex min-h-11 shrink-0 items-center rounded-md px-1.5 text-xs text-muted transition-colors group-hover:text-accent"
      >
        <span className="digits">{timestamp(seg.s)}</span>
      </button>

      {html ? (
        <p
          className="prose-naskh min-w-0 flex-1 py-2"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <p className="prose-naskh min-w-0 flex-1 py-2">{seg.t}</p>
      )}

      <button
        type="button"
        aria-label={`نسخ الرابط عند ${timestamp(seg.s)}`}
        onClick={(e) => {
          e.stopPropagation()
          onCopy(index)
        }}
        className="mt-1 grid size-11 shrink-0 place-items-center rounded-md text-muted opacity-0 transition-opacity hover:text-fg no-hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="size-4"
        >
          <path d="M10.5 13.5a4.5 4.5 0 0 0 6.6.3l2.4-2.4a4.5 4.5 0 0 0-6.4-6.4l-1.4 1.4" />
          <path d="M13.5 10.5a4.5 4.5 0 0 0-6.6-.3l-2.4 2.4a4.5 4.5 0 0 0 6.4 6.4l1.4-1.4" />
        </svg>
      </button>
    </li>
  )
})
