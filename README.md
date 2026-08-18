# كشّاف أبي جعفر — search pipeline prototype

Proves the Arabic retrieval pipeline before any UI is built:

```
YouTube → tafrigh/wit.ai → *.chunks.ndjson → Meilisearch
```

Full product spec: [docs/PRD.md](docs/PRD.md).

## Run it

```bash
pnpm install
brew install meilisearch                     # prod uses compose.yml on the VPS
pnpm meili &                                 # db in git-ignored ./data/

cp .env.example .env                         # RAW_DIR = tafrigh's output/ dir
pnpm ingest                                  # settings + all *.chunks.ndjson → `cues` index
```

Transcription lives in the [tafrigh](https://github.com/ieasybooks/tafrigh) checkout, not here — it
already emits index-ready cues (`--chunk_target_words` / `--chunk_max_duration`), so there is no
cue-merging step on our side. Re-running `pnpm ingest` after new videos overwrites by `id` and
leaves everything else alone.

## Searching

Both params are required or results are wrong:

```json
{ "q": "بر الوالدين", "locales": ["ara"], "matchingStrategy": "all" }
```

`locales` makes charabia fold hamza/ta-marbuta at query time; `matchingStrategy: "all"` stops the
split-off definite article `ال` from matching the entire corpus (the default `last` returns ~99% of
docs for any query starting with `ال`). `minWordSizeForTypos.oneTypo: 4` is set in
`meilisearch-settings.json` so short Arabic roots still tolerate a typo (`الطلاك` → `الطلاق`).

## Prototype-only shortcuts

Docker skipped locally (native brew binary); `compose.yml` remains the VPS path. No articles index,
no incremental state hashing, no site yet — see the `ponytail:` comments for where each ends.
