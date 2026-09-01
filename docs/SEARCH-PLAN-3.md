# Search improvement plan, round 3

Written on 2026-08-23 after a full code audit, direct measurements against the live site, a
local index verification, and a review of the current Meilisearch documentation and Arabic IR
research.

Arabic report: [live copy](https://42tnh2j48f4rb2ii8k89usctfk9hltzl.pastehtml.dev/) and
`docs/تقرير-تطوير-البحث-الجولة-الثالثة.html`.

## Outcome

Keep Meilisearch, BGE-M3, the Arabic locale, and the strict then labelled-widened search ladder.
The next round should make the existing system measurable, reproducible, and more relevant.
Latency is diagnostic only. It is not a release gate.

The work has four gates:

1. A fresh index can be built and swapped without losing vectors or leaving stale documents.
2. The evaluation scores the first three cards a reader actually sees and accepts every verified
   answer, not one historical video ID.
3. Relevance improves on a newly held-out set without admitting any negative query as a direct
   result.
4. Search results stop changing when the server cutoff is raised further, which shows that the
   engine completed the search instead of returning a partial set.

## Current baseline

### Corpus

| Item | Current snapshot |
|---|---:|
| Lessons | 4,691 |
| Audio | 2,553 hours |
| Search cues in source data | 133,649 |
| Cue duration | 83.9 s median, 91.6% over 60 s |
| Playlists | 109 |
| Articles | 3,370 |
| Article paragraphs | 37,086 |

The previous tuning used 1,584 lessons and 62,311 cues. Its thresholds and scores are historical
baselines, not current evidence.

### Live search, using the old labels

| Dataset | Reported by the current harness | First three rendered cards |
|---|---:|---:|
| Original video questions | 20/29 | 17/29 |
| Held-out video questions | 15/25 | 10/25 |
| Article questions | 12/12 | 12/12 |
| Negative queries shown as direct | 0/8 | 0/8 |

The harness calls the union of the first three lesson cards and first three cue cards “top 3”.
That union can contain six items. At least four current “failures” also have a different, valid
answer in the leading results, so even the rendered-card column is diagnostic rather than final
ground truth.

### Search cutoff and completeness

For `هل للصداق حد أعلى` on the live 133,649-cue index, with a warm query embedding:

| Request | Meilisearch | End to end |
|---|---:|---:|
| Current hybrid query with `rankingScoreThreshold` and page pagination | 5,002 ms | 5,253 ms |
| Same hybrid ranking, top 60 with `showRankingScore`, floor applied by the client | 49 ms | 326 ms |

The no-threshold sample kept the expected lesson first, but it only examined a bounded candidate
set. That trade is wrong for this round. Meilisearch documents that reaching `searchCutoffMs`
stops the search and returns the best results found so far, which may omit valid matches. Keep the
server-side threshold and exhaustive pagination. Raise the cutoff until result order and counts
stabilize, even if a query takes much longer than five seconds.

### Local index health

`pnpm verify` currently fails:

- `cues` has 133,965 documents but source data has 133,649. The extra 316 cues belong to 17
  removed lessons.
- `cues` has no configured embedder and zero embedded documents.
- `articles` has all 37,086 vectors, but one failed cue query makes `both()` retry both indexes as
  keyword-only. Article quality therefore falls from 12/12 to 3/12 locally.

This is useful evidence. The graceful fallback works, but it hides a broken deployment and
degrades a healthy sibling index.

## Phase 0: make index releases reproducible

Touch the existing scripts only. Do not add a deployment service.

- [ ] Make `scripts/embed.ts` declare the embedder on an empty replacement index before sending
  any `_vectors`.
- [ ] Build `cues_next` with repository settings, the pinned BGE-M3 revision, every source
  document, and every precomputed vector.
- [ ] Verify document count, embedded document count, settings, synonym count, and a hybrid smoke
  query against `cues_next`.
- [ ] Run all evaluation datasets against `cues_next`.
- [ ] Atomically swap `cues` and `cues_next` through Meilisearch's `/swap-indexes` endpoint.
- [ ] Keep the old index for one rollback window, then delete it manually.
- [ ] Rebuild `lessons` from source in the same release so vanished lesson IDs cannot survive.
- [ ] Replace the misleading `pnpm index cues` advice for count drift. A merge cannot delete an
  ID that disappeared from source.
- [ ] Compare live settings with `meilisearch-settings.json`,
  `meilisearch-articles-settings.json`, `meilisearch-lessons-settings.json`, and
  `meilisearch-embedder.json` in `pnpm verify`.
- [ ] Fail the production build when either public Meilisearch variable is empty.

Gate:

```text
source cue count == index document count == embedded document count
all three settings snapshots match
hybrid smoke query succeeds
rollback swap has been tested once
```

Pin the exact Ollama model digest used for offline document vectors and online query vectors.
Matching dimensions are not enough. Both sides must use the same model revision and settings.

## Phase 1: fix the evaluation before tuning

- [ ] Change `scripts/eval.ts` to score the ordered render list. If three lesson cards precede cue
  cards, only those three count for Hit@3.
- [ ] Rename the existing document-level metric. A matching `video_id` or `articleId` is document
  recall, not proof that the displayed passage answers the question.
- [ ] Rejudge every current failure. Add all verified answer videos and articles, including the
  four already found in the expanded corpus.
- [ ] Add `expectCueIds` or accepted timestamp ranges to at least 30 high-value questions.
- [ ] Add graded labels: 3 for a direct answer, 2 for useful context, 1 for topical proximity, 0
  for irrelevant.
- [ ] Add 40 newly held-out questions that have not informed synonyms, floors, or ratios.
- [ ] Replace most random nonsense with plausible but unanswerable religious questions. Keep a
  few random strings for parser and floor checks.
- [ ] Split reports by intent: exact phrase, natural-language question, topic exploration,
  article lookup, typo, and Arabic orthographic variant.
- [ ] Report Hit@3, MRR@3, nDCG@10, false-direct rate, empty rate, and degraded fallback rate.

Gate:

```text
the metric's first three IDs equal a DOM-order fixture
all known alternative answers are labelled
the new held-out set remains untouched until the candidate is frozen
```

## Phase 2: remove the five-second truncation

The live request reaches the configured 5,000 ms cutoff on a warm query. Meilisearch then returns
the best results found so far, not necessarily the complete result set. Since quality outranks
latency, do not replace the server-side threshold with a bounded client-side approximation.

Establish a complete-search baseline:

- [ ] Keep `rankingScoreThreshold` in Meilisearch and keep exhaustive pagination.
- [ ] Run the evaluation with cutoffs at 5, 10, 20, and 30 seconds on the replacement index.
  Keep doubling if 30 seconds still changes the results.
- [ ] Compare ordered hit IDs, totals, widened decisions, and scores at each cutoff.
- [ ] Choose the first cutoff after which another increase changes nothing, then add a safety
  margin.
- [ ] Raise the browser client timeout above that server cutoff.
- [ ] Use `showPerformanceDetails` during this experiment to confirm the search finishes.
- [ ] Keep `frequency` keyword-only and visibly labelled.
- [ ] Expose `degraded: true` when keyword fallback runs, then record and monitor it.

Gate:

```text
ordered result IDs and totals remain unchanged after one further cutoff increase
0/8 current negatives and 0 newly held-out negatives shown as direct
complete-search Hit@3, MRR@3, and nDCG@10 become the new baseline
```

The 49 ms bounded-candidate experiment remains in the report as evidence, not as a recommendation.
Revisit it only if latency becomes a product requirement and it proves identical to complete
search on a larger judged set.

## Phase 3: retune ranking on the full corpus

Only start after phases 0 through 2 pass.

- [ ] Sweep `semanticRatio` at `0`, `0.3`, `0.5`, `0.7`, and `1.0` on the corrected datasets.
  Keep `0.7` unless another value wins on the held-out set.
- [ ] Sweep separate score floors for `cues` and `articles`. One number is not portable across
  document shapes.
- [ ] Use `_rankingScoreDetails` only while diagnosing misses.
- [ ] Test the lesson block in three positions: rescue only when no cue survives, after the first
  three cues, and removed. Score the real render order.
- [ ] Keep `LESSON_CEILING=300` until a sweep proves a gain. Although it changed from about 19% to
  6.4% of the lesson corpus, none of the current target lesson hits were suppressed by it.
- [ ] Test `oneTypo` at 4, 5, and 6 with real Arabic mistakes. Add `disableOnNumbers: true` unless
  a test disproves it.
- [ ] Review stop words by document frequency. Do not expand the list by intuition.
- [ ] Split generated Arabic-prefix equivalences from domain vocabulary. Test one-way domain
  expansions before making every pair symmetric.

Do not add `distinct: "video_id"` for quality. It was measured against all 54 labelled video
questions and changed neither dataset: 15/29 and 11/25 before and after.

Gate:

```text
candidate wins on the untouched set
negative-query gate remains zero
results are stable at the complete-search cutoff
```

## Phase 4: measure real use without collecting private questions by default

The existing PostHog setup is deliberately memory-only and disables autocapture. Keep that.

- [ ] Record one search attempt, not cache restores or tab switches.
- [ ] Record active tab, direct or widened mode, degraded mode, result count bucket, and cache hit.
- [ ] Record `result_click` with tab, visible rank, result kind, and whether it came from the
  lesson block.
- [ ] Record zero-result and retry outcomes.
- [ ] Join events with an ephemeral search ID rather than raw query text.
- [ ] If raw questions are needed for relevance work, add an explicit opt-in action on zero and
  widened states. Religious questions can reveal sensitive personal information.

Use click-through and clicked rank as behavior signals, not relevance labels. Position bias makes
high-ranked items more likely to receive clicks even when ranking is wrong.

## Phase 5: improve the landing point

The median search cue is 83.9 seconds. For a literal query, the player can find a fine transcript
row. For a semantic query using different words, it often falls back to the start of the long
cue.

- [ ] Add accepted timestamp ranges to the passage-level evaluation from phase 1.
- [ ] First test a client-side fine-row chooser based on normalized query-token overlap inside the
  returned cue. It needs no new index.
- [ ] Measure median and P95 landing error against the labelled timestamps.
- [ ] Only if the cheap chooser misses the gate, test 30-second cue windows on a representative
  subset before re-cutting and re-embedding the full corpus.

Gate:

```text
median landing error < 15 seconds
P95 landing error < 45 seconds
```

## Small UI corrections in the same round

- [ ] Remove or derive the stale empty-state sentence that says 1,600 of 4,000 lessons are
  transcribed.
- [ ] Change the search label from “lesson texts” to “lessons and articles”.
- [ ] Give the playlist clear control a 44 px target.
- [ ] Keep a visible focus indicator after pagination.
- [ ] Name the empty active tab correctly and widen per active tab, not only when both indexes are
  empty.

## Explicitly out of scope

- A second vector database.
- An LLM-generated religious answer.
- A reranker before Recall@100 proves retrieval is good and nDCG@10 proves ordering is the problem.
- A general Arabic root stemmer.
- Federated mixed video and article results.
- Binary quantization while storage is not the measured constraint.
- More filters before click data shows demand.
- Latency optimization or client-side candidate caps while search quality is the stated priority.

## Verification commands

```bash
pnpm check
pnpm verify
pnpm eval --ladder
pnpm eval --ladder --file=data/eval-questions-2.json
pnpm eval --ladder --file=data/eval-articles.json
pnpm build
```

Run the index checks and evaluations against the replacement index before the swap, then repeat
the smoke tests through the public search endpoint after the swap.

## Sources

- [Meilisearch Search API](https://www.meilisearch.com/docs/reference/api/search/search-with-post)
- [Meilisearch search cutoff](https://www.meilisearch.com/docs/capabilities/full_text_search/how_to/configure_search_cutoff)
- [Meilisearch index swaps](https://www.meilisearch.com/docs/reference/api/indexes/swap-indexes)
- [Meilisearch composite embedder constraints](https://www.meilisearch.com/docs/capabilities/hybrid_search/advanced/composite_embedders)
- [Meilisearch hybrid ranking guidance](https://www.meilisearch.com/docs/capabilities/hybrid_search/advanced/custom_hybrid_ranking)
- [Meilisearch Arabic language support](https://www.meilisearch.com/docs/resources/help/language)
- [Charabia tokenizer](https://github.com/meilisearch/charabia)
- [MIRACL multilingual retrieval benchmark](https://aclanthology.org/2023.tacl-1.63/)
- [NoMIRACL unanswerable-query benchmark](https://aclanthology.org/2024.findings-emnlp.730/)
- [BGE-M3 paper](https://aclanthology.org/2024.findings-acl.137/)
