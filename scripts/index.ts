/**
 * RAW_DIR/*.chunks.ndjson -> `cues`, data/articles/*.json -> `articles`, plus the browser's
 * search-only key. Same ids overwrite, so re-running after new videos/articles is incremental.
 * `pnpm index cues` / `pnpm index articles` does one side only — the cue pass is the slow one.
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
if (!apiKey) throw new Error('MEILI_ADMIN_KEY must be set (see .env.example)')
// The article pass reads data/, so it runs fine on a box that has no tafrigh output.
if (!RAW_DIR && ONLY !== 'articles') throw new Error('RAW_DIR must be set (see .env.example)')
const client = new Meilisearch({ host, apiKey })
const settings = JSON.parse(
  await readFile(new URL('../meilisearch-settings.json', import.meta.url), 'utf8'),
)

// Not on an articles-only run: the cue settings would go up without the synonyms this run
// never computes, and there is no reason to touch a live `cues` index to index articles.
if (ONLY !== 'articles') {
  await client.createIndex('cues', { primaryKey: 'id' }).catch(() => {})
  await client
    .index('cues')
    .updateSettings(settings)
    // a settings change that forces a re-index takes minutes; the client default is 5s
    .then((t) => client.tasks.waitForTask(t.taskUid, { timeout: 300_000 }))
}

const files = ONLY === 'articles' ? [] : (await readdir(RAW_DIR)).filter((f) => f.endsWith('.chunks.ndjson'))
let sent = 0
const BATCH = 20_000

let batch: unknown[] = []
// every cue text, kept for the synonym pass below
const texts: string[] = []
// chunks that were nothing but sound tags: drop them, and delete any already indexed
const dropped: string[] = []
const flush = async () => {
  if (!batch.length) return
  const task = await client.index('cues').addDocuments(batch as Record<string, unknown>[])
  await client.tasks.waitForTask(task.taskUid, { timeout: 300_000 })
  sent += batch.length
  process.stdout.write(`\r${sent} cues indexed`)
  batch = []
}

for (const file of files) {
  const lines = (await readFile(join(RAW_DIR, file), 'utf8')).split('\n').filter(Boolean)
  for (const line of lines) {
    const cue = JSON.parse(line)
    cue.text = clean(cue.text ?? '')
    // Not searchable, not displayed, nothing reads it — but ~30% of the index on disk.
    delete cue.search_text
    if (cue.text) {
      batch.push(cue)
      texts.push(cue.text)
    } else dropped.push(cue.id)
  }
  if (batch.length >= BATCH) await flush()
}
await flush()

// charabia splits `ال` off but leaves `وال/بال/فال/كال/لل` whole — teach Meilisearch the
// equivalence. Settings-only, so it applies in well under a second with no re-index.
if (texts.length) {
  const synonyms = articleSynonyms(texts)
  const syn = await client.index('cues').updateSettings({ synonyms })
  await client.tasks.waitForTask(syn.taskUid, { timeout: 300_000 })
  console.log(`\n${Object.keys(synonyms).length} article synonyms`)
}

if (dropped.length) {
  const task = await client.index('cues').deleteDocuments(dropped)
  await client.tasks.waitForTask(task.taskUid, { timeout: 300_000 })
  console.log(`dropped ${dropped.length} empty cues`)
}

// data/articles/<id>.json -> one doc per paragraph, so a hit points at `#p<n>`.
if (ONLY !== 'cues') {
  const ART = new URL('../data/articles/', import.meta.url).pathname
  const artSettings = JSON.parse(
    await readFile(new URL('../meilisearch-articles-settings.json', import.meta.url), 'utf8'),
  )
  await client.createIndex('articles', { primaryKey: 'id' }).catch(() => {})
  await client
    .index('articles')
    .updateSettings(artSettings)
    .then((t) => client.tasks.waitForTask(t.taskUid, { timeout: 300_000 }))

  let docs: Record<string, unknown>[] = []
  let sentDocs = 0
  const push = async (force = false) => {
    if (!docs.length || (!force && docs.length < BATCH)) return
    const task = await client.index('articles').addDocuments(docs)
    await client.tasks.waitForTask(task.taskUid, { timeout: 300_000 })
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
const SCOPE = ['cues', 'articles']
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

const stats = await client.index('cues').getStats()
const artStats = await client.index('articles').getStats().catch(() => ({ numberOfDocuments: 0 }))
console.log(`\ndone: ${stats.numberOfDocuments} cues, ${artStats.numberOfDocuments} article chunks`)
console.log(`PUBLIC_MEILI_HOST=${host}`)
console.log(`PUBLIC_MEILI_SEARCH_KEY=${key.key}`)
