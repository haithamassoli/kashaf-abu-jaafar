/**
 * RAW_DIR/*.chunks.ndjson -> `cues` (one doc per chunk) and `lessons` (one doc per video,
 * the whole transcript), data/articles/*.json -> `articles`, plus the browser's search-only
 * key. Same ids overwrite, so re-running after new videos/articles is incremental.
 * `pnpm index cues|lessons|articles` runs one pass only — the cue pass is the slow one.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Meilisearch } from 'meilisearch'
import { clean } from '../src/lib/clean.ts'
import { articleSynonyms } from '../src/lib/normalize.ts'

const RAW_DIR = (process.env.RAW_DIR ?? '').replace(/^~/, homedir())
const host = process.env.MEILI_HOST ?? 'http://127.0.0.1:7700'
const apiKey = process.env.MEILI_ADMIN_KEY
const ONLY = process.argv[2]
const wants = (pass: string) => !ONLY || ONLY === pass
// `cues` and `lessons` are two shapes of the same transcripts, so they share one read of RAW_DIR
const readsRaw = wants('cues') || wants('lessons')
if (!apiKey) throw new Error('MEILI_ADMIN_KEY must be set (see .env.example)')
// The article pass reads data/, so it runs fine on a box that has no tafrigh output.
if (!RAW_DIR && readsRaw) throw new Error('RAW_DIR must be set (see .env.example)')
const client = new Meilisearch({ host, apiKey })
const settings = JSON.parse(
  await readFile(new URL('../meilisearch-settings.json', import.meta.url), 'utf8'),
)
const lessonSettings = JSON.parse(
  await readFile(new URL('../meilisearch-lessons-settings.json', import.meta.url), 'utf8'),
)

// The box indexes a 20k-cue batch in about five minutes and a 37k-article one in nine, so the
// client's 5s default — and even a 5-minute one — gives up on a task that then succeeds
// server-side, which reads as a failed publish. Wait it out instead.
const TASK_TIMEOUT = 1_800_000

// waitForTask resolves on *any* terminal status, so a batch the box refused — 40k cues died on an
// embedder timeout once — came back looking indexed and the run printed a total it never wrote.
const waitFor = async (taskUid: number) => {
  const t = await client.tasks.waitForTask(taskUid, { timeout: TASK_TIMEOUT })
  if (t.status !== 'succeeded') throw new Error(`task ${taskUid} ${t.status}: ${t.error?.message ?? ''}`)
}

const setup = async (uid: string, s: Record<string, unknown>) => {
  await client.createIndex(uid, { primaryKey: 'id' }).catch(() => {})
  const t = await client.index(uid).updateSettings(s)
  await waitFor(t.taskUid)
}

// Only for the pass that is running: settings would otherwise go up without the synonyms this
// run never computes, and there is no reason to touch a live index to build a different one.
if (wants('cues')) await setup('cues', settings)
if (wants('lessons')) await setup('lessons', lessonSettings)

const files = readsRaw ? (await readdir(RAW_DIR)).filter((f) => f.endsWith('.chunks.ndjson')) : []
// A video that shows up in a second playlist gets its transcript.json merged but its ndjson left
// alone, so playlist_ids there goes stale. data/videos.json is built from the transcripts, so it
// is the one that knows the full membership.
const playlistsOf = new Map(
  (JSON.parse(await readFile(new URL('../data/videos.json', import.meta.url), 'utf8')) as {
    id: string
    playlists: { id: string }[]
  }[]).map((v) => [v.id, v.playlists.map((p) => p.id)]),
)
let sent = 0
const BATCH = 20_000

let batch: unknown[] = []
// One doc per video, `text` = the whole transcript. `matchingStrategy: "all"` needs every query
// token inside ONE document and a 148-word cue rarely holds a whole question, so 10 of 25 real
// questions returned nothing (docs/SEARCH-PLAN.md). Accumulated in the cue pass so the corpus is
// read once; it also feeds the synonym scan below, which only cares about the set of words and
// joining cues with a space introduces none.
const lessons = new Map<string, { text: string; segment_count: number; [k: string]: unknown }>()
// chunks that were nothing but sound tags: drop them, and delete any already indexed
const dropped: string[] = []
const flush = async () => {
  if (!batch.length) return
  // updateDocuments, not addDocuments: a replace would drop the `_vectors` these cues already
  // carry (see scripts/embed.ts) and the search box would then re-embed 62k documents at a
  // quarter of a document a second. A merge keeps them; genuinely new cues arrive without
  // vectors and Meilisearch embeds those itself, which is a handful per ingest.
  const task = await client.index('cues').updateDocuments(batch as Record<string, unknown>[])
  await waitFor(task.taskUid)
  sent += batch.length
  process.stdout.write(`\r${sent} cues indexed`)
  batch = []
}

for (const file of files) {
  const lines = (await readFile(join(RAW_DIR, file), 'utf8')).split('\n').filter(Boolean)
  for (const line of lines) {
    const cue = JSON.parse(line)
    cue.text = clean(cue.text ?? '')
    cue.playlist_ids = playlistsOf.get(cue.video_id) ?? cue.playlist_ids
    // Not searchable, not displayed, nothing reads it — but ~30% of the index on disk.
    delete cue.search_text
    if (!cue.text) {
      dropped.push(cue.id)
      continue
    }
    if (wants('cues')) batch.push(cue)
    const lesson = lessons.get(cue.video_id)
    if (lesson) {
      lesson.text += ` ${cue.text}`
      lesson.segment_count++
    } else {
      const { video_id, title, playlist_ids, upload_date, duration, channel } = cue
      lessons.set(video_id, {
        id: video_id,
        video_id,
        title,
        text: cue.text,
        playlist_ids,
        upload_date,
        duration,
        channel,
        segment_count: 1,
      })
    }
  }
  if (batch.length >= BATCH) await flush()
}
await flush()

// ~9,000 words a document, so 1,584 at once would be an ~80 MB body against a 100 MB default
// payload limit. Chunk it.
if (wants('lessons') && lessons.size) {
  const docs = [...lessons.values()]
  for (let i = 0; i < docs.length; i += 200) {
    const task = await client.index('lessons').addDocuments(docs.slice(i, i + 200))
    await waitFor(task.taskUid)
  }
  console.log(`\n${docs.length} lessons indexed`)
}

// charabia splits `ال` off but leaves `وال/بال/فال/كال/لل` whole — teach Meilisearch the
// equivalence. Settings-only, so it applies in well under a second with no re-index.
if (lessons.size) {
  const synonyms = articleSynonyms([...lessons.values()].map((l) => l.text))
  // data/domain-synonyms.json maps what a user asks to what the sheikh says (الاغاني -> الغناء).
  // Built separately and optional: an absent file is not an error.
  const domain: Record<string, string[]> = await readFile(
    new URL('../data/domain-synonyms.json', import.meta.url),
    'utf8',
  )
    .then(JSON.parse)
    .catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') console.warn(`\ndomain-synonyms.json ignored: ${e.message}`)
      return {}
    })
  const link = (a: string, b: string) => {
    const list = (synonyms[a] ??= [])
    if (!list.includes(b)) list.push(b)
  }
  // Meilisearch synonyms are one-way, so register the reverse too.
  for (const [word, alts] of Object.entries(domain))
    for (const alt of alts) {
      link(word, alt)
      link(alt, word)
    }
  for (const uid of ['cues', 'lessons'].filter(wants)) {
    const syn = await client.index(uid).updateSettings({ synonyms })
    await waitFor(syn.taskUid)
  }
  console.log(`${Object.keys(synonyms).length} synonyms`)
}

if (dropped.length && wants('cues')) {
  const task = await client.index('cues').deleteDocuments(dropped)
  await waitFor(task.taskUid)
  console.log(`dropped ${dropped.length} empty cues`)
}

// data/articles/<id>.json -> one doc per paragraph, so a hit points at `#p<n>`.
if (wants('articles')) {
  const ART = new URL('../data/articles/', import.meta.url).pathname
  await setup(
    'articles',
    JSON.parse(
      await readFile(new URL('../meilisearch-articles-settings.json', import.meta.url), 'utf8'),
    ),
  )

  let docs: Record<string, unknown>[] = []
  let sentDocs = 0
  const push = async (force = false) => {
    if (!docs.length || (!force && docs.length < BATCH)) return
    const task = await client.index('articles').updateDocuments(docs)
    await waitFor(task.taskUid)
    sentDocs += docs.length
    process.stdout.write(`\r${sentDocs} article chunks indexed`)
    docs = []
  }
  const names = (await readdir(ART)).filter((f) => f.endsWith('.json'))
  for (const name of names) {
    const a = JSON.parse(await readFile(join(ART, name), 'utf8'))
    for (const [n, text] of (a.paragraphs as string[]).entries()) {
      docs.push({
        id: `${a.id}-p${n}`,
        articleId: a.id,
        type: a.type,
        source: a.source,
        title: a.title,
        categories: a.categories,
        date: a.date,
        n,
        text,
      })
    }
    await push()
  }
  await push(true)
  console.log(`\n${names.length} articles indexed`)
}

// Search-only key for the browser. Reuse the existing one so redeploys keep working.
const name = 'kashaf-search-only'
const SCOPE = ['cues', 'articles', 'lessons']
const keys = await client.getKeys({ limit: 100 })
const found = keys.results.find((k) => k.name === name)
// Meilisearch only lets you rename a key, so widening its index scope means recreating it.
// Reusing the uid keeps the key string itself (an HMAC of master key + uid) identical, so a
// already-deployed PUBLIC_MEILI_SEARCH_KEY keeps working.
const stale = found && !found.indexes.includes('*') && SCOPE.some((i) => !found.indexes.includes(i))
if (stale) {
  await client.deleteKey(found.uid)
  console.log(`re-scoped ${name} to ${SCOPE.join(', ')}`)
}
const key =
  (stale ? null : found) ??
  (await client.createKey({
    uid: found?.uid,
    name,
    description: 'browser search-only key',
    actions: ['search'],
    indexes: SCOPE,
    expiresAt: null,
  }))

const none = { numberOfDocuments: 0 }
const stats = await client.index('cues').getStats().catch(() => none)
const lessonStats = await client.index('lessons').getStats().catch(() => none)
const artStats = await client.index('articles').getStats().catch(() => none)
console.log(
  `\ndone: ${stats.numberOfDocuments} cues, ${lessonStats.numberOfDocuments} lessons, ` +
    `${artStats.numberOfDocuments} article chunks`,
)
console.log(`PUBLIC_MEILI_HOST=${host}`)
console.log(`PUBLIC_MEILI_SEARCH_KEY=${key.key}`)
