# Search improvement plan

Measured against the live index on 2026-08-20: Meilisearch 1.53.1, 62,311 cues,
36,953 article paragraphs, 1,584 lessons (1,136 h), 3,333 articles.

Arabic diagnosis report: https://kdqucupra7voiohphpqsbi2mqp019rw4.pastehtml.dev/
Arabic implementation report: https://iey6zfk6d2b1y95j1q2z3s2nsoek1y4k.pastehtml.dev/

## The problem in one number

**10 of 25 realistic questions return zero results. 16 of 25 return fewer than five.**

The content is there. `الفاتحة خلف الإمام` → 41 hits. Prefix it with `حكم` → 0.
`matchingStrategy: "all"` requires every token — including `ما`, `هل`, `يجوز` — to
occur inside one cue. Every extra word multiplies the odds of zero.

The alternative is not a fix: `matchingStrategy: "last"` returns 44,283 of 62,311
cues (71% of the corpus) for `ما حكم شرب الدخان`. Today the choice is nothing or
everything.

## Secondary findings

| Finding | Measurement |
|---|---|
| Indexed cue is ~3× the spec | median 83 s / 148 words; 86% exceed 60 s; only 13% are ≤35 s. PRD says ≤30 s. |
| Mixed granularity skews ranking | 13% short cues compete with 86% long ones; long cues satisfy conjunctive queries more often and win structurally. |
| No Arabic morphology | `مسجد` 3,445 vs `مساجد` 1,671 — unrelated tokens. `صام` / `الصيام` / `صائم` likewise. |
| Synonym table is a patch, not a stemmer | 13,352 stems / 23,535 spellings shipped as index settings; 383 stems are ≤2 letters (`ا` → والا, للا, بالا). Rebuilt on every corpus growth. |
| Hybrid search is available, unconfigured | Probe returns `Cannot find embedder with name 'default'` — the feature exists on 1.53.1, only the embedder is missing. |
| Query dropped at click | Cards link to `/v/<id>/?t=<start>`; `Player.tsx` reads only `t`. User lands inside an 83 s window of a 42-minute lesson with an empty in-lesson search box. |
| Two silos | `federation` in `multi-search` works (tested, returns one ranked list across both indexes). UI runs two separate queries with `hitsPerPage: 0` on the inactive tab. |
| Filters declared, unused | `upload_date`, `channel`, `type`, `source`, `categories` are filterable; `upload_date`, `date`, `start` sortable. UI exposes the playlist filter only, on the videos tab only. |
| Zero results is a dead end | `لا نتائج لـ …` and nothing else. No relaxed retry, no suggestion, no note that 61% of the channel is not transcribed yet. |
| 1,000-hit ceiling | `maxTotalHits: 1000`. `الصلاة` has 9,358 cues; 8,358 unreachable by any paging. |
| No query logging | No data on what users search or which queries come back empty. Every tuning decision after this is a guess without it. |

## Simulation that decides the roadmap

Question: what if the retrieval unit were a whole lesson instead of an 83-second window?
Built the lesson-level bag of words from `data/segments/` and asked how many lessons
contain every query token anywhere.

| Question | Today | Lesson-level |
|---|---:|---:|
| هل يجوز الدعاء بعد الصلاة جماعة | 0 | 109 |
| متى يبدأ وقت صلاة الفجر | 0 | 32 |
| هل يجوز السفر بلا محرم | 0 | 22 |
| حكم قراءة الفاتحة خلف الإمام | 0 | 18 |
| ما الفرق بين الفرض والسنة | 0 | 13 |
| حكم لبس الذهب للرجال | 0 | 8 |
| هل الدخان حرام | 0 | 6 |
| هل تجب الزكاة في الراتب | 0 | 4 |
| كيف أصلي صلاة الاستخارة | 0 | 1 |
| ما حكم بيع التقسيط | 0 | 1 |

