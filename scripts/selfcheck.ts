/** `pnpm check` — the smallest thing that fails if the text plumbing breaks. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { client, highlight, peek, rateLimited, search } from '../src/lib/meili.ts'
import { normalize } from '../src/lib/normalize.ts'
import { clean, mergeSegments } from '../src/lib/clean.ts'
import { chunk, decode, paragraphs, titleKey } from '../src/lib/html.ts'
import { markMatches } from '../src/lib/mark.ts'
import { timestamp, duration, arabicDate, lessons, hours, lists, articles, withDigits } from '../src/lib/format.ts'
import { breadcrumb, mailto, CONTACT_EMAIL, SITE, SITE_URL } from '../src/lib/seo.ts'
import { allArticles, playlists, playlistVideos } from '../src/lib/data.ts'
import { all, update } from '../src/lib/store.ts'

// highlight: escapes everything except <mark>, so a hostile transcript cannot inject HTML
assert.equal(
  highlight('<img src=x onerror=alert(1)>', ''),
  '&lt;img src=x onerror=alert(1)&gt;',
)
// Meilisearch marks the split-off definite article on its own — drop it
assert.equal(highlight('<mark>ال</mark>كتاب', ''), 'الكتاب')
// adjacent marks (phrase match, word by word) merge into one continuous highlight
assert.equal(highlight('<mark>كفارة</mark> <mark>اليمين</mark>', ''), '<mark>كفارة اليمين</mark>')
// the article split off the *matched* word must stay inside the highlight
assert.equal(highlight('<mark>ال</mark><mark>صلاه</mark> نعم', ''), '<mark>الصلاه</mark> نعم')
// a merged mark must not swallow the article of the following word
assert.equal(highlight('<mark>كفاره</mark> <mark>ال</mark>ظهار', ''), '<mark>كفاره</mark> الظهار')
// two marked articles in a row must not leave one of them marked
assert.equal(highlight('<mark>ال</mark> <mark>ال</mark>ا ان', ''), 'ال الا ان')
assert.equal(highlight(undefined, 'نص عادي'), 'نص عادي')

// normalize: the folding Meilisearch does at query time, mirrored for client-side filters
assert.equal(normalize('الصَّلاة'), 'الصلاه')
assert.equal(normalize('إسلام'), normalize('اسلام'))
assert.equal(normalize('مصطفى'), 'مصطفي')

// clean: YouTube sound-event tags out, real text untouched
assert.equal(clean('قال [موسيقى] الشيخ'), 'قال الشيخ')
assert.equal(clean('[تصفيق]'), '')
assert.equal(clean('باب الطلاق'), 'باب الطلاق')
assert.equal(
  clean('بعظ الموظوع ايظا رافظي يظرب ظعيفا ظبط ظمن الظرورة وظع رظي رمظان قظية فظائل يظحك غظب الوعض ضاهر حظور فضيع'),
  'بعض الموضوع ايضا رافضي يضرب ضعيفا ضبط ضمن الضرورة وضع رضي رمضان قضية فضائل يضحك غضب الوعظ ظاهر حضور فظيع',
)
assert.equal(clean('بعظمة محظور فضيعة القرظي فظلت'), 'بعظمة محظور فضيعة القرظي فظلت')

// mergeSegments: short speech fragments join, but silence and a 20 s span remain boundaries.
assert.deepEqual(
  mergeSegments([
    { text: '1 2 3 4 5', start: 0, end: 3 },
    { text: '6 7 8 9 10 11 12 13 14 15', start: 3.5, end: 8 },
    { text: 'قصير', start: 8.5, end: 9 },
    { text: 'بعد صمت', start: 11.1, end: 12 },
    { text: 'بعيد', start: 12.5, end: 32 },
  ]),
  [
    { text: '1 2 3 4 5 6 7 8 9 10 11 12 13 14 15', start: 0, end: 8 },
    { text: 'قصير', start: 8.5, end: 9 },
    { text: 'بعد صمت', start: 11.1, end: 12 },
    { text: 'بعيد', start: 12.5, end: 32 },
  ],
)

// html: Word-pasted article markup in, ~paragraph-sized chunks out
assert.deepEqual(paragraphs('<div>سطر أول</div><div>سطر ثانٍ</div>'), ['سطر أول سطر ثانٍ'])
assert.deepEqual(paragraphs('<!--[if gte mso 9]><xml>junk</xml><![endif]--><p>نص</p>'), ['نص'])
assert.equal(decode('&#1575;&amp;&nbsp;ب'), 'ا& ب')
// the Telegram body is full of these; undecoded they survive into the text as literal `&rlm;`
assert.equal(decode('&rlm;نص'), '\u200fنص')
// chunk: the same gluing, but over lines the caller already split (Telegram keeps its blanks)
assert.deepEqual(chunk(['سطر أول', 'سطر ثانٍ']), ['سطر أول سطر ثانٍ'])
// a line that is already long enough closes its chunk instead of swallowing the next one
const long = 'ك'.repeat(600)
assert.deepEqual(paragraphs(`<p>${long}</p><p>ذيل</p>`), [long, 'ذيل'])
// titleKey: the same post on wp and blogger, differing only in diacritics/punctuation
assert.equal(titleKey('الصَّلاة … '), titleKey('الصلاه'))
assert.notEqual(titleKey('تقويم المعاصرين ( الحلقة الثانية )'), titleKey('تقويم المعاصرين ( الحلقة الثانية عشر )'))

// format
assert.equal(timestamp(0), '00:00')
assert.equal(timestamp(3671), '1:01:11')
assert.equal(duration(3600), '1 س')
assert.equal(duration(90), '2 د')
assert.equal(arabicDate('2025-03-08'), '8 مارس 2025')
assert.equal(arabicDate(null), '')

// counted nouns: the form follows the last two digits, and the dual drops the numeral
assert.equal(lessons(1), '1 درس')
assert.equal(lessons(2), 'درسان')
assert.equal(lessons(3), '3 دروس')
assert.equal(lessons(10), '10 دروس')
assert.equal(lessons(11), '11 درسًا')
assert.equal(lessons(92), '92 درسًا')
assert.equal(lessons(100), '100 درس')
assert.equal(lessons(102), '102 درسان')
assert.equal(lessons(112), '112 درسًا')
assert.equal(hours(109), '109 ساعات')
assert.equal(lists(2), 'قائمتان')
assert.equal(withDigits('109 ساعات'), '<span class="digits">109</span> ساعات')
// four figures group, and the separator must stay inside the one digit run — a `\d+` regex
// splits `3,333` into two spans, which renders as `3,333` with the comma outside both
assert.equal(articles(3333), '3,333 مقالة')
assert.equal(lessons(1584), '1,584 درسًا')
assert.equal(withDigits(articles(3333)), '<span class="digits">3,333</span> مقالة')

// seo: breadcrumbs must be absolute, 1-indexed, and root-anchored — Google drops the
// whole BreadcrumbList otherwise, and relative `item` URLs are the usual way that breaks.
const crumbs = breadcrumb([['القوائم', '/p/'], ['قائمة', '/p/abc/']]).itemListElement
assert.equal(crumbs.length, 3)
assert.deepEqual(
  crumbs.map((c) => [c.position, c.item]),
  [
    [1, `${SITE_URL}/`],
    [2, `${SITE_URL}/p/`],
    [3, `${SITE_URL}/p/abc/`],
  ],
)
assert.ok(crumbs.every((c) => c.item.startsWith('https://')))

// markMatches: the in-video transcript filter. Same contract as meili's highlight, but it
// runs on raw transcript text in the browser, so escaping is the security boundary here.
assert.equal(markMatches('<img src=x onerror=alert(1)>', 'zzz'), '&lt;img src=x onerror=alert(1)&gt;')
assert.equal(markMatches('باب الصلاة', normalize('الصلاة')), 'باب <mark>الصلاة</mark>')
// a phrase spanning two words comes back as one continuous mark, not two
assert.equal(markMatches('كفارة اليمين واجبة', normalize('كفارة اليمين')), '<mark>كفارة اليمين</mark> واجبة')
// no match leaves the text alone (still escaped)
assert.equal(markMatches('باب الصلاة', normalize('الزكاة')), 'باب الصلاة')
// folding means the query matches undiacritised text and vice versa
assert.equal(markMatches('الصَّلاة نعم', normalize('الصلاه')), '<mark>الصَّلاة</mark> نعم')
// an empty query must return early: indexOf('') never reaches -1, so the match loop hangs
assert.equal(markMatches('باب الصلاة', ''), 'باب الصلاة')

// mailto: the contact form hands this straight to the mail client, so an unencoded `&`
// or `#` in the subject would truncate the message the user just typed.
const link = mailto('س & ج #1', 'سطر\nآخر')
assert.ok(link.startsWith(`mailto:${CONTACT_EMAIL}?subject=`))
const q = new URL(link).searchParams
assert.equal(q.get('subject'), `[${SITE}] س & ج #1`)
assert.equal(q.get('body'), 'سطر\nآخر')

// search cache: a tab switch, or a back button, re-asks a question already answered. It must
// come back from memory — the server embeds every query on one shared core — and the same
// filters in another order are the same question.
let calls = 0
const stub = { hits: [], totalHits: 1, page: 1, totalPages: 1, processingTimeMs: 0 }
client.multiSearch = (async () => {
  calls++
  return { results: [stub, stub] }
}) as unknown as typeof client.multiSearch
client.index = (() => ({ search: async () => stub })) as unknown as typeof client.index

await search('كفارة اليمين', { tab: 'v', playlists: ['b', 'a'] })
await search('كفارة اليمين', { tab: 'v', playlists: ['a', 'b'] })
assert.equal(calls, 1)
assert.ok(peek('كفارة اليمين', { tab: 'v', playlists: ['a', 'b'] }))
// a different tab, page or filter is a different answer, and must still go out
await search('كفارة اليمين', { tab: 'a', playlists: ['a', 'b'] })
await search('كفارة اليمين', { tab: 'v', playlists: [] })
assert.equal(calls, 3)
assert.equal(peek('كفارة اليمين', { tab: 'v', page: 2 }), undefined)

// The bfcache is not a guarantee: a back button that misses it lands on a fresh document with
// an empty Map and only sessionStorage to answer from. Plant an answer the way search() stores
// one — under a question the Map has never held — and peek must still find it.
const store = new Map<string, string>()
Object.assign(globalThis, {
  sessionStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
})
await search('كفارة اليمين', { tab: 'v', page: 3 })
const [stored] = [...store.keys()]
assert.ok(stored, 'an answer must outlive the document that asked for it')
store.set(stored.replace('كفارة اليمين', 'سؤال آخر'), JSON.stringify({ ...stub, total: 42 }))
assert.equal(peek('سؤال آخر', { tab: 'v', page: 3 })?.total, 42)

// A refusal must not become three requests. Caddy answers 429 at 30 per 10 s per IP, and the
// fallbacks in `both` are there for a missing embedder, not for a closed door — `client.index`
// is still stubbed to succeed above, so a missing guard shows up here as a resolved search.
let refused = 0
client.multiSearch = (async () => {
  refused++
  throw Object.assign(new Error('too many requests'), { response: { status: 429 } })
}) as unknown as typeof client.multiSearch
await assert.rejects(search('سؤال لم يسبق أن سئل', { tab: 'v' }))
assert.equal(refused, 1)
assert.ok(!rateLimited(new Error('the box is simply down')))

// playlistVideos: /p/ and the lesson prev/next both walk this, and 9 of 43 playlists arrive
// from YouTube out of chronological order — an unsorted return reads as «الدرس التالي» going back.
for (const p of playlists) {
  const walked = playlistVideos(p)
  assert.equal(walked.length, p.videoIds.length, `${p.title} lost a lesson`)
  const dates = walked.map((v) => v.uploadDate ?? '')
  assert.ok(
    dates.every((d, i) => i === 0 || dates[i - 1] <= d),
    `${p.title} is not oldest-first`,
  )
}

// Telegram articles: their photos live in public/, which nothing else in the build validates —
// a missed download or a renamed file is a 404 on a live page and silent everywhere else.
const pub = new URL('../public/', import.meta.url).pathname
for (const a of allArticles().filter((a) => a.source === 'telegram')) {
  assert.ok(a.title && a.paragraphs.length && a.date, `${a.id} came out of Telegram empty`)
  assert.ok(a.url.startsWith('https://t.me/'), `${a.id} has no source message`)
  for (const img of a.images ?? []) {
    assert.ok(existsSync(pub + img.src.replace(/^\//, '')), `${a.id}: ${img.src} is not in public/`)
    assert.ok(img.w > 0 && img.h > 0, `${a.id}: ${img.src} has no dimensions`)
  }
}

// store: one entry per page holds both the bookmark and the note, and an entry left with
// neither must disappear — otherwise unstarring a page nobody annotated litters /saved/.
const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) },
})
const page = { title: 'درس', kind: 'v' as const }
update('/v/x/', page, { mark: true })
update('/v/x/', page, { note: 'ملاحظة' })
assert.equal(all()['/v/x/'].mark, true)
assert.equal(all()['/v/x/'].note, 'ملاحظة')
update('/v/x/', page, { mark: undefined })
assert.equal(all()['/v/x/'].note, 'ملاحظة') // the note alone keeps the entry alive
update('/v/x/', page, { note: undefined })
assert.deepEqual(all(), {}) // nothing left to remember
mem.set('kashaf:saved', '[1,2]') // a hand-mangled blob reads as empty, never as a crash
assert.deepEqual(all(), {})

console.log('selfcheck ok')
