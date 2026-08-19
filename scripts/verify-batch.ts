/**
 * `npx tsx --env-file-if-exists=.env scripts/verify-batch.ts` — do RAW_DIR, data/ and
 * Meilisearch still agree? One PASS/FAIL line per check, non-zero exit if any FAIL.
 * RAW_DIR moves under us while a tafrigh run is going, so a raw/data gap is reported as a
 * labelled delta (which side is ahead, and what to re-run) rather than as corruption.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const RAW = (process.env.RAW_DIR ?? '').replace(/^~/, homedir())
const HOST = process.env.MEILI_HOST ?? 'http://127.0.0.1:7700'
const DATA = new URL('../data/', import.meta.url).pathname
if (!RAW) throw new Error('RAW_DIR is not set (see .env.example)')

let failed = 0
/** `notes` are problems: any truthy entry turns the line into a FAIL. */
const check = (n: number, head: string, notes: unknown[], ok: string) => {
  const bad = notes.filter(Boolean)
  if (bad.length) failed++
  console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${n}. ${head}; ${bad.join('; ') || ok}`)
}
const few = (ids: string[], n = 5) =>
  ids.slice(0, n).join(', ') + (ids.length > n ? ` +${ids.length - n} more` : '')
const json = (f: string) => readFile(join(DATA, f), 'utf8').then(JSON.parse)
const meili = (path: string, body?: unknown) =>
  fetch(HOST + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${process.env.MEILI_ADMIN_KEY ?? ''}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
    .then((r) => r.json())
    .catch((e: Error) => ({ error: e.message }))

type Video = { id: string; duration: number; playlists: { id: string }[] }
type Seg = { s: number; e: number; t: string }

const rawFiles = await readdir(RAW)
const videos: Video[] = await json('videos.json')
const playlists: { id: string; videoIds: string[] }[] = await json('playlists.json')
const videoIds = new Set(videos.map((v) => v.id))

// 1 — RAW_DIR *.transcript.json <-> videos.json <-> data/segments/<id>.json
const raw = new Set(rawFiles.filter((f) => f.endsWith('.transcript.json')).map((f) => f.slice(0, -16)))
const segFiles = new Set((await readdir(join(DATA, 'segments'))).map((f) => f.slice(0, -5)))
const rawAhead = [...raw].filter((id) => !videoIds.has(id))
const dataAhead = [...videoIds].filter((id) => !raw.has(id))
const noSeg = [...videoIds].filter((id) => !segFiles.has(id))
const straySeg = [...segFiles].filter((id) => !videoIds.has(id))
check(1, `raw/data/segments — ${raw.size} transcripts, ${videos.length} videos, ${segFiles.size} segment files`, [
  rawAhead.length && `RAW ahead by ${rawAhead.length}: ${few(rawAhead)} (run \`pnpm data\`)`,
  dataAhead.length && `data ahead by ${dataAhead.length}, transcript gone: ${few(dataAhead)}`,
  noSeg.length && `video with no segments file: ${few(noSeg)}`,
  straySeg.length && `segments file with no video: ${few(straySeg)}`,
], 'in sync both ways')

// 2 — referential integrity between videos.json and playlists.json
const playlistIds = new Set(playlists.map((p) => p.id))
const members = [...new Set(playlists.flatMap((p) => p.videoIds))].filter((id) => !videoIds.has(id))
const refs = [...new Set(videos.flatMap((v) => v.playlists.map((p) => p.id)))].filter((id) => !playlistIds.has(id))
check(2, `refs — ${playlists.length} playlists, ${videos.length} videos`, [
  videos.length - videoIds.size && `${videos.length - videoIds.size} duplicate video ids`,
  playlists.length - playlistIds.size && `${playlists.length - playlistIds.size} duplicate playlist ids`,
  members.length && `playlist member missing from videos.json: ${few(members)}`,
  refs.length && `video cites unknown playlist: ${few(refs)}`,
], 'no dupes, every id resolves')

// 3 — segment sanity across every video. First problem per segment only, so the counts are
// "segments with this as their worst issue", not independent tallies.
// ponytail: YouTube caption tracks run up to ~2.4s past the duration yt-dlp reports, always on the
// final segment. Faithful to source, harmless in the player — 3s slack keeps the check meaningful.
const SLACK = 3
const bad = { negative: 0, reversed: 0, pastEnd: 0, dupPair: 0, emptyText: 0 }
const worst: string[] = []
for (const v of videos) {
  const segs: Seg[] = await json(`segments/${v.id}.json`).catch(() => [])
  segs.forEach((s, i) => {
    const hit =
      (s.s < 0 && (bad.negative++, `start ${s.s}`)) ||
      (s.e < s.s && (bad.reversed++, `end ${s.e} < start ${s.s}`)) ||
      (s.e > v.duration + SLACK && (bad.pastEnd++, `end ${s.e} > duration ${v.duration}+${SLACK}`)) ||
      (!s.t?.trim() && (bad.emptyText++, 'empty text')) ||
      (i > 0 && segs[i - 1].s === s.s && segs[i - 1].e === s.e && (bad.dupPair++, `dup (${s.s},${s.e})`))
    if (hit && worst.length < 3) worst.push(`${v.id} #${i} ${hit}`)
  })
}
const badTotal = Object.values(bad).reduce((a, b) => a + b, 0)
check(3, `segments — ${videos.length} videos scanned, ${JSON.stringify(bad)}`,
  [badTotal && `${badTotal} bad segments, e.g. ${worst.join(' | ')}`], 'all timings sane')

// 4 — meili `cues` vs the ndjson line count, and every cue's video_id resolving
const chunkFiles = rawFiles.filter((f) => f.endsWith('.chunks.ndjson'))
let ndjson = 0
for (const f of chunkFiles) ndjson += (await readFile(join(RAW, f), 'utf8')).split('\n').filter(Boolean).length
const stats = await meili('/stats')
const cues = stats.indexes?.cues?.numberOfDocuments ?? -1
// exhaustive, not sampled: one filter naming every known id, so any hit at all is a dangling cue
const orphans = await meili('/indexes/cues/search', {
  q: '',
  hitsPerPage: 3,
  filter: `NOT video_id IN [${[...videoIds].map((i) => JSON.stringify(i)).join(',')}]`,
})
check(4, `cues — meili ${cues} docs vs ${ndjson} ndjson lines in ${chunkFiles.length} files, all ${cues} docs checked for a dangling video_id`, [
  stats.error && `meili unreachable: ${stats.error}`,
  cues !== ndjson && `${cues < ndjson ? 'RAW' : 'meili'} ahead by ${Math.abs(ndjson - cues)} (run \`pnpm index cues\`)`,
  orphans.totalHits && `${orphans.totalHits} cues cite an unknown videoId: ${few(orphans.hits.map((h: { id: string }) => h.id))}`,
], 'counts match, no dangling video_id')

// 5 — meili `articles` vs the paragraph count under data/articles/
const articleFiles = (await readdir(join(DATA, 'articles'))).filter((f) => f.endsWith('.json'))
let paragraphs = 0
for (const f of articleFiles) paragraphs += (await json(`articles/${f}`)).paragraphs.length
const articles = stats.indexes?.articles?.numberOfDocuments ?? -1
check(5, `articles — meili ${articles} docs vs ${paragraphs} paragraphs in ${articleFiles.length} files`,
  [articles !== paragraphs && `off by ${Math.abs(paragraphs - articles)} (run \`pnpm index articles\`)`], 'counts match')

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