**10 of 13 currently-failing questions are rescued by a second index of 1,584 documents.**
The remaining three (المولد, الأغاني, التصوير الفوتوغرافي) fail on vocabulary mismatch —
the user says الأغاني, the sheikh says الغناء. Those need semantics, not lexical tuning.

## Status — implemented and measured 2026-08-20

Everything below the "Phases" heading is the original plan. This section records what actually
shipped and what the numbers did. Reproduce any of it with `pnpm eval` / `pnpm eval --ladder`.

### The headline

`pnpm eval --ladder` runs the real `src/lib/meili.ts` `search()` over the 50-question set and
records what a reader ends up seeing:

| | before | after |
|---|---:|---:|
| questions leaving the reader with nothing | 56% (28/50) | **0%** |
| answer visible in the top results | 9/29 | **17/29** |
| nonsense presented as a real match | — | **0/4** |
| answered with a direct timestamp hit | 44% | **56%** |
| rescued by the lesson block | — | 30% |
| fell through to a labelled "widened" retry | — | 14% |

"Before" is `cues` under `matchingStrategy: all`, which is what the site did. All ten of the
originally-dead questions now resolve — four of them with direct cue hits, i.e. an actual
timestamp rather than a lesson to go hunt through.

### What shipped

- **Escalation ladder** (`src/lib/meili.ts`). Strict `all` pass on cues + articles, with a
  concurrent lesson-level query. If nothing is *shown*, one relaxed `frequency` retry, labelled
  in the UI as `لم نجد تطابقًا تامًّا`. Widened results are capped to one page — a loose match
  has no meaningful tail.
- **`lessons` index** (`scripts/index.ts`, `meilisearch-lessons-settings.json`). One document per
  video, whole transcript searchable, `text` never displayed. 1,584 docs, 574 MiB.
- **Query carried into the lesson page.** Result links are `/v/<id>/?t=<s>&q=<query>`; the lesson
  page pre-fills its in-lesson filter and seeks to the first matching fine segment.
- **Article type filter** (`مقالات / فتاوى / كتب`) as chips on the articles tab, in the URL as `ty`.
- **Empty state that helps**: advice to drop words, a note that filters may be hiding the answer,
  and that ~61% of the channel is not transcribed yet — a zero often means "not yet", not "never said".
- **`pnpm eval`** — 50 grounded questions, 29 with a verified `expectVideo`. `--ladder` measures
  the production path; `--strategy=`/`--index=` compare in isolation; `--json` diffs two runs.

### Calibration decisions, each backed by a measurement

- **Typo tolerance off on `lessons`.** At lesson scale `oneTypo: 4` was destructive: `محرم`
  reached 94% of the corpus, `الراتب` 54%. Off, they fall to 27% and 7%, flood drops 24%→10%,
  nonsense violations 2/4→0/4, and answer-in-top-3 is unchanged. It was inflating the tail, and
  the tail is what the block's ceiling reads. Left ON for `cues`, where finding a phrase needs it.
- **Lesson block ceiling of 300 (~19% of the corpus).** Real questions land at 3–13% of lessons;
  `الصلاة` hits 95% and `حكم الصلاة` 66%. Above the ceiling the block says nothing, so it is
  dropped and the widened retry runs instead.
- **Stop words: interrogatives only** (`ما هل كيف متى أين لماذا ماذا` + demonstratives).
  Deliberately NOT `من/على/في/عن` — they carry meaning in hadith text (`المسح على الخفين`).
  Worth +1/29 on answer-in-top-3 and flips `كيف تصلى صلاة الجنازة` from 0 to 18 hits.
- **Domain synonyms** (`data/domain-synonyms.json`, 76 keys / ~52 concepts), every entry verified
  by document frequency over the corpus, not written from general Arabic. Rejections were the
  point: `المذي→المني`, `الاستحاضة→الحيض`, `الدف→المعازف` all blur a real fiqh distinction, and
  `العطر→الطيب` fails because `طيب` reaches 98% of lessons as an adjective. `تحديد النسل→العزل`
  was caught only by reading concordances — in this corpus `العزل` is overwhelmingly عزل الحاكم.
