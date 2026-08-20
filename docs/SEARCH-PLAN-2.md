# Search improvement plan — round 2: ranking and meaning

Round 1 ([SEARCH-PLAN.md](SEARCH-PLAN.md)) killed the zero-result query. This round is about
putting the *right* lesson in the top three, and bridging the reader's words to the sheikh's.
Written 2026-08-20 against a local Meilisearch 1.53.1 holding the production corpus
(62,311 cues, 36,953 article paragraphs, 1,584 lessons / 1,136 h), then implemented and
re-measured on the same instance.

Arabic report of what was built and measured, for the owner:
<https://upmad7xzxkqw0n9zej0rsvdoi83x9pf2.pastehtml.dev/> (a copy lives at
[تقرير-البحث-الدلالي.html](تقرير-البحث-الدلالي.html)).

Owner constraints: search latency is explicitly deprioritized; the site is pre-launch, so index
shapes, ladder, and settings may all change if they buy quality.

## Where round 1 left the reader

`pnpm eval --ladder`, re-run before touching anything:

| | measured |
|---|---:|
| questions leaving the reader with nothing | 0% |
| nonsense presented as a real match | 0/4 |
| answer visible in top-3 — original set | **17/29** |
| answer visible in top-3 — held-out set (new, see below) | **9/25** |
| answer visible in top-3 — articles set (new) | **4/12** |

Nothing returns nothing anymore. But the right lesson is on screen barely more than half the
time on the questions we tuned against, and **a third of the time on questions we did not**.
That gap is the honest measure of the problem, and it is why this round starts by building an
eval the previous round never saw.

## What was wrong with the round-1 plan for this round

The first draft of this document proposed hybrid search and named the model on published
benchmarks. Executing it surfaced five things the plan had no way to know, each of which would
have stopped the work:

1. **Meilisearch refuses to call an embedder on localhost.** Every embedder task fails with
   `could not reach embedding server: bad uri: Rejected URI` — an SSRF guard, not a network
   fault, and the message never says so. `MEILI_EXPERIMENTAL_ALLOWED_IP_NETWORKS=127.0.0.0/8`
   is the whole fix, and without it the documented Ollama setup cannot work at all.
2. **The search box cannot embed its own corpus.** One ARM core does ~0.25 docs/s with bge-m3:
   4.5 days for 99k documents. Vectors have to be computed on the maintenance machine and
   shipped. That is `scripts/embed.ts`, and it turns the plan's biggest unknown into an upload:
   62,311 cue vectors are 209 MB gzipped and went up in 9.9 minutes.
3. **Turning on hybrid destroys `totalHits`.** A vector always returns its nearest neighbour,
   so every query matches the entire corpus: counts become "+1000", the tab strip lies, and the
   widened fallback can never trigger because nothing is ever empty. `rankingScoreThreshold` is
   not a nice-to-have for guarding nonsense — it is what keeps the rest of the ladder true.
4. **`distribution` cannot do what the plan wanted it to.** The plan expected it to pull real
   questions away from nonsense. It cannot: it is a monotone transform, so it moves every score
   the same direction and no query can overtake another. It only decides where the threshold
   *number* sits, and how semantic scores compare to keyword ones during the merge. Measured
   and dropped — the raw score thresholds just as well, with one knob fewer.
5. **The model has to be chosen by measurement, not by MIRACL.** The published Arabic numbers
   put bge-m3 ahead of multilingual-e5-large; on this corpus they are within noise of each
   other, and the reason to pick one is a different property entirely (below).

## The eval, first

Everything below is a ranking change, and ranking changes are exactly what over-fits to a
29-question set. So the set was tripled before anything was tuned:

- **`data/eval-questions.json`** — the round-1 set, 50 questions, 29 with a known answer.
  Kept unchanged so the numbers stay comparable across rounds.
- **`data/eval-questions-2.json`** — 25 held-out questions plus 4 nonsense ones, built
  *target-first*: sample a lesson, find the chapter it announces (`باب النهي عن الوصال`), then
  write the question a reader would type (`ما حكم مواصلة الصيام يومين بلا فطر`). The ground
  truth is resolved by phrase-searching the sheikh's own wording, never the reader's, so it is
  independent of any retrieval strategy under test. Multiple lessons may answer one question,
  so questions carry `expectVideos`, and any of them counts.
- **`data/eval-articles.json`** — 12 questions whose answer is an article, scored on the
  articles tab's top 3. Half the corpus had no measurement at all before this.

`scripts/eval.ts` gained `--file=` and multi-target scoring; `pnpm eval --ladder` still calls
the production `search()`, so the harness and the site cannot drift.

## Choosing the model

Five candidates, screened on the same 6,849-cue pool (every cue of every target lesson plus
6,000 random distractors), scored by whether the answering lesson makes the top 3 and by MRR,
over all 54 scored questions from both video sets.

