/**
 * RAW_DIR/*.chunks.ndjson -> Meilisearch `cues` index, plus the browser's search-only key.
 * Same chunk ids overwrite, so re-running after new videos is safe and incremental.
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
if (!RAW_DIR || !apiKey) throw new Error('RAW_DIR and MEILI_ADMIN_KEY must be set (see .env.example)')

const client = new Meilisearch({ host, apiKey })
const settings = JSON.parse(
  await readFile(new URL('../meilisearch-settings.json', import.meta.url), 'utf8'),
)

await client.createIndex('cues', { primaryKey: 'id' }).catch(() => {})
await client.index('cues').updateSettings(settings).then((t) => client.tasks.waitForTask(t.taskUid))

const files = (await readdir(RAW_DIR)).filter((f) => f.endsWith('.chunks.ndjson'))
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
const synonyms = articleSynonyms(texts)
const syn = await client.index('cues').updateSettings({ synonyms })
await client.tasks.waitForTask(syn.taskUid, { timeout: 300_000 })
console.log(`\n${Object.keys(synonyms).length} article synonyms`)

if (dropped.length) {
  const task = await client.index('cues').deleteDocuments(dropped)
  await client.tasks.waitForTask(task.taskUid, { timeout: 300_000 })
  console.log(`dropped ${dropped.length} empty cues`)
}

// Search-only key for the browser. Reuse the existing one so redeploys keep working.
const name = 'kashaf-search-only'
const keys = await client.getKeys({ limit: 100 })
const existing = keys.results.find((k) => k.name === name)
const key =
  existing ??
  (await client.createKey({
    name,
    description: 'browser search-only key',
    actions: ['search'],
    indexes: ['cues'],
    expiresAt: null,
  }))

const stats = await client.index('cues').getStats()
console.log(`\ndone: ${stats.numberOfDocuments} cues in ${files.length} files`)
console.log(`PUBLIC_MEILI_HOST=${host}`)
console.log(`PUBLIC_MEILI_SEARCH_KEY=${key.key}`)