- **Reverse prefix synonyms** (`src/lib/normalize.ts`). The auto table mapped stem → prefixed
  spellings only, and Meilisearch synonyms are one-way, so a reader writing the natural phrasing
  `الاستماع للأغاني` queried a token with no key at all — `للاغاني` matches 0 cues while `اغاني`
  matches 1,158. Emitting the reverse too costs 13,438 → 36,952 synonym keys (a settings-only
  update, ~15 s) and buys +4pp direct hits and −4pp cue zero rate at identical top-3 quality.
  A/B'd both ways before keeping it.
- **`frequency` is a fallback, never the default.** On cues it is not a flood — largest result
  set is 3,445 of 62,311 (5.5%) — but it makes "no results" stop being information: all four
  `expect: none` questions start returning hits. On `lessons` it floods 48% of the corpus, so
  the lesson query always uses `all`.

### Considered and rejected, with the evidence

- **Re-ranking the lesson block by cue density.** Tested head to head: better on
  `حكم قراءة الفاتحة خلف الإمام`, worse on `هل تجب الزكاة في الراتب` (it lost the lesson titled
  `كتاب الزكاة`). A wash, for two extra round trips and a re-ranking layer. Not shipped.
- **Hybrid/semantic search.** The server supports it (`Cannot find embedder with name 'default'`
  is a config error, not a capability error), but a `lessons` document is a ~9,000-word transcript,
  far past any embedder's context window, so its vector would reflect only the opening minutes.
  Embedding all 62,311 cues is not justified by the handful of remaining vocabulary gaps; curated
  synonyms cover those for free. Revisit only if `data/domain-synonyms.json` proves insufficient.
- **Re-cutting cues to the 30 s spec.** Still not worth re-processing 62,311 documents — carrying
  `q` into the lesson page buys the same precision from `data/segments/`, which was already on disk.
- **Sort by date.** `sort` sits after the relevance rules in `rankingRules`, so a date sort would
  not actually reorder without changing ranking for every query. For a single-scholar fiqh corpus
  the recency of a ruling is close to meaningless. Skipped.
- **Query logging.** The site is a static build with no backend; adding a serverless endpoint for
  analytics is real complexity that serves the maintainer, not the reader. `pnpm eval` is the
  measurement instrument instead. Revisit if a backend appears for another reason.

### Known remaining gap

**Ranking, not recall.** Answer-in-top-3 is 17/29 — the right lesson still misses the top three
about half the time. Zero results were the loud problem and they are gone; this is the quiet one
that is left. `proximity` is close to meaningless inside a 9,000-word document, which is the root
cause. Next lever worth measuring is a cue-density signal folded into ranking rather than bolted
on as a re-rank, or per-attribute weighting once Meilisearch exposes it.

## Phases

Ordered by measured return per unit of work. Each phase ships on its own and is
reversible.

### Phase 1 — no re-index, no new data

**1.1 Zero-result fallback** (`src/lib/meili.ts`)
When `all` returns 0 hits, re-run the same query with `matchingStrategy: "frequency"`
and label the results as widened. `frequency` drops the least-frequent term first,
which is the opposite of what we want semantically but empirically recovers every one
of the ten dead questions.

- One extra round trip, only on the zero path, so the hot path is untouched.
- Surface it: `لا نتائج لـ "…" — هذه أقرب ما وجدنا` above the widened set.
- Guard: keep the widened set to page 1 only. A widened query has no meaningful tail.
- Check: assert the ten questions in `scripts/selfcheck.ts` return >0 through the
  fallback and that a query with real `all` hits never takes the fallback path.