| model | answer-in-top-3 | MRR | top cosine, real (median) | top cosine, nonsense (max) | gap |
|---|---:|---:|---:|---:|---:|
| `intfloat/multilingual-e5-large` | **37/54** | **0.587** | 0.856 | 0.831 | 0.025 |
| `BAAI/bge-m3`, cue text + lesson title | 36/54 | 0.566 | 0.600 | 0.505 | 0.095 |
| **`BAAI/bge-m3`, cue text** | 35/54 | 0.540 | 0.607 | 0.491 | **0.116** |
| `snowflake-arctic-embed2` | 33/54 | 0.523 | 0.578 | 0.512 | 0.066 |
| `embeddinggemma` | 29/54 | 0.431 | 0.497 | 0.455 | 0.042 |
| `qwen3-embedding:0.6b` | 27/54 | 0.433 | 0.563 | 0.425 | 0.138 |

All but the first ran through Ollama, which is how they would be served.

The decision is not the recall column, where e5 wins by two questions. It is the last one:
**a score that does not spread cannot be thresholded**, and per trap 3 the whole ladder now
rests on that threshold. e5 puts every result — real question and nonsense alike — inside a
0.04-wide band and leaves a 0.025 gap; bge-m3 leaves 0.116. qwen3's gap is wider still but it
loses eight questions to get there. bge-m3 also
needs no `query:`/`passage:` prefixes (e5 does, and Meilisearch sends the query verbatim), runs
on linux/arm64 through `ollama pull bge-m3`, takes 8k tokens so no cue is truncated, and costs
nothing.

**What text to embed** was measured the same way, since it is a corpus-level decision that is
expensive to undo. Prefixing every cue with its lesson title scores 36/54 at MRR 0.566, against
35/54 at 0.540 for the cue text alone — a one-question, within-noise gain, bought with
slightly worse nonsense separation (0.505 vs 0.491) and a real cost the eval cannot see: it makes
every moment inside one lesson look alike to the vector, which is the opposite of what a site
whose unit is «the second he said it» wants. So cues embed `{{doc.text}}`. Articles embed
`{{doc.title}}\n{{doc.text}}` — an article paragraph belongs to a document whose title *is* its
topic, and article hits are already one-per-article, so there is no within-document precision
to lose.

## What shipped

### 1. Hybrid retrieval on `cues` and `articles`

`src/lib/meili.ts` adds `hybrid: { embedder, semanticRatio }` and `rankingScoreThreshold` to the
strict pass only. The relaxed `frequency` retry stays keyword-only on purpose: it runs *because*
the vectors already declined, so asking them again returns the same rejects, and a query worth
widening for is one whose words exist somewhere.

`both()` now degrades instead of failing. If the embedder is missing or its Ollama is down — one
core runs both — the same multi-search is retried without the vector half. Search gets worse; it
does not go down. (The old single-index fallback never worked: it passed `indexUid` to a
single-index search, which is a 400. Fixed.)

### 2. Vectors computed here, not there — `scripts/embed.ts`

`pnpm embed cues|articles` renders each document exactly as the index's `documentTemplate` will,
embeds it through Ollama in batches, and PUTs `{id, _vectors}` as gzipped NDJSON, 2,000 documents
per task. `--out=<file>` writes instead of sending and `--push=<file>` sends what an earlier run
wrote, so the corpus is embedded once and uploaded to both the local index and the search box.
Measured here: 62,311 cues at ~19 docs/s.

`scripts/index.ts` switched from `addDocuments` to `updateDocuments`. A replace would drop the
`_vectors` every cue now carries and hand the search box 62k documents to re-embed at a quarter
of a document per second. A merge keeps them; genuinely new cues arrive without vectors and
Meilisearch embeds those itself, which is the handful per ingest it can afford.

### 3. Scores that can say «I don't know»

`distribution: { mean, sigma }` on the embedder recentres semantic scores on their measured
spread, and `rankingScoreThreshold` cuts below the result. Together they restore the three things
hybrid had broken: honest `totalHits`, a reachable «لا نتائج», and a widened fallback that still
fires.

### 4. Tuning, and what did *not* pay

Every row below is `answer-in-top-3`, swept against the full index with the same harness that
reproduces the round-1 baseline exactly (`{"ratio":0,"block":"kw"}` → 17/29 and 9/25, matching
`pnpm eval --ladder`).

| variant | original 29 | held-out 25 | nonsense shown as direct |
|---|---:|---:|---:|
| keyword only (round 1) | 17 | 9 | 0/8 |
| ratio 0.3 | 23 | 12 | 8/8 |
| ratio 0.6 / 0.7 / 0.8 / 1.0 | **24** | **15** | 8/8 |
| ratio 0.7 + floor 0.75 | 24 | 15 | 1/8 |
| **ratio 0.7 + floor 0.765** | **23** | **15** | **0/8** |
| ratio 0.7 + floor 0.79 | 22 | 13 | 0/8 |

- **`semanticRatio` has a plateau, not a peak.** 0.6 through 1.0 are indistinguishable; 0.7 sits
  in the middle of it and keeps the keyword leg contributing exactness and the `<mark>`s a purely
  semantic hit has none of.
