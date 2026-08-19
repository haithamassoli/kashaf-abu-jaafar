/**
 * Wayback snapshots of alkulify.com -> data/articles/<id>.json  (the origin has been 522 for months)
 * Resumable: pulled URLs are logged to data/wayback-done.txt, so a re-run only fills the gaps.
 * Finishes by dropping the Blogger copy of every post WordPress covers — WP has the real dates,
 * categories and canonical URLs (PRD §articles).
 */
import { appendFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { paragraphs, decode, titleKey } from '../src/lib/html.ts'

const CDX =
  'http://web.archive.org/cdx/search/cdx?url=alkulify.com&matchType=domain&output=json' +
  '&collapse=urlkey&filter=statuscode:200&filter=mimetype:text/html&fl=original,timestamp'
const DIR = new URL('../data/articles/', import.meta.url).pathname
const LOG = new URL('../data/wayback-done.txt', import.meta.url).pathname
const WORKERS = 4
// Everything else under / is an archive, feed or plugin route, not a post.
const NOT_A_POST = /^(tag|category|author|page|feed|wp-|xmlrpc|comments|\.well-known|fatawag|fatwa$|book$)|\.(xml|txt|ico|php|json)$/

type Post = { url: string; stamps: string[] }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function grab(url: string): Promise<string | null> {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(url, { redirect: 'follow' })
    if (res.ok) return res.text()
    if (res.status === 404) return null
    // Wayback throttles hard under load; back off rather than hammer a free archive.
    await sleep(Number(res.headers.get('retry-after') ?? 0) * 1000 || 3000 * (i + 1))
  }
  return null
}

/** collapse=urlkey hands back a single capture per URL; this asks for the rest of them. */
async function captures(url: string): Promise<string[]> {
  const q = `http://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&filter=statuscode:200&fl=timestamp&limit=10`
  const rows: string[][] = await fetch(q).then((r) => r.json()).catch(() => [])
  return rows.slice(1).map((r) => r[0]).reverse()
}

function extract(html: string) {
  // Dates live in the JSON-LD <script>, so read them off the untouched html.
  const date = (k: string) => new RegExp(`"${k}"\\s*:\\s*"(\\d{4}-\\d{2}-\\d{2})`).exec(html)?.[1] ?? null
  const b = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  const open = /<div[^>]*class="[^"]*\bentry-content\b[^"]*"[^>]*>/.exec(b)
  if (!open) return null

  // The post body is a div tree, so walk the tags to find its real close instead of guessing.
  const from = open.index + open[0].length
  const tags = /<div\b|<\/div>/g
  tags.lastIndex = from
  let depth = 1
  let to = b.length
  for (let t = tags.exec(b); t; t = tags.exec(b)) {
    depth += t[0] === '</div>' ? -1 : 1
    if (depth === 0) {
      to = t.index
      break
    }
  }

  const cls = /<body[^>]*class="([^"]*)"/.exec(b)?.[1] ?? ''
  const id = /postid-(\d+)/.exec(cls)?.[1]
  const title =
    /property="og:title" content="([^"]*)"/.exec(b)?.[1] ??
    /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(b)?.[1] ??
    ''
  const body = paragraphs(b.slice(from, to))
  if (!id || !title.trim() || !body.length) return null

  return {
    id: `${/\bsingle-(?!format\b)(\w+)/.exec(cls)?.[1] ?? 'post'}-${id}`,
    type: /\bsingle-(?!format\b)(\w+)/.exec(cls)?.[1] ?? 'post',
    source: 'wp',
    title: decode(title.replace(/<[^>]+>/g, ''))
      .replace(/\s*[-|]\s*عبدالله بن فهد الخليفي\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim(),
    date: date('datePublished') ?? /<time[^>]*datetime="(\d{4}-\d{2}-\d{2})/.exec(b)?.[1] ?? null,
    modified: date('dateModified'),
    categories: [
      ...new Set([...b.matchAll(/href="[^"]*\/category\/[^"]*"[^>]*>([^<]+)</g)].map((m) => decode(m[1]).trim())),
    ],
    paragraphs: body,
  }
}

await mkdir(DIR, { recursive: true })
const done = new Set(
  existsSync(LOG) ? (await readFile(LOG, 'utf8')).split('\n').filter(Boolean) : [],
)

const rows: [string, string][] = (await (await fetch(CDX)).json()).slice(1)
// The same slug is archived under several percent-encodings; key by the decoded path and keep
// every capture as a fallback, newest first.
const byPath = new Map<string, Post>()
for (const [url, stamp] of rows) {
  let path: string
  try {
    path = decodeURIComponent(new URL(url).pathname).replace(/^\/|\/$/g, '').toLowerCase()
  } catch {
    continue
  }
  if (!path || NOT_A_POST.test(path)) continue
  if (path.includes('/') && !/^(fatwa|book)\/[^/]+$/.test(path)) continue
  const post = byPath.get(path) ?? { url, stamps: [] }
  post.stamps.push(stamp)
  byPath.set(path, post)
}

const queue = [...byPath.values()].filter((p) => !done.has(p.url))
console.log(`${byPath.size} archived posts, ${queue.length} to fetch`)

let ok = 0
let fail = 0
const failed: string[] = []
await Promise.all(
  Array.from({ length: WORKERS }, async () => {
    for (let p = queue.pop(); p; p = queue.pop()) {
      let article = null
      let stamps = [...new Set(p.stamps)].sort().reverse()
      // Newest capture first; if that snapshot is a Cloudflare interstitial or a half-rendered
      // redesign, ask the CDX for the other captures of this exact URL and work through them.
      for (let round = 0; round < 2 && !article; round++) {
        for (const stamp of stamps) {
          const html = await grab(`https://web.archive.org/web/${stamp}id_/${p.url}`)
          if (html && (article = extract(html))) break
        }
        if (article) break
        stamps = (await captures(p.url)).filter((s) => !p.stamps.includes(s))
        if (!stamps.length) break
      }
      if (article) {
        await writeFile(`${DIR}${article.id}.json`, JSON.stringify({ ...article, url: p.url }))
        ok++
      } else {
        fail++
        failed.push(p.url)
      }
      await appendFile(LOG, `${p.url}\n`)
      if ((ok + fail) % 25 === 0) process.stdout.write(`\r${ok} ok, ${fail} failed`)
    }
  }),
)
console.log(`\nfetched ${ok}, failed ${fail}`)
if (failed.length) await writeFile(`${DIR}../wayback-failed.txt`, failed.join('\n'))

// WP wins: drop the Blogger duplicate of anything we now have from the site itself.
const files = (await readdir(DIR)).filter((f) => f.endsWith('.json'))
const articles = await Promise.all(
  files.map(async (f) => ({ f, a: JSON.parse(await readFile(DIR + f, 'utf8')) })),
)
const wp = new Set(articles.filter((x) => x.a.source === 'wp').map((x) => titleKey(x.a.title)))
let dropped = 0
for (const { f, a } of articles) {
  if (a.source === 'blogger' && wp.has(titleKey(a.title))) {
    await unlink(DIR + f)
    dropped++
  }
}
console.log(`dropped ${dropped} blogger duplicates; ${files.length - dropped} articles remain`)