**1.2 Carry the query into the lesson** (`Search.tsx` → `Player.tsx`)
Link to `/v/<id>/?t=<start>&q=<query>`. `Player.tsx` reads `q`, pre-fills the in-lesson
filter (which already normalizes and marks via `lib/mark.ts`), and seeks to the first
matching fine segment instead of the cue start.

- Buys back the precision the 83-second window lost: median landing error 83 s → ~7 s.
- Uses `data/segments/` as it already ships. No re-transcription, no re-index.

**1.3 Query logging**
Log `{q, tab, playlists, totalHits, tookFallback, ts}` on every search. A single
endpoint or a static append is enough — the point is to stop guessing what people ask.

**1.4 Fixed evaluation set**
50 questions with the lesson id and timestamp that should answer each one. Run it
before and after every change below. Without this, phases 2–4 are unfalsifiable.

### Phase 2 — lesson-level index

New index `lessons`: one document per video, `text` = all its cue text concatenated,
plus `video_id`, `title`, `playlist_ids`, `upload_date`, `duration`.

- 1,584 documents. Build cost is a loop over `data/segments/`; index cost is trivial
  next to the 62,311-cue pass.
- Query it in the same `multiSearch` that already runs. Render above the cue results as
  `دروس تتناول سؤالك`, each entry linking to `/v/<id>/?q=<query>` — with 1.2 in place
  the lesson page pinpoints the moment itself.
- This is where the 10-of-13 rescue lands, and it degrades gracefully: if `all` hits
  nothing at lesson level either, 1.1 still catches it.

### Phase 3 — lexical tuning, measured not guessed

Only after Phase 1.4 gives a baseline.

- **Arabic stop words** for interrogatives (`ما`, `هل`, `كيف`, `متى`, `أين`, `لماذا`).
  Careful: `من` and `على` carry meaning in hadith text. Add one at a time, re-run the
  eval set, keep only what improves it.
- **Re-examine the synonym table.** Drop stems ≤2 letters — they add noise and bulk
  without reaching a real word. Consider a proper Arabic stemmer at ingest instead:
  index a `stem` field alongside `text`, which retires the 23,535-entry settings blob.
- **Federated `multi-search`** for an `الكل` tab. Tested and working; removes the
  guess-which-tab step.
- **Filters and sort**: date range and playlist on both tabs, article type/category,
  sort by newest. This is what makes the 1,000-hit ceiling livable for `الصلاة`.

### Phase 4 — hybrid semantic search

Last, because it costs the most and Phases 1–3 already cover 10 of 13.

- Configure an embedder on `lessons` first — 1,584 documents is cheap to embed and
  cheap to throw away if the quality does not justify it.
- Hybrid at `semanticRatio` ~0.3, tuned against the eval set.
- Only extend to `cues` (62,311 docs) if the lesson-level result earns it.
- This is what fixes الأغاني→الغناء and التصوير الفوتوغرافي→التصوير.

## Explicitly not doing

**Re-cutting cues to the 30-second spec.** It means re-processing 62,311 documents to
buy precision that Phase 1.2 gets from data already on disk. The wide window is also
carrying recall right now; narrowing it would make Phase 1's problem worse before
Phase 2 makes it better. Revisit only if landing error stays above 10 s after 1.2.

**Rewriting the ranking rules.** Defaults are performing: measured first-match position
in result snippets is word 2 median, word 5 at p90, so `wordPosition` is doing its job
and nothing is being clipped by `line-clamp-3`.

## Success criteria

Same 50-question set, before and after each phase.

| Metric | Today | Target |
|---|---:|---:|
| Questions returning zero | 40% | < 5% |
| Correct answer in top 3 | not measured | > 70% |
| Landing error (click → phrase) | 83 s | < 10 s |
| Response time | 1–6 ms | < 50 ms |

Response time is the one number that needs no work.

---

Arabic report: https://kdqucupra7voiohphpqsbi2mqp019rw4.pastehtml.dev/
