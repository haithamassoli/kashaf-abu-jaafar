/**
 * `pnpm eval` — the fixed question set in data/eval-questions.json against the live
 * Meilisearch. Search quality is the whole point of this site and nothing else measures it,
 * so every relevance change should be run through this before and after.
 * `--strategy=all|last|frequency`, `--index=cues,articles,lessons`, and `pnpm -s eval --json`
 * (pnpm's banner is on stdout, so `-s` is what makes the JSON pipeable) to diff two runs.
 *
 * `--ladder` is the one that matters: per-index numbers say how each index behaves, but the
 * reader meets the escalation in src/lib/meili.ts — strict pass, then the lesson block, then a
 * labelled widened retry. It calls the real `search()`, not a copy, so the two cannot drift.
 */
import { readFile } from 'node:fs/promises'
import { Meilisearch, type MatchingStrategies } from 'meilisearch'
import { search, type ArticleHit, type Cue } from '../src/lib/meili.ts'

const host = process.env.MEILI_HOST ?? 'http://127.0.0.1:7700'
const apiKey = process.env.MEILI_ADMIN_KEY
if (!apiKey) throw new Error('MEILI_ADMIN_KEY must be set (see .env.example)')
const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const strategy = (flag('strategy') ?? 'all') as MatchingStrategies
const asJson = process.argv.includes('--json')

// a question the corpus can answer, and what a good answer looks like where we could verify it
type Question = {
  q: string
  expect?: 'none'
  expectVideo?: string
  expectVideos?: string[]
  /** The articles tab has its own targets: an article id, scored on the `a` tab's top 3. */
  expectArticle?: string
  note?: string
}
// `--file=data/eval-questions-2.json` runs a held-out set instead — same shape, same metrics.
const file = flag('file') ?? 'data/eval-questions.json'
const questions: Question[] = JSON.parse(
  await readFile(new URL(`../${file}`, import.meta.url), 'utf8'),
)
/** A question can have more than one lesson that genuinely answers it; any of them counts. */
const targets = (q: Question) => q.expectVideos ?? (q.expectVideo ? [q.expectVideo] : [])

/** A reader looks at the first few results; past that a hit did not really surface. */
const TOP = 3

// --- `--ladder`: what a reader actually ends up seeing, via the production search() ---
if (process.argv.includes('--ladder')) {
  type Outcome = 'direct' | 'lessons' | 'widened' | 'dead'
  const rows: { q: string; outcome: Outcome; n: number; answered: boolean | null }[] = []

  for (const question of questions) {
    const { q, expectArticle } = question
    const want = targets(question)
    const r = await search(q, expectArticle ? { tab: 'a' } : {})
    const shown = r.counts.v + r.counts.a
    const outcome: Outcome = r.widened ? 'widened' : shown ? 'direct' : r.lessons.length ? 'lessons' : 'dead'
    // What is actually on screen at the top of the page: the lesson block sits ABOVE the cue
    // list and both render together, so scoring only one of them understates what the reader
    // sees. Union of the lesson cards and the leading cue hits.
    const seen = expectArticle
      ? (r.hits as ArticleHit[]).slice(0, TOP).map((h) => h.articleId)
      : [
          ...r.lessons.slice(0, TOP).map((l) => l.video_id),
          ...(r.hits as Cue[]).slice(0, TOP).map((h) => h.video_id),
        ]
    rows.push({
      q,
      outcome,
      n: r.widened ? shown : shown || r.lessonsTotal,
      answered: expectArticle ? seen.includes(expectArticle) : want.length ? want.some((v) => seen.includes(v)) : null,
    })
  }

  const count = (o: Outcome) => rows.filter((r) => r.outcome === o).length
  const scored = rows.filter((r) => r.answered !== null)
  // For a question the corpus cannot answer, «dead» is the right answer and «widened» is the
  // honest near-miss; only presenting it as a direct hit is a real failure.
  const falseDirect = questions.filter((q, i) => q.expect === 'none' && rows[i].outcome === 'direct').length

  if (asJson) {
    console.log(JSON.stringify({ host, mode: 'ladder', rows, scored: scored.length }, null, 2))
  } else {
    const pct = (n: number) => `${Math.round((n / rows.length) * 100)}%`
    console.log(`\nladder (production search())  host=${host}  ${file}  ${rows.length} questions\n`)
    console.log(`   #   result       hits  answered  question`)
    rows.forEach((r, i) => {
      const a = r.answered === null ? '   -    ' : r.answered ? '   yes  ' : '   NO   '
      console.log(
        `${String(i + 1).padStart(4)}  ${r.outcome.padEnd(9)}${String(r.n).padStart(7)}${a}  ${r.q}`,
      )
    })
    console.log(
      `\ndead ${pct(count('dead')).padStart(4)} (${count('dead')})  ` +
        `direct ${pct(count('direct')).padStart(4)} (${count('direct')})  ` +
        `lesson-block ${pct(count('lessons')).padStart(4)} (${count('lessons')})  ` +
        `widened ${pct(count('widened')).padStart(4)} (${count('widened')})`,
    )
    console.log(
      `answer-in-top-3 ${scored.filter((r) => r.answered).length}/${scored.length}  ` +
        `expect-none shown as direct ${falseDirect}/${questions.filter((q) => q.expect === 'none').length}\n`,
    )
  }
  process.exit(0)
}

