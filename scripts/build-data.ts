/**
 * RAW_DIR/*.transcript.json  ->  data/{videos,playlists}.json + data/segments/<id>.json
 * Everything the static build needs lives under data/ afterwards, so `astro build`
 * never touches the tafrigh output dir.
 */
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { clean } from '../src/lib/clean.ts'

const RAW_DIR = (process.env.RAW_DIR ?? '').replace(/^~/, homedir())
if (!RAW_DIR) throw new Error('RAW_DIR is not set (see .env.example)')

const DATA = new URL('../data/', import.meta.url).pathname

type Segment = { text: string; start: number; end: number }
type Transcript = {
  video: {
    id: string
    title: string
    channel: string
    duration: number
    upload_date: string | null
    playlists: { id: string; title: string; index: number }[]
    description?: string
  }
  transcription: { source: string; language: string; generated?: boolean }
  segments: Segment[]
}

export type Video = {
  id: string
  title: string
  duration: number
  uploadDate: string | null
  channel: string
  playlists: { id: string; title: string; index: number }[]
  source: string
  segmentCount: number
}

export type Playlist = { id: string; title: string; videoIds: string[] }

const round = (n: number) => Math.round(n * 100) / 100

// A channel playlist whose lessons already sit, whole, in a bigger playlist of the same name:
// two identical labels in the filter, one of them a two-lesson stub. Dropped on read so a
// re-crawl cannot bring it back. ponytail: a Set beats a rule until there is a second reason.
const SKIP_PLAYLISTS = new Set(['PLkLIIYo0Lm4vw09hsdQuT3BWDdUmEGBtJ'])

async function main() {
  const files = (await readdir(RAW_DIR)).filter((f) => f.endsWith('.transcript.json'))
  if (files.length === 0) throw new Error(`no *.transcript.json in ${RAW_DIR}`)

  await rm(join(DATA, 'segments'), { recursive: true, force: true })
  await mkdir(join(DATA, 'segments'), { recursive: true })

  const videos: Video[] = []
  const playlists = new Map<string, { title: string; entries: { id: string; index: number }[] }>()

  for (const file of files) {
    const t: Transcript = JSON.parse(await readFile(join(RAW_DIR, file), 'utf8'))
    const v = t.video
    // Empty transcripts happen when both YouTube captions and wit.ai come back blank.
    const segments = (t.segments ?? [])
      .map((s) => ({ ...s, text: clean(s.text ?? '') }))
      .filter((s) => s.text)
    if (segments.length === 0) continue

    const inPlaylists = (v.playlists ?? []).filter((p) => !SKIP_PLAYLISTS.has(p.id))

    videos.push({
      id: v.id,
      title: v.title,
      duration: v.duration,
      uploadDate: v.upload_date,
      channel: v.channel,
      playlists: inPlaylists,
      source: t.transcription?.source ?? 'unknown',
      segmentCount: segments.length,
    })

    for (const p of inPlaylists) {
      const bucket = playlists.get(p.id) ?? { title: p.title, entries: [] }
      bucket.entries.push({ id: v.id, index: p.index })
      playlists.set(p.id, bucket)
    }

    await writeFile(
      join(DATA, 'segments', `${v.id}.json`),
      JSON.stringify(segments.map((s) => ({ s: round(s.start), e: round(s.end), t: s.text }))),
    )
  }

  videos.sort((a, b) => a.title.localeCompare(b.title, 'ar'))

  const playlistList: Playlist[] = [...playlists.entries()]
    .map(([id, { title, entries }]) => ({
      id,
      title,
      videoIds: entries.sort((a, b) => a.index - b.index).map((e) => e.id),
    }))
    // ties are common and readdir order is not stable, so name breaks them or the combobox,
    // the /p list and the JSON-LD positions all reshuffle between rebuilds
    .sort((a, b) => b.videoIds.length - a.videoIds.length || a.title.localeCompare(b.title, 'ar'))

  await writeFile(join(DATA, 'videos.json'), JSON.stringify(videos, null, 0))
  await writeFile(join(DATA, 'playlists.json'), JSON.stringify(playlistList, null, 0))

  const hours = videos.reduce((n, v) => n + v.duration, 0) / 3600
  console.log(
    `${videos.length} videos (${hours.toFixed(1)} h) in ${playlistList.length} playlists -> data/`,
  )
}

main()
