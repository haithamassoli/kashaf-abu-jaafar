/**
 * `pnpm embed cues|articles` — compute the semantic vectors for an index here and PUT them in,
 * instead of letting Meilisearch call the embedder itself.
 *
 * Why: the search box is one ARM core, where Meilisearch embeds ~1 doc/s through its Ollama —
 * measured, and a full day for the 99k documents. This machine does 10–19/s. So the backfill
 * runs here and ships the vectors, marked
 * `regenerate: false` so Meilisearch keeps them instead of recomputing. The box still embeds the
 * *query* at search time, and any documents added later — a handful per ingest — on its own.
 * The embedder has to exist on the index *before* those vectors arrive; see `declare` below.
 *
 * Resumable: `--from=40000` picks up where an interrupted run stopped. `--out=<file>` writes the
 * documents instead of sending them and `--push=<file>` sends a file written earlier, so the
 * vectors are computed once here and uploaded to both the local index and the search box.
 */
import { createReadStream } from 'node:fs'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { gzipSync } from 'node:zlib'

const host = process.env.MEILI_HOST ?? 'http://127.0.0.1:7700'
const apiKey = process.env.MEILI_ADMIN_KEY
const ollama = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'
if (!apiKey) throw new Error('MEILI_ADMIN_KEY must be set (see .env.example)')
const uid = process.argv[2]
// `cues_next` is the same shape as `cues`; it exists only so an embedder can be declared while the
// index is still empty (see scripts/index.ts). Its embedder config is the one `cues` uses.
const base = (uid ?? '').replace(/_next$/, '')
if (base !== 'cues' && base !== 'articles') throw new Error('usage: pnpm embed cues|articles')
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)
const flag = (n: string, d: number) => Number(arg(n) ?? d)
const out = arg('out')
const push = arg('push')
const from = flag('from', 0)
/** One Ollama request per batch; 32 keeps the prompt under bge-m3's context on one GPU. */
const BATCH = flag('batch', 32)
/** One Meilisearch task per chunk — big enough that task overhead disappears, small enough to retry. */
const CHUNK = flag('chunk', 2000)

/**
 * meilisearch-embedder.json is the single source of truth for both halves: Meilisearch renders
 * `documentTemplate` for whatever it embeds itself, and this script renders the same string for
 * everything it embeds here, so a document added later cannot drift from the backfill. It lives
 * outside meilisearch-settings.json on purpose — `pnpm index` must never apply an embedder, or a
 * fresh box would answer by embedding the whole corpus on one core.
 */
const embedder = JSON.parse(
  await readFile(new URL('../meilisearch-embedder.json', import.meta.url), 'utf8'),
)[base] as { model: string; documentTemplate: string; documentTemplateMaxBytes: number }
const MODEL = embedder.model
const MAX_BYTES = embedder.documentTemplateMaxBytes
/** The Liquid subset the template actually uses: `{{doc.<field>}}` inside literal text. */
const render = (d: Record<string, string>) =>
  embedder.documentTemplate.replace(/\{\{\s*doc\.(\w+)\s*\}\}/g, (_, k: string) => d[k] ?? '')
const clip = (s: string) => {
  const b = Buffer.from(s, 'utf8')
  return b.length <= MAX_BYTES ? s : b.subarray(0, MAX_BYTES).toString('utf8').replace(/�$/, '')
}

const meili = (path: string, init: RequestInit = {}) =>
  fetch(host + path, { ...init, headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) } })

const idle = async () => {
  for (;;) {
    const { total } = await meili('/tasks?statuses=processing,enqueued&limit=1').then((r) => r.json())
    if (!total) return
    await new Promise((r) => setTimeout(r, 2000))
  }
}

async function embed(texts: string[]): Promise<number[][]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${ollama}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, input: texts }),
      })
      if (!r.ok) throw new Error(`ollama ${r.status}`)
      return (await r.json()).embeddings
    } catch (e) {
      if (attempt === 3) throw e
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
}

const send = async (lines: string[]) => {
  const body = gzipSync(Buffer.from(lines.join('\n'), 'utf8'))
  const res = await meili(`/indexes/${uid}/documents`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/x-ndjson', 'Content-Encoding': 'gzip' },
    body,
  })
  if (!res.ok) throw new Error(`meilisearch ${res.status}: ${await res.text()}`)
  return body.length
}

/**
 * Declaring costs a second and embeds nothing *only* when every document already carries
 * `_vectors` with `regenerate: false`. Two ways that stops being true, both measured on
 * 2026-08-22 against a 100k `cues`:
 *  - the index has documents and no embedder yet -> declaring enqueues an embed of all of them,
 *    which on the box dies with `could not reach embedding server: timeout: global`;
 *  - `_vectors` sent for an embedder that is not declared yet are dropped on the floor, so a
 *    push-then-declare run reports `0 embeddings` over a full index and looks like it worked.
 * So the order is: declare on an EMPTY index (`CUES_INDEX=cues_next`), push vectors, add text,
 * swap. This call stays last because by then it is the no-op it claims to be.
 */
