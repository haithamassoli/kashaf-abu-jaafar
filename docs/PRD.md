# كشّاف أبي جعفر — PRD

## Summary
Arabic-only, RTL, no-login website to full-text search everything Sheikh **أبو جعفر عبد الله بن فهد الخليفي** said or wrote: transcripts of his YouTube channel `@Alkulify1` (~4,041 videos ≈ 2,324 h + 235 streams + 396 shorts, 108 playlists) and his articles/fatwas from `alkulify.com` (WordPress, ~3,258 posts, 17 categories; currently down → Blogger fallback). A single-speaker clone of `baheth.ieasybooks.com`: a hit is a ~20–30 s transcript cue that opens an embedded YouTube player at that timestamp, or an article paragraph. Transcription happens offline (tafrigh + wit.ai); the site is static (Astro + one React island), search is Meilisearch (self-hosted), no database (Convex not used in v1).

## Users & jobs
- Student/follower: "أين قال الشيخ X؟" → find cue/paragraph, listen from that second, copy a shareable link.
- Reader: open a lecture, read the full transcript, click any line to seek; browse playlists.
- Maintainer (owner, one person, macOS): run tafrigh + `pnpm ingest` + `pnpm deploy` as new videos/articles appear. No admin UI.

## Scope
**In (v1):** search (videos tab / articles tab, playlist filter, pagination), video page (player + clickable transcript + auto-follow + in-video search + copy link), playlists index + playlist page, article page, dark mode, mobile-first RTL, SEO for content pages, incremental ingest scripts, Meilisearch config, deploy runbook.
**Out:** auth/favorites, multi-speaker, books/PDF/hadith search, audio hosting/downloads, transcript editing/correction reports, analytics, i18n, PWA/native, Convex, YouTube auto-captions, thumbnails on result cards, grouped/federated results, date/type filters.

