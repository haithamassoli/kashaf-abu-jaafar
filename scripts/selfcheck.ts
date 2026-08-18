/** `pnpm check` — the smallest thing that fails if the text plumbing breaks. */
import assert from 'node:assert/strict'
import { highlight } from '../src/lib/meili.ts'
import { normalize } from '../src/lib/normalize.ts'
import { clean } from '../src/lib/clean.ts'
import { timestamp, duration, arabicDate, lessons, hours, lists, withDigits } from '../src/lib/format.ts'
import { breadcrumb, SITE_URL } from '../src/lib/seo.ts'

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

console.log('selfcheck ok')

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
