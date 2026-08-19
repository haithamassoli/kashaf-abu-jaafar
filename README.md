<div align="center">

<img src="public/app-icon.png" width="88" alt="">

# كشّاف أبي جعفر

**بحث في نصوص دروس ومقالات الشيخ أبي جعفر عبد الله بن فهد الخليفي**

موقع عربي بالكامل، من اليمين إلى اليسار، بلا تسجيل دخول وبلا قاعدة بيانات.

[![الموقع](https://img.shields.io/badge/الموقع-kashaf--alkulify.assoli.site-1f6f4a)](https://kashaf-alkulify.assoli.site)
[![Astro](https://img.shields.io/badge/Astro-5-BC52EE?logo=astro&logoColor=white)](https://astro.build)
[![Meilisearch](https://img.shields.io/badge/Meilisearch-1.53-FF5CAA?logo=meilisearch&logoColor=white)](https://www.meilisearch.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

[English](README.en.md) · [المواصفات (PRD)](docs/PRD.md)

</div>

---

## ما هذا؟

تُفرَّغ دروس قناة [@Alkulify1](https://www.youtube.com/@Alkulify1) آليًا، وتُجمَع مقالات الشيخ من مدوّنته، ثم يُفهرس الكل في Meilisearch. النتيجة: تكتب عبارة فتصلك المقاطع التي قِيلت فيها، وضغطة واحدة تفتح الفيديو عند الثانية نفسها.

- **بحث في الدروس والمقالات** في تبويبين، مع عدّاد لكل تبويب وتصفية بقوائم التشغيل.
- **نتيجة = مقطع مفرَّغ (≈30 ثانية)** يفتح المشغّل عند وقته، أو فقرة من مقالة تفتح المقالة عندها.
- **تفريغ تفاعلي** بجانب المشغّل: متابعة تلقائية للسطر الجاري، بحث داخل الدرس، ونسخ رابط لأي سطر.
- **بلا خادم للبحث**: المتصفّح يسأل Meilisearch مباشرة بمفتاح بحث فقط، والصفحات كلها ثابتة (static).
- وضع فاتح/داكن، تصميم يبدأ من الجوال، ودعم لوحة المفاتيح وقارئ الشاشة.

## لقطات

| الرئيسية والبحث | تبويب المقالات |
|---|---|
| <img src="shots/01-home-search-light.png" alt="الصفحة الرئيسية ونتائج البحث عن «كفارة اليمين»"> | <img src="shots/10-articles-tab-light.png" alt="نتائج تبويب المقالات مع تظليل الكلمات"> |

| صفحة الدرس: المشغّل والتفريغ | البحث داخل الدرس |
|---|---|
| <img src="shots/02-video-light.png" alt="صفحة درس فيها المشغّل والتفريغ التفاعلي والسطر الجاري مظلَّل"> | <img src="shots/03-video-filter-marks.png" alt="تصفية سطور التفريغ بكلمة «الدليل» مع تظليل المطابقات"> |

| صفحة المقالة | فاتح / داكن |
|---|---|
| <img src="shots/11-article-target.png" alt="صفحة مقالة مع تظليل الفقرة المقصودة"> | <img src="shots/07-light-marks.png" alt="الوضع الفاتح"><br><img src="shots/06-dark-marks.png" alt="الوضع الداكن"> |

<details>
<summary>على الجوال</summary>

| درس | مقالات |
|---|---|
| <img src="shots/08-mobile-video.png" width="300" alt="صفحة الدرس على الجوال"> | <img src="shots/13-articles-mobile.png" width="300" alt="نتائج المقالات على الجوال"> |

</details>

## كيف يعمل

```
يوتيوب ──▶ tafrigh (ترجمات القناة، وwit.ai عند غيابها) ──┬─▶ <id>.chunks.ndjson ──▶ Meilisearch (cues)
                                                        └─▶ <id>.transcript.json ─▶ data/ ─┐
                                                                                            ├─▶ Astro (بناء ثابت)
مدوّنة بلوجر + لقطات archive.org ──▶ scripts/articles.ts + wayback.ts ──▶ data/articles/ ───┘
                                                                       └──▶ Meilisearch (articles)
```

التفريغ والفهرسة يجريان على جهاز الصيانة، لا على الخادم. ما يُرفع إلى المستودع هو `data/` (بيانات البناء)، وما يُرفع إلى Meilisearch هو مستندات البحث.

## الأرقام (لقطة `data/` الحالية)

| | |
|---|---|
| الدروس المفرَّغة | 1,134 درسًا (≈ 828 ساعة) — من ~4000 على القناة، والتفريغ مستمر |
| المقاطع المفهرسة | 46,613 |
| المقالات | 3,333 (≈ 37 ألف فقرة) |
| قوائم التشغيل | 14 |

## التشغيل محليًا

```bash
pnpm install
cp .env.example .env                 # RAW_DIR = مجلد مخرجات tafrigh

brew install meilisearch             # الإنتاج يستعمل compose.yml على خادم
pnpm meili &                         # قاعدة البيانات في ./data/ المستثناة من git

pnpm ingest                          # يبني data/ ويفهرس، ويطبع مفتاح البحث فقط
                                     # ألصق المفتاح في PUBLIC_MEILI_SEARCH_KEY داخل .env
pnpm dev                             # http://localhost:4321
```

من لا يملك مخرجات tafrigh يكفيه `pnpm dev` لتصفّح الموقع ببيانات `data/` المرفوعة في المستودع؛ البحث وحده يحتاج Meilisearch.

### السكربتات

| السكربت | ما يفعله |
|---|---|
| `pnpm data` | `RAW_DIR/*.transcript.json` ← `data/{videos,playlists}.json` + `data/segments/<id>.json` |
| `pnpm articles` | تغذية Atom لمدوّنة بلوجر ← `data/articles/<id>.json` |
| `pnpm index` | يفهرس المقاطع والمقالات في Meilisearch وينشئ مفتاح البحث فقط (`pnpm index cues\|articles` لأحد الطرفين) |
| `pnpm ingest` | الثلاثة بالترتيب |
| `pnpm check` | فحوص ذاتية لمعالجة النصوص (التظليل، التنظيف، التنسيق) |
| `pnpm build` / `preview` | بناء ثابت لكل الصفحات / تشغيل `dist/` |

كلها آمنة عند إعادة التشغيل. `pnpm data` يعيد بناء `data/` من الصفر، فالدرس المحذوف من `RAW_DIR` يختفي من البناء التالي. أما `pnpm index` فيكتب فوق المقاطع بالـ`id` ولا يحذف إلا ما صار نصه فارغًا بعد التنظيف؛ لحذف درس من الفهرس استعمل التصفية `videoId = "<id>"`.

## البحث العربي

المعاملان مطلوبان معًا وإلا كانت النتائج خاطئة:

```json
{ "q": "بر الوالدين", "locales": ["ara"], "matchingStrategy": "all" }
```

- `locales` تجعل charabia توحّد الهمزة والتاء المربوطة وقت الاستعلام.
- `matchingStrategy: "all"` تمنع «ال» المنفصلة من مطابقة المدوّنة كلها (الوضع الافتراضي `last` يعيد ~99٪ من المستندات لأي استعلام يبدأ بـ«ال»).
- `minWordSizeForTypos.oneTypo: 4` في `meilisearch-settings.json` يبقي الجذور العربية القصيرة متسامحة مع الخطأ (`الطلاك` ← `الطلاق`).

المتصفّح لا يحمل إلا مفتاح بحث فقط (`search` على `cues` و`articles`)، ومفتاح الإدارة يبقى في `.env`.

## المقالات

موقع الشيخ `alkulify.com` يردّ بـ Cloudflare 522 منذ ~2026-07، فجُمِعت المدوّنة من مصدرين يردّان:

```bash
pnpm articles                        # مرآة بلوجر: 2,346 تدوينة، لكنها تتوقف عند 2019-06
npx tsx scripts/wayback.ts           # لقطات archive.org للموقع نفسه، حتى 2026
```

يقرأ `wayback.ts` فهرس CDX، ويأخذ أحدث لقطة صالحة لكل تدوينة (متراجعًا إلى الأقدم كلما كانت اللقطة صفحة Cloudflare اعتراضية)، ثم يحذف نسخة بلوجر لكل تدوينة يغطّيها الموقع الأصلي. يسجّل ما أنجزه في `data/wayback-done.txt` فيُستأنَف بعد أي انقطاع. الحصيلة: 3,333 مقالة (3,232 من الموقع + 101 من بلوجر وحدها) و~37 ألف فقرة. أربع تدوينات لا يمكن استرجاعها ومسجَّلة في `data/wayback-failed.txt`.

نسخة PDF من المدوّنة ليست مصدرًا صالحًا: `pdftotext` يعكس تسلسل الأرقام (حديث 2135 ← 5312) ويحشر مسافات داخل الكلمات (`معاو ية`)، ولا يصلحه إلا إعادة دمج إحداثيات المحارف.

## التفريغ

يجري في مستودع [tafrigh](https://github.com/ieasybooks/tafrigh) كما هو، بلا تعديل — بالخيارات فقط:

```bash
cd ~/Downloads/tafrigh && .venv312/bin/tafrigh "<رابط قائمة أو قناة>" \
  --skip_if_output_exist --use_youtube_transcript -o output -f none \
  -w "$WIT_TOKEN" "$WIT_TOKEN_2" "$WIT_TOKEN_3" \
  --min_words_per_segment 0 --max_cutting_duration 15
```

يأخذ ترجمة القناة العربية إن وُجدت (~2000× الزمن الحقيقي)، وإلا فوِت (wit.ai) (~8× لكل رمز، خطيًّا بعدد الرموز). استعمل `.venv312` لا `.venv`: مسار wit معطَّل على بايثون 3.14 (`pydub` ← `audioop` المحذوفة).

كل درس يخرج منه `<id>.chunks.ndjson` (مقاطع بحث جاهزة، متداخلة ومحدودة بـ30 ثانية) و`<id>.transcript.json` (مقاطع دقيقة + بيانات الفيديو، وهو مصدر لوحة التفريغ و`data/`).

## النشر

- **الواجهة**: Vercel، تنشر تلقائيًا مع كل دفع إلى `main`. البناء ثابت، فمتغيّرات `PUBLIC_*` تُخبز وقت البناء — تغييرها يستلزم إعادة نشر لا حفظ إعدادات فقط.
- **البحث**: Meilisearch ذاتي الاستضافة خلف Caddy (شهادة تلقائية) على خادم صغير — `compose.yml` هو الملف المستعمل هناك.
- **الفهرسة**: من جهاز الصيانة نحو الخادم البعيد مباشرة؛ `scripts/index.ts` قابل لإعادة التشغيل بلا أثر جانبي.

> السكربت `pnpm deploy` بقيّة من مسار Cloudflare Pages قبل الانتقال إلى Vercel، ولا يُستعمل الآن.

## بنية المشروع

```
scripts/      خط البيانات: build-data · articles · wayback · index · selfcheck
src/pages/    الرئيسية · /v/[id] الدرس · /a/[id] المقالة · /p القوائم
src/islands/  جزيرتا React: Search (البحث) و Player (المشغّل والتفريغ)
src/lib/      تنظيف النص وتطبيعه وتظليله، عميل Meilisearch، بيانات البناء، SEO
data/         لقطة البناء: videos · playlists · segments/ · articles/
docs/PRD.md   مواصفات المنتج (بالإنجليزية)
```

## المساهمة

الملاحظات والمساهمات مرحَّب بها: افتح [issue](https://github.com/haithamassoli-plus-connect/kashaf-abu-jaafar/issues) أو طلب دمج. أكثر ما ينفع الآن هو الإبلاغ عن خطأ في التفريغ أو نتيجة بحث غريبة مع رابط الصفحة. شغّل `pnpm check` قبل الدفع.

## الرخصة والمحتوى

الكود تحت رخصة [MIT](LICENSE). أما دروس الشيخ ومقالاته ونصوصها المفرَّغة فهي ملك أصحابها، ولا تشملها رخصة الكود.

## شكر

[tafrigh](https://github.com/ieasybooks/tafrigh) للتفريغ، و[baheth](https://baheth.ieasybooks.com) للفكرة، و[Meilisearch](https://www.meilisearch.com) وcharabia لتطبيع العربية.