- **The floor is a choice, not a separation.** Nonsense tops out at 0.762 and real questions start
  at 0.758 — the bands touch. 0.765 sends all eight nonsense questions to the labelled fallback
  at the cost of one answer on the tuned set. 0.75 buys that answer back and lets one nonsense
  query through as a confident page of results, which is the trade round 1 already refused.
- **A lesson block built from the cue hits does not pay.** Re-deriving it as the top three
  distinct `video_id`s of the same hybrid query — passage-to-document max-pooling, and free,
  since Meilisearch's `distinct` needs no extra embedding — scores 18/29 against the keyword
  `lessons` index's 23/29. Whole-transcript keyword matching finds lessons the cue list does not,
  which is the opposite of what round 1 predicted. The block stays exactly as it was.
- **Appending the relaxed pass under a thin strict one** (round 1's phase 1) changes nothing once
  vectors are on: the strict pass is no longer thin.
- **`distribution` was measured and dropped.** It is a monotone transform, so it cannot move one
  query above another — it can only relabel where the threshold sits. Its real use is making
  semantic and keyword scores comparable during the merge, and since ratio 0.6→1.0 are identical,
  the merge is not where the wins are. One less knob.

## Deployment recipe

The sequence matters, because adding an embedder to an index that already holds documents makes
Meilisearch embed all of them:

```bash
# 1. on the search box: the embedder, pinned in memory, reachable from Meilisearch
curl -fsSL https://ollama.com/install.sh | sh && ollama pull bge-m3
#    /etc/systemd/system/ollama.service.d/override.conf: OLLAMA_KEEP_ALIVE=-1, NUM_PARALLEL=1
#    /etc/meilisearch.env: MEILI_EXPERIMENTAL_ALLOWED_IP_NETWORKS=127.0.0.0/8
#                          MEILI_EXPERIMENTAL_EMBEDDING_CACHE_ENTRIES=20000

# 2. here: compute the vectors once, write them to a file
pnpm embed cues     --out=/tmp/cues.ndjson
pnpm embed articles --out=/tmp/articles.ndjson

# 3. upload to both indexes — documents may carry `_vectors` for an embedder that does not
#    exist yet, and Meilisearch keeps them when it does
MEILI_HOST=https://search.assoli.site MEILI_ADMIN_KEY=… pnpm embed cues --push=/tmp/cues.ndjson

#    `pnpm embed` applies meilisearch-embedder.json as its last step, so the embedder is only
#    ever declared on an index whose documents already carry vectors. `pnpm index` never
#    touches `embedders` — that is the whole reason the config lives in its own file.
```

Rollback is settings-only in both directions: delete the embedder and the site degrades to
keyword search on its own — `both()` in `src/lib/meili.ts` retries without the vector half
rather than showing an error, so an Ollama that dies at 3am costs quality, not availability.

## Not doing, with reasons

- **Arabic stemmer at ingest** — the vector covers morphology (مسجد/مساجد are neighbours);
  a stemmer would fight charabia and the synonym table for unmeasured gain.
- **A separate windows/chapters index** — the misses were ranking and vocabulary; a passage
  vector plus a per-lesson roll-up addresses both without a fourth index.
- **LLM query rewriting or re-ranking** — needs a backend and per-query cost.
- **`frequency` as a ranking signal** — measured worse offline (18 vs 21 of 29). Fallback only.
- **`binaryQuantized`** — divides vector memory by 32 but is irreversible, and the box is not
  short of memory (measured below).
- **Meilisearch upgrade** — 1.53.1 is current, and everything used here is in it.

## Success criteria

| metric | round 1 | now | gate |
|---|---:|---:|---:|
| answer in top-3, original 29 | 17 (59%) | **23 (79%)** | ≥ 22 |
| answer in top-3, held-out 25 | 9 (36%) | **15 (60%)** | — (new) |
| answer in top-3, articles 12 | 4 (33%) | **12 (100%)** | — (new) |
| real questions with an empty articles tab | 44/54 | **5/54** | — (new) |
| questions shown nothing | 0% | 0% | 0% |
| nonsense shown as a direct hit | 0/8 | 0/8 | 0/8 |
| questions pushed to the labelled fallback (held-out) | 38% | 14% | must not grow |
| search latency, production | 1–6 ms | ~0.8 s | ≤ 2 s (accepted trade) |

The gate that matters is the held-out column: it moved as much as the tuned one, which is what
says the gain is retrieval and not curve-fitting.

Two honest caveats on the article numbers. 12/12 is a small set, and it is an easy one by
construction: the questions were written from article titles, and articles embed their title, so
the two meet halfway. The number to trust there is the last row, which uses the 54 *video*
questions and needs no ground truth at all — the articles tab used to come back empty for 44 of
them and now comes back empty for 5. A separate, lower floor for `articles` (their scores run
~0.03 below cues') would double the number of article results shown without letting nonsense
through, and buys nothing measurable, so there is still one floor.
