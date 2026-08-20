import { useEffect, useRef, useState } from 'react'
import { youtubeUrl } from '../lib/format'
import { flash } from '../lib/toast'
import { normalize } from '../lib/normalize'
import { markMatches } from '../lib/mark'

type Props = { videoId: string; title: string }

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
function indexAt(starts: number[], t: number): number {
  let lo = 0
  let hi = starts.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid] <= t) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/**
 * The transcript is server-rendered by Cues.astro and driven from here by hand, not
 * re-rendered by React. Handing ~1,400 cues to an island would serialize the whole
 * transcript into the page a second time as island props, and re-rendering that many
 * rows on every keystroke is work no one asked for.
 */
export default function Player({ videoId, title }: Props) {
  const [blocked, setBlocked] = useState(false)

  const hostRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<YTPlayer | null>(null)
  const timeRef = useRef(0)

  useEffect(() => {
    const list = document.getElementById('cues') as HTMLOListElement | null
    const search = document.querySelector<HTMLInputElement>('[data-search-input]')
    const followBox = document.querySelector<HTMLInputElement>('[data-follow]')
    const count = document.getElementById('cue-count')
    const status = document.getElementById('cue-status')
    if (!list) return

    const rows = Array.from(list.children) as HTMLLIElement[]
    const starts = rows.map((r) => Number(r.dataset.s))
    const texts = rows.map((r) => r.querySelector('p')!.textContent ?? '')
    const folded = texts.map(normalize)
    const marked = rows.map(() => false)

    let active = -1
    let savedScroll = 0
    let filtering = false
    let cancelled = false
    let poll: ReturnType<typeof setInterval> | undefined
    let announce: ReturnType<typeof setTimeout> | undefined

    const setActive = (i: number) => {
      if (i === active) return
      const prev = rows[active]
      if (prev) {
        prev.classList.remove('cue-on')
        prev.classList.add('cue-off')
      }
      active = i
      const row = rows[i]
      if (!row) return
      row.classList.remove('cue-off')
      row.classList.add('cue-on')
      if (!followBox?.checked || row.hidden) return
      list.scrollTo({
        top: row.offsetTop - list.clientHeight / 2 + row.clientHeight / 2,
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      })
    }

    const seek = (i: number) => {
      const s = starts[i]
      timeRef.current = s
      setActive(i)
      playerRef.current?.seekTo(s, true)
      playerRef.current?.playVideo()
      history.replaceState(null, '', `?t=${Math.floor(s)}`)
    }

    const copy = async (i: number) => {
      // trailingSlash is 'always', so the slash before the query keeps this off a 301.
      const url = `${location.origin}/v/${videoId}/?t=${Math.floor(starts[i])}`
      try {
        await navigator.clipboard.writeText(url)
        flash('تم النسخ')
      } catch {
        flash('تعذّر النسخ')
      }
    }

    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      const row = target.closest<HTMLLIElement>('li[data-seg]')
      if (!row) return
      const i = Number(row.dataset.seg)
      if (target.closest('.cue-copy')) return void copy(i)
      // Let the reader select transcript text without jumping the player.
      if (target.closest('.cue-ts') || !getSelection()?.toString()) seek(i)
    }

    const onFilter = () => {
      const nq = normalize(search?.value ?? '')
      // Capture before the loop: hiding rows collapses the list and clamps scrollTop.
      if (nq && !filtering) savedScroll = list.scrollTop
      let hits = 0
      for (let i = 0; i < rows.length; i++) {
        const hit = !nq || folded[i].includes(nq)
        if (rows[i].hidden === hit) rows[i].hidden = !hit
        const p = rows[i].firstElementChild!.nextElementSibling as HTMLParagraphElement
        if (!hit) {
          if (marked[i]) {
            p.textContent = texts[i]
            marked[i] = false
          }
          continue
        }
        hits++
        if (nq) {
          p.innerHTML = markMatches(texts[i], nq)
          marked[i] = true
        } else if (marked[i]) {
          p.textContent = texts[i]
          marked[i] = false
        }
      }
      // Results read from the top; emptying the box puts the reader back where they were.
      if (nq) list.scrollTop = 0
      else if (filtering) list.scrollTop = savedScroll
      filtering = !!nq

      const typed = (search?.value ?? '').trim()
      if (count) {
        count.innerHTML = !typed
          ? ''
          : hits
            ? `النتائج: <span class="digits">${hits}</span>`
            : 'لا نتائج'
      }
      clearTimeout(announce)
      announce = setTimeout(() => {
        if (status) status.textContent = !typed ? '' : hits ? `النتائج: ${hits}` : 'لا نتائج'
      }, 600)
    }

    // ponytail: 120 ms debounce. One keystroke rewrites up to ~1,400 rows, and a 1-char
    // Arabic query (`ا`) matches nearly all of them. Raise it if mobile still janks.
    let filterTimer: ReturnType<typeof setTimeout>
    const onInput = () => {
      clearTimeout(filterTimer)
      filterTimer = setTimeout(onFilter, 120)
    }

    list.addEventListener('click', onClick)
    search?.addEventListener('input', onInput)
    // The box is uncontrolled server-rendered HTML: browsers restore its value on reload,
    // and the reader can type into it before this island hydrates. Sync once either way.
    if (search?.value) onFilter()

    const start = Math.max(0, Math.floor(Number(new URLSearchParams(location.search).get('t')) || 0))
    timeRef.current = start
    setActive(indexAt(starts, start))

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
          onStateChange: (e: { data: number }) => {
            clearInterval(poll)
            if (e.data !== YT.PlayerState.PLAYING) return
            // Follow playback: 500 ms is well under the ~9 s segment length.
            poll = setInterval(() => {
              const t = playerRef.current?.getCurrentTime()
              if (typeof t !== 'number') return
              timeRef.current = t
              setActive(indexAt(starts, t))
            }, 500)
          },
          onError: (e: { data: number }) => {
            if (EMBED_ERRORS.has(e.data)) setBlocked(true)
          },
        },
      })
    })

    return () => {
      cancelled = true
      clearInterval(poll)
      clearTimeout(announce)
      clearTimeout(filterTimer)
      list.removeEventListener('click', onClick)
      search?.removeEventListener('input', onInput)
      try {
        playerRef.current?.destroy()
      } catch {}
      playerRef.current = null
    }
  }, [videoId, title])

  return (
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
  )
}
