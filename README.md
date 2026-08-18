# كشّاف أبي جعفر — search pipeline prototype

Proves the Arabic retrieval pipeline before any UI is built:

```
YouTube → tafrigh/wit.ai → raw chunks → cues → Meilisearch
```

Full product spec: [docs/PRD.md](docs/PRD.md).

## Run it

```bash
pnpm install
brew install meilisearch                                    # prod uses compose.yml on the VPS
meilisearch --db-path ./data/meili/data.ms --master-key devMasterKeyChangeMe --env development &

LIMIT=3 scripts/transcribe.sh   # tafrigh + wit.ai  (slow: ~12 min per hour of audio per token)
pnpm cues                       # raw chunks → 20-word / 30-second cues
pnpm index                      # → Meilisearch `cues` index
```

`scripts/transcribe.sh` with no `LIMIT` takes the whole channel (`CHANNEL_URL`); pass video ids or
URLs to do only those. Everything except `transcribe.sh` is re-runnable and incremental.
Data lives in git-ignored `data/`; browse the index at <http://localhost:7700>.

## Prototype-only shortcuts

Docker is skipped locally (native brew binary); `compose.yml` remains the VPS path. No search eval
harness, no articles index, no `data/state.json` hashing, no site — see the `ponytail:` comments for
where each shortcut ends.
