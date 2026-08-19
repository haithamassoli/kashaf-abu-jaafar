# كشّاف أبي جعفر

Full-text search over the lectures of Sheikh أبو جعفر عبد الله بن فهد الخليفي.
Arabic-only, RTL, no login, no database.

```
YouTube ── tafrigh (YouTube captions → wit.ai fallback) ──▶ *.chunks.ndjson ──▶ Meilisearch
                                                        └─▶ *.transcript.json ─▶ data/ ──▶ Astro (static)
```

Product spec: [docs/PRD.md](docs/PRD.md).

## Run it locally

```bash
pnpm install
cp .env.example .env                 # RAW_DIR = tafrigh's output dir

brew install meilisearch             # production uses compose.yml on a VPS
pnpm meili &                         # db in git-ignored ./data/

pnpm ingest                          # data/ snapshot + Meilisearch index; prints the search-only key
                                     # paste PUBLIC_MEILI_SEARCH_KEY into .env
pnpm dev                             # http://localhost:4321
```

| script | what it does |
|---|---|
| `pnpm data` | `RAW_DIR/*.transcript.json` → `data/{videos,playlists}.json` + `data/segments/<id>.json` |
| `pnpm articles` | Blogger Atom feed → `data/articles/<id>.json` |
| `pnpm index` | `RAW_DIR/*.chunks.ndjson` → Meilisearch `cues`, `data/articles/` → `articles`, and creates/reuses the browser's search-only key (`pnpm index cues\|articles` does one side) |
| `pnpm ingest` | all three, in order |
| `pnpm check` | self-checks for the text plumbing (highlighting, folding, cleaning, formatting) |
| `pnpm build` / `preview` | static build of every page / serve `dist/` |
| `pnpm deploy` | `wrangler pages deploy dist` — refuses if the build still points at localhost |

All steps are safe to re-run. `pnpm data` rebuilds `data/` from scratch, so a lecture removed
from `RAW_DIR` also disappears from the next build. `pnpm index` overwrites cues by `id` and
only deletes cues whose text cleaned to empty — a lecture removed from `RAW_DIR` keeps its
documents in Meilisearch until you delete them by filter (`videoId = "<id>"`).

## Articles

`alkulify.com` (WordPress, the sheikh's own site) has been answering Cloudflare 522 since
~2026-07, so the corpus is assembled from the two sources that do answer:

```bash
pnpm articles                        # Blogger mirror: 2,346 posts, but it stops at 2019-06
npx tsx scripts/wayback.ts           # archive.org snapshots of alkulify.com, through 2026
```

`wayback.ts` reads the CDX index, pulls the newest usable capture of every archived post
(falling back through older captures when one is a Cloudflare interstitial), and finishes by
deleting the Blogger copy of every post the site itself covers. It logs finished URLs to
`data/wayback-done.txt`, so an interrupted run resumes where it stopped. Result: 3,333 articles
(3,232 `wp` + 101 Blogger-only), ~37k paragraph chunks. Four posts are unrecoverable — their
only capture is an interstitial — and are listed in `data/wayback-failed.txt`.

The PDF collection of the blog is *not* a usable source: `pdftotext` reverses digit runs (hadith
no. 2135 → 5312) and injects plain spaces inside words (`معاو ية`), which no cleanup short of
re-merging glyph coordinates undoes.

## Transcription

Lives in the [tafrigh](https://github.com/ieasybooks/tafrigh) checkout, unmodified (flags only):

```bash
cd ~/Downloads/tafrigh && .venv312/bin/tafrigh "<playlist or channel URL>" \
  --skip_if_output_exist --use_youtube_transcript -o output -f none \
  -w "$WIT_TOKEN" "$WIT_TOKEN_2" "$WIT_TOKEN_3" \
  --min_words_per_segment 0 --max_cutting_duration 15
```

It takes the channel's own Arabic caption track when there is one (~2000× real time) and falls
back to wit.ai when there is not (~8× real time per token, linear in the number of tokens).
Use `.venv312`, not `.venv`: the wit path is broken on Python 3.14 (`pydub` → removed `audioop`).

Each lecture yields `<id>.chunks.ndjson` (index-ready search cues, already overlapping and
capped at 30 s) and `<id>.transcript.json` (fine-grained segments + video metadata, which is
what the site's transcript panel and `data/` are built from).

## Search

Both parameters are required or the results are wrong:

```json
{ "q": "بر الوالدين", "locales": ["ara"], "matchingStrategy": "all" }
```

`locales` makes charabia fold hamza and ta-marbuta at query time; `matchingStrategy: "all"`
stops the split-off definite article `ال` from matching the whole corpus (the default `last`
returns ~99% of documents for any query starting with `ال`). `minWordSizeForTypos.oneTypo: 4`
in `meilisearch-settings.json` keeps short Arabic roots typo-tolerant (`الطلاك` → `الطلاق`).

The browser only ever holds a search-only key (actions `search`, index `cues`); the admin key
stays in `.env`.

## Homepage numbers

The `محتوى المنصة` section (six cards + the two Chart.js canvases) is computed at build time from
`data/`, so it moves with `pnpm ingest` and needs no runtime query. Chart.js is a lazy chunk: it
downloads only when the section scrolls into view, and repaints on the theme toggle because every
colour is a scriptable option reading the CSS custom properties. The section hides itself, in CSS,
as soon as the search box holds a query.

## Not in this build

Everything in the PRD's v1 scope is here. The four articles archive.org never captured cleanly
are the only known gap in the corpus.
