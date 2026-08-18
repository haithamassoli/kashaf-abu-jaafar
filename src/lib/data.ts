/** Build-time reads of the data/ snapshot produced by scripts/build-data.ts. */
import { readFileSync, existsSync } from 'node:fs'

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
export type Segment = { s: number; e: number; t: string }

const dir = new URL('../../data/', import.meta.url).pathname
const read = <T>(file: string, fallback: T): T =>
  existsSync(dir + file) ? (JSON.parse(readFileSync(dir + file, 'utf8')) as T) : fallback

export const videos: Video[] = read<Video[]>('videos.json', [])
export const playlists: Playlist[] = read<Playlist[]>('playlists.json', [])

export const videoById = new Map(videos.map((v) => [v.id, v]))
export const playlistById = new Map(playlists.map((p) => [p.id, p]))

export const segmentsOf = (id: string): Segment[] => read<Segment[]>(`segments/${id}.json`, [])

export const playlistDuration = (p: Playlist): number =>
  p.videoIds.reduce((n, id) => n + (videoById.get(id)?.duration ?? 0), 0)

export const totalHours = videos.reduce((n, v) => n + v.duration, 0) / 3600
