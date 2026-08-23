/** Build-time reads of the data/ snapshot produced by scripts/build-data.ts. */
import { readFileSync, existsSync, readdirSync } from 'node:fs'

export type Video = {
  id: string
  title: string
  duration: number
  uploadDate: string | null
  playlists: { id: string; title: string; index: number }[]
  segmentCount: number
}

export type Playlist = { id: string; title: string; videoIds: string[] }
export type Segment = { s: number; e: number; t: string }

const dir = new URL('../../data/', import.meta.url).pathname
const read = <T>(file: string, fallback: T): T =>
  existsSync(dir + file) ? (JSON.parse(readFileSync(dir + file, 'utf8')) as T) : fallback

export const videos: Video[] = read<Video[]>('videos.json', [])
export const playlists: Playlist[] = read<Playlist[]>('playlists.json', [])

export const videoById = new Map(videos.map((v) => [v.id, v]))
export const playlistById = new Map(playlists.map((p) => [p.id, p]))

export const segmentsOf = (id: string): Segment[] => read<Segment[]>(`segments/${id}.json`, [])

export type Article = {
  id: string
  type: string
  source: string
  title: string
  date: string | null
  modified: string | null
  categories: string[]
  url: string
  /** Official PDF for book entries. */
  download?: string
  paragraphs: string[]
  /** Telegram posts only; `w`/`h` are the intrinsic pixels, so the box is reserved before load. */
  images?: { src: string; w: number; h: number }[]
}

const articleDir = `${dir}articles/`
const articleFiles = existsSync(articleDir)
  ? readdirSync(articleDir).filter((f) => f.endsWith('.json'))
  : []

export const articleCount = articleFiles.length

/** ~20 MB of text: a function, so only /a/[id] pays for it. */
export const allArticles = (): Article[] =>
  articleFiles.map((f) => JSON.parse(readFileSync(articleDir + f, 'utf8')) as Article)

/**
 * The order /p/[id] and the lesson prev/next both use: oldest first.
 * YouTube's own playlist index is only the tie-break — 9 of 43 playlists are not
 * chronological in it, and one 173-lesson series was uploaded on a single day.
 */
export const playlistVideos = (p: Playlist): Video[] => {
  const index = (v: Video) => v.playlists.find((x) => x.id === p.id)?.index ?? 0
  return p.videoIds
    .map((id) => videoById.get(id))
    .filter((v) => v !== undefined)
    .sort((a, b) => (a.uploadDate ?? '').localeCompare(b.uploadDate ?? '') || index(a) - index(b))
}

export const playlistDuration = (p: Playlist): number =>
  p.videoIds.reduce((n, id) => n + (videoById.get(id)?.duration ?? 0), 0)

export const totalHours = videos.reduce((n, v) => n + v.duration, 0) / 3600
