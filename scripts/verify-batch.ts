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
/**
 * Caddy refuses more than 30 searches per 10 s from one IP (ops/Caddyfile) and checks 4 and 6
 * issue ~90 of them. A refusal arrives as valid JSON carrying no `totalHits`, which every check
 * below reads as «nothing wrong» — so it has to be waited out here, not swallowed as an answer.
 */
const meili = async (path: string, body?: unknown): Promise<Record<string, any>> => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(HOST + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${process.env.MEILI_ADMIN_KEY ?? ''}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).catch((e: Error) => e)
    if (res instanceof Error) return { error: res.message }
    if (res.status !== 429) return res.json().catch((e: Error) => ({ error: e.message }))
    if (attempt === 9) return { error: `rate limited on ${path} after ${attempt + 1} tries` }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

type Video = { id: string; duration: number; segmentCount: number; playlists: { id: string }[] }
type Seg = { s: number; e: number; t: string }

const rawFiles = await readdir(RAW)
const videos: Video[] = await json('videos.json')
const playlists: { id: string; title?: string; videoIds: string[] }[] = await json('playlists.json')
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
// the transcript panel renders one row per segment off segmentCount, so drift here is invisible
// in the data and wrong on every page
const miscount: string[] = []
for (const v of videos) {
  const segs: Seg[] = await json(`segments/${v.id}.json`).catch(() => [])
  if (segs.length !== v.segmentCount) miscount.push(`${v.id} ${segs.length}!=${v.segmentCount}`)
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
check(3, `segments — ${videos.length} videos scanned, ${JSON.stringify(bad)}`, [
  badTotal && `${badTotal} bad segments, e.g. ${worst.join(' | ')}`,
  miscount.length && `${miscount.length} videos whose segmentCount lies: ${few(miscount)}`,
], 'all timings sane, every segmentCount matches')

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
  orphans.error && `orphan scan never ran: ${orphans.error}`,
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

// 6 — a cue's playlist_ids vs the membership in playlists.json. tafrigh merges a re-crawled
// video's playlists into its transcript but not into its ndjson, so this is the one that catches
// a video that joined a second playlist after it was first transcribed.
const staleP: string[] = []
for (const p of playlists) {
  if (!p.videoIds.length) continue
  const r = await meili('/indexes/cues/search', {
    q: '',
    hitsPerPage: 1,
    filter: `video_id IN [${p.videoIds.map((i) => JSON.stringify(i)).join(',')}] AND NOT playlist_ids = ${JSON.stringify(p.id)}`,
  })
  if (r.error) staleP.push(`${p.title ?? p.id}: never checked — ${r.error}`)
  if (r.totalHits) staleP.push(`${p.title ?? p.id}: ${r.totalHits} cues from ${r.hits?.[0]?.video_id} and others omit it`)
  const extra = await meili('/indexes/cues/search', {
    q: '',
    hitsPerPage: 1,
    filter: `playlist_ids = ${JSON.stringify(p.id)} AND NOT video_id IN [${p.videoIds.map((i) => JSON.stringify(i)).join(',')}]`,
  })
  if (extra.error) staleP.push(`${p.title ?? p.id}: never checked — ${extra.error}`)
  if (extra.totalHits) staleP.push(`${p.title ?? p.id}: ${extra.totalHits} cues claim it but their video left`)
}
check(6, `playlist_ids — every cue of all ${videos.length} videos checked against its ${playlists.length} playlists`,
  [staleP.length && `${staleP.length} playlist(s) with cues that do not claim them — ${few(staleP, 2)} (run \`pnpm index cues\`)`],
  'cue membership matches playlists.json')

// 7 — every searchable document carries a vector. A cue with none is invisible to the semantic
// half and nothing says so: the ladder just quietly answers that query on keywords alone. It
// happens when a batch lands while the box's Ollama is down, or when a settings change resets
// the embedder. `pnpm embed <index>` recomputes and re-ships them.
const missing = (['cues', 'articles'] as const)
  .map((uid) => {
    const i = stats.indexes?.[uid]
    return { uid, docs: i?.numberOfDocuments ?? -1, embedded: i?.numberOfEmbeddedDocuments ?? -1 }
  })
  .filter((x) => x.docs !== x.embedded)
check(7, `vectors — every cue and article paragraph carries one`,
  [missing.length && missing.map((m) => `${m.uid}: ${m.docs - m.embedded} of ${m.docs} unembedded (run \`pnpm embed ${m.uid}\`)`).join('; ')],
  'all documents embedded')

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
