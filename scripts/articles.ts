/**
 * Blogger Atom feed -> data/articles/<id>.json
 * WordPress (alkulify.com) is still 522; the Blogger mirror is the live source (PRD §articles).
 * Re-running overwrites, so it doubles as the incremental refresh.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { decode, paragraphs } from '../src/lib/html.ts'

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
let start = 1
let count = 0
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
    await writeFile(
      `${DIR}post-${postId}.json`,
      JSON.stringify({
        id: `post-${postId}`,
        type: 'post',
        source: 'blogger',
        title: decode(e.title.$t).replace(/\s+/g, ' ').trim(),
        // One pinned post is dated 2222 to stay on top; fall back to its real edit date.
        date: published > today ? modified : published,
        modified,
        categories: (e.category ?? []).map((c) => c.term),
        url: e.link.find((l) => l.rel === 'alternate')!.href,
        paragraphs: paragraphs(e.content.$t),
      }),
    )
  }
  start += entries.length
  count += entries.length
  process.stdout.write(`\r${count} articles`)
}
console.log(`\ndone: ${count} articles in data/articles/`)
