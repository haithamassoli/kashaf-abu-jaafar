/**
 * Blogger Atom feed -> data/articles/<id>.json
 * The mirror of alkulify.com that still answers, but it stops at 2019-06; scripts/wayback.ts
 * fills in the rest from archive.org. Re-running overwrites, so it doubles as the refresh.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { decode, paragraphs, titleKey } from '../src/lib/html.ts'

const FEED = 'http://alkulify.blogspot.com/feeds/posts/default'
const DIR = new URL('../data/articles/', import.meta.url).pathname

type Entry = {
  id: { $t: string }
  published: { $t: string }
  updated: { $t: string }
  title: { $t: string }
  content: { $t: string }
  link: { rel: string; href: string }[]
  category?: { term: string }[]
}

const today = new Date().toISOString().slice(0, 10)

await mkdir(DIR, { recursive: true })

// scripts/wayback.ts drops the Blogger copy of every post the site itself covers; without this
// check a later `pnpm articles` would write them all straight back and double the corpus.
const covered = new Set<string>()
for (const f of (await readdir(DIR)).filter((f) => f.endsWith('.json'))) {
  const a = JSON.parse(await readFile(DIR + f, 'utf8'))
  if (a.source === 'wp') covered.add(titleKey(a.title))
}

let start = 1
let count = 0
let skipped = 0
for (;;) {
  // Blogger caps a page by response size, not by max-results — advance by what actually came back.
  const res = await fetch(`${FEED}?alt=json&max-results=150&start-index=${start}`)
  if (!res.ok) throw new Error(`feed ${res.status} at start-index=${start}`)
  const entries: Entry[] = (await res.json()).feed.entry ?? []
  if (!entries.length) break

  for (const e of entries) {
    const postId = e.id.$t.split('.post-')[1]
    const published = e.published.$t.slice(0, 10)
    const modified = e.updated.$t.slice(0, 10)
    const title = decode(e.title.$t).replace(/\s+/g, ' ').trim()
    if (covered.has(titleKey(title))) {
      skipped++
      continue
    }
    await writeFile(
      `${DIR}post-${postId}.json`,
      JSON.stringify({
        id: `post-${postId}`,
        type: 'post',
        source: 'blogger',
        title,
        // One pinned post is dated 2222 to stay on top; fall back to its real edit date.
        date: published > today ? modified : published,
        modified,
        categories: (e.category ?? []).map((c) => c.term),
        url: e.link.find((l) => l.rel === 'alternate')!.href,
        paragraphs: paragraphs(e.content.$t),
      }),
    )
    count++
  }
  start += entries.length
  process.stdout.write(`\r${count} articles`)
}
console.log(`\ndone: ${count} articles in data/articles/${skipped ? `, ${skipped} already covered by wp` : ''}`)