const declare = async () => {
  const res = await meili(`/indexes/${uid}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embedders: { default: embedder } }),
  })
  if (!res.ok) throw new Error(`meilisearch ${res.status}: ${await res.text()}`)
  await idle()
  const stats = await meili(`/indexes/${uid}/stats`).then((r) => r.json())
  console.log(`embedder declared: ${stats.numberOfEmbeddings} embeddings over ${stats.numberOfDocuments} documents`)
}

// `--push`: the documents were written by an earlier `--out` run, so this is upload only.
if (push) {
  const started = Date.now()
  let lines: string[] = []
  let n = 0
  let bytes = 0
  for await (const line of createInterface({ input: createReadStream(push), crlfDelay: Infinity })) {
    if (!line) continue
    lines.push(line)
    if (lines.length < CHUNK) continue
    bytes += await send(lines)
    n += lines.length
    lines = []
    console.log(`${n} sent  ${(bytes / 1e6).toFixed(0)} MB  ${(bytes / ((Date.now() - started) / 1000) / 1e6).toFixed(2)} MB/s`)
    if ((n / CHUNK) % 5 === 0) await idle()
  }
  if (lines.length) { bytes += await send(lines); n += lines.length }
  await idle()
  await declare()
  console.log(`done: ${n} documents, ${(bytes / 1e6).toFixed(0)} MB in ${((Date.now() - started) / 60_000).toFixed(1)} min`)
  process.exit(0)
}

const fields = base === 'cues' ? 'id,text' : 'id,title,text'
let docs: Record<string, string>[] = []
for (let offset = 0; ; offset += 10_000) {
  const r = await meili(`/indexes/${uid}/documents?limit=10000&offset=${offset}&fields=${fields}`).then((x) => x.json())
  docs.push(...r.results)
  if (r.results.length < 10_000) break
}

/**
 * `--skip=<file>`: the ids an earlier `--out` run already wrote. An ingest that doubles the
 * corpus otherwise re-embeds everything that was already frozen — an hour of GPU for vectors
 * that exist. `cat` the two output files before `--push`; the merge is by id either way.
 */
if (arg('skip')) {
  const done = new Set<string>()
  for await (const line of createInterface({ input: createReadStream(arg('skip') as string), crlfDelay: Infinity }))
    if (line) done.add(JSON.parse(line).id)
  const before = docs.length
  docs = docs.filter((d) => !done.has(d.id))
  console.log(`--skip: ${before - docs.length} of ${before} already embedded`)
}
console.log(`${docs.length} documents in ${uid}${from ? `, resuming at ${from}` : ''}`)

const started = Date.now()
let bytes = 0
for (let a = from; a < docs.length; a += CHUNK) {
  // Sorted by length, because llama.cpp pads a batch to its longest sequence: article
  // paragraphs run from 200 bytes to 12k, and one long one in a batch of 32 was costing ~4x.
  // Sorting inside the chunk keeps `--from` meaning the same thing it did before.
  const slice = docs
    .slice(a, a + CHUNK)
    .map((d) => ({ d, text: clip(render(d)) }))
    .sort((x, y) => x.text.length - y.text.length)
  const lines: string[] = []
  for (let i = 0; i < slice.length; i += BATCH) {
    const part = slice.slice(i, i + BATCH).map((x) => x.d)
    const vectors = await embed(slice.slice(i, i + BATCH).map((x) => x.text))
    part.forEach((d, k) => {
      // 5 significant digits is lossless against the fp16 the vectors are stored as, and a
      // third off the wire — this body crosses the public internet 50 times.
      const v = vectors[k].map((x) => Number(x.toPrecision(5)))
      lines.push(JSON.stringify({ id: d.id, _vectors: { default: { embeddings: v, regenerate: false } } }))
    })
  }
  if (out) {
    // truncate only on a fresh run; `--from=N --out=…` is a resume and must keep what is there
    if (a === from && !from) await writeFile(out, '')
    await appendFile(out, lines.join('\n') + '\n')
    bytes += Buffer.byteLength(lines.join('\n'))
  } else {
    bytes += await send(lines)
  }
  const done = Math.min(a + CHUNK, docs.length)
  const min = (Date.now() - started) / 60_000
  console.log(
    `${done}/${docs.length}  ${(bytes / 1e6).toFixed(0)} MB  ` +
      `${((done - from) / min / 60).toFixed(1)}/s  eta ${((docs.length - done) / ((done - from) / min)).toFixed(0)}m`,
  )
  // Meilisearch queues the whole backfill otherwise, and a 62k-document queue is a rough restart.
  if (!out && done % (CHUNK * 5) === 0) await idle()
}
if (!out) {
  await idle()
  await declare()
}
console.log(`done: ${docs.length - from} documents, ${(bytes / 1e6).toFixed(0)} MB in ${((Date.now() - started) / 60_000).toFixed(1)} min`)