const client = new Meilisearch({ host, apiKey })
// `matchingStrategy: last` drops query words until something matches, which can return most of
// the corpus. Anything over this share is a flood, not a result set.
const FLOOD = 0.1

const wanted = flag('index')?.split(',') ?? ['cues', 'articles', 'lessons']
const indexes: { uid: string; docs: number; hasVideo: boolean }[] = []
for (const uid of wanted) {
  // `lessons` did not always exist and an --index typo should not look like a zero-hit corpus
  const stats = await client.index(uid).getStats().catch(() => null)
  if (stats) indexes.push({ uid, docs: stats.numberOfDocuments, hasVideo: 'video_id' in stats.fieldDistribution })
}
if (!indexes.length) throw new Error(`none of ${wanted.join(', ')} exist at ${host}`)

// per index, per question: how many hits, and whether the lesson that answers it made the top 3
const hits: Record<string, number[]> = {}
const top3: Record<string, (boolean | null)[]> = {}
for (const { uid, hasVideo } of indexes) {
  hits[uid] = []
  top3[uid] = []
  for (const question of questions) {
    const { q } = question
    const want = targets(question)
    const r = await client.index(uid).search(q, {
      locales: ['ara'],
      matchingStrategy: strategy,
      limit: TOP,
      attributesToRetrieve: ['video_id'],
    })
    hits[uid].push(r.estimatedTotalHits ?? r.hits.length)
    // articles carry no video_id, so the answer-in-top-3 metric does not apply there
    top3[uid].push(
      want.length && hasVideo ? r.hits.some((h) => want.includes(h.video_id as string)) : null,
    )
  }
}

const score = ({ uid, docs }: (typeof indexes)[number]) => {
  const h = hits[uid]
  const scored = top3[uid].filter((t) => t !== null)
  return {
    docs,
    zero: h.filter((n) => n === 0).length,
    thin: h.filter((n) => n < 5).length,
    flood: h.filter((n) => n > docs * FLOOD).length,
    top3: scored.filter(Boolean).length,
    top3Of: scored.length,
    noneViolations: questions.filter((q, i) => q.expect === 'none' && h[i] > 0).length,
    noneOf: questions.filter((q) => q.expect === 'none').length,
  }
}
const scores = Object.fromEntries(indexes.map((i) => [i.uid, score(i)]))

if (asJson) {
  console.log(JSON.stringify({ host, strategy, questions: questions.length, scores, hits, top3 }, null, 2))
} else {
  const pct = (n: number) => `${Math.round((n / questions.length) * 100)}%`
  const head = indexes.map((i) => i.uid.padStart(9)).join('')
  console.log(`\nstrategy=${strategy}  host=${host}  ${questions.length} questions\n`)
  // the question goes last so the terminal's RTL rendering cannot scramble the numbers
  console.log(`   #${head}  target              question`)
  questions.forEach((q, i) => {
    const counts = indexes.map(({ uid }) => String(hits[uid][i]).padStart(9)).join('')
    const found = indexes.filter(({ uid }) => top3[uid][i]).map((i) => i.uid)
    const flooded = indexes.filter(({ uid }) => hits[uid][i] > 0).map((i) => i.uid)
    const target = q.expect === 'none'
      ? flooded.length ? `want:0 MISS:${flooded.join(',')}` : 'want:0'
      : !targets(q).length ? '-'
      : found.length ? `top3:${found.join(',')}` : 'top3:none'
    console.log(`${String(i + 1).padStart(4)}${counts}  ${target.padEnd(18)}  ${q.q}`)
  })
  console.log()
  for (const { uid } of indexes) {
    const s = scores[uid]
    console.log(
      `${uid.padEnd(9)} ${String(s.docs).padStart(6)} docs  ` +
        `zero ${pct(s.zero).padStart(4)} (${s.zero})  thin ${pct(s.thin).padStart(4)} (${s.thin})  ` +
        `flood ${pct(s.flood).padStart(4)} (${s.flood})  answer-in-top-3 ${s.top3}/${s.top3Of}  ` +
        `expect-none violations ${s.noneViolations}/${s.noneOf}`,
    )
  }
  console.log()
}
