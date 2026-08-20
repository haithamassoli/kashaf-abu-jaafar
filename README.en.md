<div align="center">

<img src="public/app-icon.png" width="88" alt="">

# Kashaf Abu Jaafar — كشّاف أبي جعفر

**Full-text search over the lectures and articles of Sheikh أبو جعفر عبد الله بن فهد الخليفي**

Arabic-only, RTL, no login, no database.

[![Site](https://img.shields.io/badge/site-kashaf--alkulify.assoli.site-1f6f4a)](https://alkulify.assoli.site)
[![Astro](https://img.shields.io/badge/Astro-5-BC52EE?logo=astro&logoColor=white)](https://astro.build)
[![Meilisearch](https://img.shields.io/badge/Meilisearch-1.53-FF5CAA?logo=meilisearch&logoColor=white)](https://www.meilisearch.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

[العربية](README.md) · [Product spec](docs/PRD.md)

</div>

---

## What it is

Lectures from [@Alkulify1](https://www.youtube.com/@Alkulify1) are transcribed offline, the sheikh's
articles are scraped from his blog, and both are indexed into Meilisearch. Type a phrase, get the
moments it was said, click once to open the video at that second.

- **Two tabs, videos and articles**, each with its own hit count; playlist filter on the videos tab.
- **A hit is a ~30 s transcript cue** that opens the player at its timestamp, or an article paragraph
  that opens the article scrolled to it.
- **Interactive transcript** beside the player: auto-follow of the current line, in-lecture search,
  copy a link to any line.
- **No search backend**: the browser queries Meilisearch directly with a search-only key, and every
  page is statically built.
- Light/dark, mobile-first, keyboard and screen-reader support.

## Screenshots

| Home and search | Articles tab |
|---|---|
| <img src="shots/01-home-search-light.png" alt="Home page with results for «كفارة اليمين»"> | <img src="shots/10-articles-tab-light.png" alt="Article results with highlighted matches"> |

| Lecture page: player + transcript | In-lecture search |
|---|---|
| <img src="shots/02-video-light.png" alt="Lecture page with player, interactive transcript, current line highlighted"> | <img src="shots/03-video-filter-marks.png" alt="Transcript filtered by a word with matches highlighted"> |

| Article page | Light / dark |
|---|---|
| <img src="shots/11-article-target.png" alt="Article page with the target paragraph highlighted"> | <img src="shots/07-light-marks.png" alt="Light theme"><br><img src="shots/06-dark-marks.png" alt="Dark theme"> |

<details>
<summary>On mobile</summary>

| Lecture | Articles |
|---|---|
| <img src="shots/08-mobile-video.png" width="300" alt="Lecture page on mobile"> | <img src="shots/13-articles-mobile.png" width="300" alt="Article results on mobile"> |

</details>

## How it works

```
YouTube ──▶ tafrigh (YouTube captions, wit.ai fallback) ──┬─▶ <id>.chunks.ndjson ──▶ Meilisearch (cues)
                                                          └─▶ <id>.transcript.json ─▶ data/ ─┐
                                                                                              ├─▶ Astro (static)
Blogger feed + archive.org ──▶ scripts/articles.ts + wayback.ts ──▶ data/articles/ ───────────┘
                                                                 └──▶ Meilisearch (articles)
```

Transcription and indexing run on the maintainer's machine, never on a server. The repo carries
`data/` (the build snapshot); Meilisearch carries the search documents.

## The corpus (current `data/` snapshot)

| | |
|---|---|
| Lectures transcribed | 1,584 (≈1,136 h) — out of ~4,000 on the channel, ongoing |
| Cues indexed | 62,311 |
| Articles | 3,333 (≈37k paragraphs) |
| Playlists | 43 |

## Run it locally

```bash
pnpm install
cp .env.example .env                 # RAW_DIR = tafrigh's output dir

brew install meilisearch ollama      # production uses compose.yml on a VPS
MEILI_EXPERIMENTAL_ALLOWED_IP_NETWORKS=127.0.0.0/8 \
MEILI_EXPERIMENTAL_EMBEDDING_CACHE_ENTRIES=20000 pnpm meili &   # db in git-ignored ./data/
ollama serve & ollama pull bge-m3    # the embedding model, local and free

pnpm ingest                          # data/ snapshot + Meilisearch index; prints the search-only key
                                     # paste it into PUBLIC_MEILI_SEARCH_KEY in .env
pnpm embed cues && pnpm embed articles   # semantic vectors (~1.5 h on an M3)
pnpm dev                             # http://localhost:4321
```

Without tafrigh output, `pnpm dev` alone still browses the site off the committed `data/`; only
search needs Meilisearch.

### Scripts

| script | what it does |
|---|---|
| `pnpm data` | `RAW_DIR/*.transcript.json` → `data/{videos,playlists}.json` + `data/segments/<id>.json` |
| `pnpm articles` | Blogger Atom feed → `data/articles/<id>.json` |
| `pnpm index` | cues + articles → Meilisearch, and creates/reuses the browser's search-only key (`pnpm index cues\|articles` does one side) |
| `pnpm embed` | vectors for one index, uploaded, then the embedder declared (`pnpm embed cues`); `--out=`/`--push=` compute once and upload to both the local index and the search box |
| `pnpm ingest` | all three, in order |
| `pnpm eval` | the fixed question sets against the live index; `--ladder` runs the production `search()` |
| `pnpm check` | self-checks for the text plumbing (highlighting, folding, cleaning, formatting) |
| `pnpm build` / `preview` | static build of every page / serve `dist/` |

All steps are safe to re-run. `pnpm data` rebuilds `data/` from scratch, so a lecture removed from
`RAW_DIR` also disappears from the next build. `pnpm index` overwrites cues by `id` and only deletes
cues whose text cleaned to empty — to drop a lecture from the index, delete by filter
(`videoId = "<id>"`).

## Arabic search

Retrieval is two layers in one request (`src/lib/meili.ts`): a strict keyword pass
(`matchingStrategy: "all"`, `locales: ["ara"]`) and a semantic pass over bge-m3 vectors, merged
by Meilisearch into one ranked list, then cut by a score floor. Below the floor the query falls
back once to `frequency`, labelled as a loose match rather than passed off as an exact one.

```json
{ "q": "بر الوالدين", "locales": ["ara"], "matchingStrategy": "all",
  "hybrid": { "embedder": "default", "semanticRatio": 0.5 },
  "rankingScoreThreshold": 0.5 }
```

The semantic half is what bridges the reader's words to the sheikh's: someone asking
«هل للصداق حد أعلى» shares no word with the lesson that answers them, because he discussed it
inside the chapter on خلع.

- `locales` makes charabia fold hamza and ta-marbuta at query time; without it the same word
  spelled two ways is two words.
- `matchingStrategy: "all"` stops the split-off definite article `ال` from matching the whole
  corpus (the default `last` returns ~99% of documents for any query starting with `ال`).
- **The score floor is not optional.** A vector always returns its nearest neighbour, so without
  `rankingScoreThreshold` every query matches the entire corpus: counts stop meaning anything,
  "no results" becomes unreachable, and the labelled fallback can never fire. `distribution` on
  the embedder is what makes the floor tunable — raw cosine puts every result inside one
  0.04-wide band.
- **Vectors are computed on the maintenance machine, not the server.** One ARM core does ~0.25
  docs/s; this laptop does ~19. `pnpm embed cues` computes them, PUTs them with
  `regenerate: false` so Meilisearch keeps them, and only then declares the embedder — which is
  why that config lives in `meilisearch-embedder.json` and never in the index settings
  `pnpm index` applies. The server only embeds the query (~0.55 s, 0.25 s cached).
- **A dead embedder does not take search down**: `both()` retries the same multi-search without
  the vector half.
- `minWordSizeForTypos.oneTypo: 4` keeps short Arabic roots typo-tolerant (`الطلاك` →
  `الطلاق`); typo tolerance is off on `lessons`, where it dragged `محرم` to 94% of the corpus.

Three fixed question sets measure it, the last two held out from any tuning:

```bash
pnpm eval --ladder                                   # 29 verified questions (round-1 set)
pnpm eval --ladder --file=data/eval-questions-2.json # 25 held-out + 4 nonsense
pnpm eval --ladder --file=data/eval-articles.json    # 12 whose answer is an article
```

`--ladder` calls the production `search()`, so the harness and the site cannot drift.

The browser only ever holds a search-only key (action `search`, indexes `cues`, `articles`,
`lessons`); the admin key stays in `.env`.

## Articles

`alkulify.com` (WordPress, the sheikh's own site) has been answering Cloudflare 522 since ~2026-07,
so the corpus is assembled from the two sources that do answer:

```bash
pnpm articles                        # Blogger mirror: 2,346 posts, but it stops at 2019-06
npx tsx scripts/wayback.ts           # archive.org snapshots of alkulify.com, through 2026
```

`wayback.ts` reads the CDX index, pulls the newest usable capture of every archived post (falling
back through older captures when one is a Cloudflare interstitial), and finishes by deleting the
Blogger copy of every post the site itself covers. It logs finished URLs to `data/wayback-done.txt`,
so an interrupted run resumes where it stopped. Result: 3,333 articles (3,232 `wp` + 101
Blogger-only), ~37k paragraph chunks. Four posts are unrecoverable — their only capture is an
interstitial — and are listed in `data/wayback-failed.txt`.

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

It takes the channel's own Arabic caption track when there is one (~2000× real time) and falls back
to wit.ai when there is not (~8× real time per token, linear in the number of tokens). Use
`.venv312`, not `.venv`: the wit path is broken on Python 3.14 (`pydub` → removed `audioop`).

Each lecture yields `<id>.chunks.ndjson` (index-ready search cues, already overlapping and capped at
30 s) and `<id>.transcript.json` (fine-grained segments + video metadata, which is what the site's
transcript panel and `data/` are built from).

## Deployment

- **Frontend**: Vercel, auto-deploying on every push to `main`. The build is static, so `PUBLIC_*`
  vars are baked at build time — changing one needs a redeploy, not just a settings save.
- **Search**: self-hosted Meilisearch behind Caddy (automatic TLS) on a small VPS, with Ollama
  beside it holding `bge-m3` to embed the query and nothing else — `compose.yml` describes it.
- **Indexing**: from the maintainer's machine straight at the remote host; `scripts/index.ts` is
  idempotent.
- **Two server settings, both mandatory, both failing obscurely without them**:
  `MEILI_EXPERIMENTAL_ALLOWED_IP_NETWORKS=127.0.0.0/8` — otherwise Meilisearch refuses to call an
  embedder on loopback with `bad uri: Rejected URI` — and
  `MEILI_EXPERIMENTAL_EMBEDDING_CACHE_ENTRIES=20000`, which makes a repeated query free and the
  second query of a multi-search free.
- **Vectors before the embedder**: `pnpm embed … --push=` first, and it declares the embedder as
  its last step. Declaring it on an index without vectors starts a backfill one ARM core needs
  4.5 days to finish.

> `pnpm deploy` is a leftover from the Cloudflare Pages setup that predated Vercel; it is unused.

## Layout

```
scripts/      data pipeline: build-data · articles · wayback · index · selfcheck
src/pages/    home · /v/[id] lecture · /a/[id] article · /p playlists
src/islands/  the two React islands: Search and Player (player + transcript)
src/lib/      text cleaning/normalizing/highlighting, Meilisearch client, build data, SEO
data/         build snapshot: videos · playlists · segments/ · articles/
docs/PRD.md   product spec
```

## Contributing

Issues and PRs are welcome — the most useful reports are a bad transcript line or a strange search
result with the page URL. Run `pnpm check` before pushing.

## License and content

The code is [MIT](LICENSE). The sheikh's lectures, articles, and their transcripts belong to their
owners and are not covered by the code license.

## Credits

[tafrigh](https://github.com/ieasybooks/tafrigh) for transcription, [baheth](https://baheth.ieasybooks.com)
for the idea, [Meilisearch](https://www.meilisearch.com) and charabia for Arabic normalization.