## Decisions (fixed)
- Cue = merge of raw wit chunks to ≥20 words, ≤30 s → click lands ≤30 s before the phrase (baheth-equivalent). Raw chunk onset accuracy ≈ ±1 s.
- Results: flat list, one card per cue, 20/page, ≤50 pages (`maxTotalHits` 1000). Tabs `فيديوهات (n) | مقالات (n)`; articles tab collapses to one result per article (`distinct`).
- Search from the browser directly against Meilisearch with a search-only key. No backend.
- tafrigh is used unmodified (flags only); all shaping happens in our ingest scripts.
- Stack: Astro 5 (static), React 19 islands, Tailwind v4, TypeScript, pnpm, Node 22, `meilisearch` JS ≥0.60. Hosting: Cloudflare Pages (direct upload from the maintainer's Mac). Meilisearch v1.5x in Docker on a small VPS behind Caddy (TLS).
- Digits: Western (0-9); timestamps `HH:MM:SS`.
- PRD/code/comments in English; all UI copy in Arabic.

## Data pipeline (offline, maintainer's Mac)
### 1. Transcription (tafrigh, existing repo `~/Documents/tafrigh`)
```
cd ~/Documents/tafrigh && .venv/bin/tafrigh "<playlist|channel|video URL>" ... \
  -w $WIT_TOKEN [$WIT_TOKEN_2 ...] \
  --max_cutting_duration 15 --min_words_per_segment 0 \
  -f json --yt_dlp_options '{"writeinfojson": true}' \
  --skip_if_output_exist -o out
# free disk (mp3 ≈ 1 MB/min; full channel ≈ 140 GB): delete mp3s that already have a transcript
for f in out/*.mp3; do [ -f "${f%.mp3}.json" ] && rm "$f"; done
```
- Produces `out/<videoId>.json` = raw chunks `[{text,start,end}]` (≤15 s each, `text` may be `""` for failed/silent chunks) and `out/<videoId>.info.json` (yt-dlp: `title, upload_date, duration, channel, playlist_id, playlist_title, playable_in_embed, ...`). Ignore `*.info.json` whose `_type` is `playlist`.
- Idempotent reruns: `out/archive.txt` (yt-dlp) skips downloads, `--skip_if_output_exist` skips transcribed IDs. Feed playlist URLs in priority order, then `https://www.youtube.com/@Alkulify1/videos` (+ `/streams`, `/shorts`) for the rest.
- Throughput ≈ 1 h audio per 12 min per token; extra tokens (separate Arabic wit apps) scale linearly. tafrigh does not read `.env`; pass tokens with `-w`.

### 2. `pnpm ingest` (TypeScript scripts in `scripts/`, run with `tsx`; `.env`: `MEILI_HOST`, `MEILI_ADMIN_KEY`, `RAW_DIR=~/Documents/tafrigh/out`, `CHANNEL_URL`)
`data/` is git-ignored (hundreds of MB); back it up separately. `pnpm ingest` = `meta` → `cues` → `articles` → `index`.

**`meta.ts`** — spawns `yt-dlp` (from tafrigh `.venv`):
- `--flat-playlist -j <CHANNEL_URL>/playlists` → playlist ids/titles; then per playlist `--flat-playlist -j "https://www.youtube.com/playlist?list=<id>"` → member video ids/titles/durations.
- `--flat-playlist -j <CHANNEL_URL>/videos|/streams|/shorts` → all uploads (`kind`).
- Merge `RAW_DIR/*.info.json` when present: `uploadDate` (YYYYMMDD→YYYY-MM-DD), `playableInEmbed`.
- Writes `data/videos.json`: `{ id, title, duration, kind: "video"|"stream"|"short", uploadDate?, playlistIds: string[], playableInEmbed?: boolean, hasTranscript: boolean }[]` and `data/playlists.json`: `{ id, title, videoIds: string[] }[]`.

**`cues.ts`** — for each `RAW_DIR/<id>.json` (skip if `data/cues/<id>.json` is newer):
- Drop chunks with empty/whitespace `text`; trim + collapse whitespace; keep `.` `؟`.
- Merge rule (check before appending a chunk): flush current cue if `words(cue) ≥ 20` OR `chunk.end − cue.start > 30` OR `chunk.start − cue.end > 3`. `start` = first chunk start, `end` = last chunk end, `start`/`end` rounded to 2 decimals.
- Writes `data/cues/<id>.json`: `{ n, start, end, text }[]`.

**`articles.ts`**:
- Primary: WordPress REST `https://alkulify.com/wp-json/wp/v2/{posts,fatwa}?per_page=100&page=N&_fields=id,date,modified,link,slug,title,content,categories,fatawag` (`X-WP-TotalPages`), names from `/wp/v2/categories?per_page=100` and `/wp/v2/fatawag?per_page=100`; browser UA + 1 s sleep (Cloudflare). Incremental: `?modified_after=<lastRunISO>`.
- Fallback when WP is unreachable (currently 522): Blogger Atom `http://alkulify.blogspot.com/feeds/posts/default?max-results=150&start-index=N` (2,346 posts, dated, no labels), `source: "blogger"`, id from the Blogger post id, `url` = blogspot link. When WP is back: re-ingest from WP and delete `source = "blogger"` docs.
- Body: `content.rendered` → strip HTML/decode entities → paragraphs (`<p>`, `<h2..4>`, `<li>`, `<br><br>`) → merge consecutive short paragraphs until ≥100 words (long ones untouched); drop empties.
- Writes `data/articles/<articleId>.json`: `{ id: "<type>-<postId>", type: "post"|"fatwa", source: "wp"|"blogger", title, date, modified, categories: string[], url, paragraphs: string[] }`.

**`index.ts`** — idempotent:
- Ensure indexes + settings (below), wait for tasks.
- `data/state.json` = content hash per video/article; for changed ones: `deleteDocuments({filter: 'videoId = "<id>"'})` (or `articleId`) then `addDocuments` in batches ≤10k; wait for tasks; update state.

### 3. Meilisearch
Index `cues` — doc: `{ id: "<videoId>_<n>", videoId, n, start, end, text, playlistIds: string[], uploadDate? }`
```
searchableAttributes: ["text"]            // titles are NOT searchable (would flood results)
filterableAttributes: ["videoId","playlistIds"]
sortableAttributes: ["start"]
localizedAttributes: [{ attributePatterns: ["*"], locales: ["ara"] }]   // avoids Persian misdetection
pagination: { maxTotalHits: 1000 }
typoTolerance/rankingRules/stopWords/synonyms: defaults
```
Index `articles` — doc: `{ id: "<articleId>-p<n>", articleId, type, source, title, categories, date, n, text }`
```
searchableAttributes: ["title","text"]
filterableAttributes: ["articleId","type","source","categories"]
sortableAttributes: ["date"]
localizedAttributes: same; pagination: same
```
Search (one `multiSearch`, non-federated, both queries every time; every query sets `locales: ["ara"]`):
- Active tab: `page`, `hitsPerPage: 20`; inactive tab: `hitsPerPage: 0` (count only).
- cues: `filter: playlistIds = "<pl>"` when set; `attributesToHighlight: ["text"]`, `highlightPreTag: "<mark>"`, `highlightPostTag: "</mark>"`.
- articles: `distinct: "articleId"`; `attributesToHighlight: ["title","text"]`; `attributesToCrop: ["text"]`, `cropLength: 40`, `cropMarker: "…"`.
- Client post-processing of `_formatted`: unwrap `<mark>` around a bare definite article (`ال|أل|إل|آل|ٱل`), merge `</mark>\s+<mark>` into one mark. `text` never contains HTML (guaranteed at ingest); render only `<mark>`.
- Keys: browser gets a search-only key (actions `search`, indexes `cues`,`articles`); admin key only in `.env` for ingest.
- Ops: `docker compose` with `getmeili/meilisearch:v1.53`, `MEILI_ENV=production`, `MEILI_MASTER_KEY`, volume `/meili_data`, Caddy reverse proxy → `https://search.<domain>`. No backups needed (rebuildable from `data/`). Sizing: 1–2 GB RAM for ~350k cues + ~20k article chunks.

## Site
### Routes
| Route | Type | Content |
|---|---|---|
| `/` | static + `Search` island | intro line, search box (autofocus, submit on Enter/button), tabs, playlist `<select>` (`كل القوائم` + 108), results, pagination. State in URL: `?q=&t=v\|a&pl=&p=`; runs on load if `q` present. `noindex` when `q` (robots `Disallow: /*?q=`). |
| `/v/<videoId>?t=<s>` | static + `Player` island | one page per known video (also untranscribed → note `التفريغ غير متوفر بعد` + `noindex`). |
| `/p` | static | 108 playlists (title, count) + client-side title filter. |
| `/p/<playlistId>` | static | videos (mqdefault thumb `https://i.ytimg.com/vi/<id>/mqdefault.jpg`, title, duration, date, transcript badge) + scoped search box → `/?q=&pl=<id>`. |
| `/a/<articleId>` | static | title, date, categories, `المصدر` link, paragraphs `<p id="p<n>">`, `:target` highlight. |
| `/404` | static | search box. |

### Result cards
- Video: first playlist title (→ `/p/<id>`), video title (→ `/v/<id>?t=<start>`), highlighted cue text, `HH:MM:SS`. Whole card clickable to the video page.
- Article: type badge (`مقالة`/`فتوى`), title (highlighted), cropped highlighted paragraph, date, category → `/a/<articleId>#p<n>`.
- Header line: `النتائج من A إلى B من أصل N` (N = `totalHits`, show `+1000` when capped). Empty: `لا نتائج لـ "…"`. Error (Meilisearch down): `تعذّر الاتصال بالبحث، حاول لاحقًا`.

### Video page (`Player` island)
- Meta: title, playlists, upload date, duration, `افتح في يوتيوب` (`https://youtu.be/<id>?t=<s>`).
- Player: YouTube IFrame API, `host: https://www.youtube-nocookie.com`, `playerVars: { start: t, autoplay: t ? 1 : 0, hl: "ar", rel: 0, playsinline: 1, origin }`. `onError` 101/150/153 or `playableInEmbed === false` → replace player with a fallback card linking to YouTube at `t`.
- Transcript (cues inlined in HTML at build): each cue = timestamp button + text. Click → `seekTo(start, true)` + `playVideo()` + `history.replaceState('?t=<start>')`.
- Auto-follow: poll `getCurrentTime()` every 500 ms while playing; active cue gets a highlight; `scrollIntoView({block:"center"})` when the `متابعة تلقائية` checkbox (default on) is checked.
- In-video search: input filters cues client-side on normalized text (both sides: strip diacritics/tatweel, `أإآٱ→ا`, `ة→ه`, `ى→ي`), shows count, highlights matches. No Meilisearch call.
- Per-cue `نسخ الرابط` → clipboard `<origin>/v/<id>?t=<floor(start)>`; toast `تم النسخ`.
- Desktop: player right/sticky, transcript left (RTL); mobile: player sticky top, transcript below.

### Design
- `<html lang="ar" dir="rtl">`; Tailwind v4 logical utilities (`ms/me/ps/pe/text-start`); fonts self-hosted: Noto Naskh Arabic (variable) for transcripts/articles (line-height ≥ 1.9), IBM Plex Sans Arabic for UI. Dark mode: `prefers-color-scheme` default + header toggle persisted in `localStorage.theme` (inline head script, no flash). Highlight `<mark>`: high-contrast in both themes.
- Mobile-first, tap targets ≥ 44 px, visible focus rings, `/` focuses the search box, semantic landmarks, alt text on thumbnails, `prefers-reduced-motion` respected.

### UI copy (Arabic)
كشّاف أبي جعفر · ابحث في دروس ومقالات الشيخ أبي جعفر عبد الله بن فهد الخليفي · بحث · مثال: كفارة اليمين · فيديوهات · مقالات · فتوى · مقالة · كل القوائم · قائمة التشغيل · النتائج من A إلى B من أصل N · لا نتائج · التالي · السابق · نسخ الرابط · تم النسخ · افتح في يوتيوب · متابعة تلقائية · ابحث داخل الفيديو · التفريغ غير متوفر بعد · تعذّر تشغيل الفيديو هنا، شاهده على يوتيوب · القوائم · المصدر · الوضع الداكن · الوضع الفاتح · تعذّر الاتصال بالبحث، حاول لاحقًا · الصفحة غير موجودة

## Repo layout
```
PRD.md  astro.config.mjs  package.json  .env.example  wrangler.jsonc  compose.yml (meilisearch+caddy)
src/pages/{index,404}.astro  src/pages/v/[id].astro  src/pages/p/{index,[id]}.astro  src/pages/a/[id].astro
src/islands/{Search,Player}.tsx  src/lib/{meili,normalize,format}.ts  src/layouts/Base.astro  src/styles/global.css
scripts/{meta,cues,articles,index}.ts  data/ (git-ignored: videos.json playlists.json cues/ articles/ state.json)
```
`pnpm dev|build|preview|ingest|meta|cues|articles|index|deploy` (`deploy` = `wrangler pages deploy dist`).

## Non-functional
- Search p95 < 300 ms server-side; results render < 100 ms after response.
- Video page LCP < 2.5 s on 4G mobile; IFrame API loaded only on `/v/*`; no player on result cards.
- Full static build ≤ 10 min for ~8k pages; incremental ingest of one new video ≤ 5 min excluding transcription.
- Cost: VPS ≈ $5/mo; Cloudflare Pages free.
- Security: no secrets in the client except the search-only key; admin key never leaves `.env`; CSP allows only own origin, Meilisearch host, `youtube-nocookie.com`, `i.ytimg.com`.

## Acceptance criteria
1. Searching `كفارة اليمين` returns highlighted cues; clicking one opens `/v/<id>?t=` and playback starts at cue start (≤30 s before the phrase).
2. `الصلاه` matches `الصلاة`; `إسلام` and `اسلام` match each other; a diacritized query matches undiacritized text; typo `الطلاك` still finds `الطلاق`.
3. Playlist filter narrows results; pagination reaches page 50 max; tab counts update per query; URL is shareable and reproduces the state on load.
4. Video page: timestamp click seeks; active cue highlights and scrolls during playback; auto-follow can be turned off; in-video search filters live; copy link works; embed-disabled video shows the YouTube fallback.
5. Articles tab shows one result per article; link opens the article with the target paragraph highlighted; article page lists source URL.
6. Rerunning tafrigh + `pnpm ingest` after one new video: only that video's docs are written; nothing else changes.
7. Lighthouse a11y ≥ 90 on `/`, `/v/*`, `/a/*`; works on iOS Safari and Android Chrome; light and dark themes.

## Risks / notes
- `alkulify.com` origin down (522) since ~2026-07 → start articles from Blogger; ask the site's volunteer team for a WP export/permission before bulk pulls.
- wit.ai returns empty text for ~13% of chunks in the sample (silence or failed requests) → dropped by `cues.ts`; no correction workflow in v1.
- Meilisearch/charabia may misdetect short Arabic text as Persian → always set `localizedAttributes` + request `locales`.
- Full transcription of the channel ≈ 19 days per wit token; the site works with partial coverage (`hasTranscript` badge).

## Later (explicitly deferred)
Grouped-by-video results; federated single list; date/kind filters; thumbnails on cards; correction reports + analytics (Convex candidate); YouTube auto-caption seeding; stop-word/synonym tuning (`اه`, `آآ`, fillers); PWA.
