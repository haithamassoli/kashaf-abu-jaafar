# Production hardening plan

Free tiers only. Ordered by risk, not by the order the items were asked in.

## The actual threat

The site is static on Vercel, so there is no backend to hide behind: the browser talks to
Meilisearch directly at `search.assoli.site` with a **search key that ships inside the JS
bundle**. Anyone can lift that key and fire hybrid queries at a box with one OCPU that also
runs Ollama. Each uncached hybrid query costs roughly 0.55 s of that single core.

Everything below follows from that. Rate limiting is not item 4 on a checklist, it is the
one thing standing between a public key and a dead search box.

---

## 1. Rate limiting in front of Meilisearch — done on Caddy, not Cloudflare

30 requests per 10 seconds per IP, refused by Caddy before Meilisearch or Ollama ever sees them.
`ops/Caddyfile` is the copy of what runs at `/etc/caddy/Caddyfile`.

```bash
sudo caddy add-package github.com/mholt/caddy-ratelimit   # prebuilt for arm64, no Go toolchain
sudo systemctl restart caddy                              # a reload would keep the old binary
sudo apt-mark hold caddy
```

The plan put Cloudflare first. This took the alternative because it needed nothing from anyone:
no nameserver move at Namecheap, no third party in front of a live domain, and one line to undo.
What it does not buy is the two things only an edge can — the origin IP stays public and a
volumetric flood still reaches the box's network card. It does stop the attack the public search
key actually invites: someone lifting the key and firing hybrid queries that cost 0.55 s of a
single core each.

The `compose.yml` this section used to describe never existed. Caddy here is the apt package
under systemd and docker is not even running. `caddy add-package` swaps `/usr/bin/caddy` for a
build carrying the module, which is why the hold matters: an `apt upgrade` would put the stock
binary back, `rate_limit` would stop parsing, and Caddy would refuse to start. Update it with
`sudo caddy upgrade`, which keeps the modules — never apt. If it happens anyway, monitor 2 from
item 3 pages you within three minutes.

Two things the obvious version got wrong, both caught before shipping:

- **The 429 needs CORS of its own.** Meilisearch answers `Access-Control-Allow-Origin: *`; a 429
  that Caddy generates does not, and a browser reports a CORS-blocked reply as a network error
  rather than as a status. `handle_errors 429` puts the header back and answers JSON, which is
  what lets the client tell "slow down" apart from "the box is gone".
- **A refusal was turning into three requests.** `both()` in `src/lib/meili.ts` retries twice on
  failure, because the failure it was written for is a missing embedder. Under a rate limit that
  is precisely backwards — the reader who was just refused sends three more. It now rethrows on
  429, and `scripts/selfcheck.ts` fails if that guard is removed. The reader sees «طلبات كثيرة في
  وقت قصير» rather than «تعذّر الاتصال بالبحث», because the second one invites a reload and a
  reload is more requests.

Measured from outside afterwards: 30 requests through, then 429 with `retry-after: 2`, then 200
again once the window slid.

### Cloudflare, if the edge is ever worth the DNS move

Nothing above rules it out, and the two stack: a limit on the origin is what still protects the
box if the IP leaks and someone goes around the edge.

1. Cloudflare → Add site `assoli.site` (Free) → change the nameservers at Namecheap.
2. Records — the zone is small: root, `www`, `alkulify` and `kashaf-alkulify` all point at
   Vercel, `search` at the Oracle box, and there is **no MX**, so no mail can break.
   - the Vercel names → **grey cloud (DNS only)**. Vercel misbehaves behind the proxy.
   - `search` → **orange cloud (Proxied)**.
3. SSL/TLS → **Full (strict)**. Watch the first Caddy certificate renewal; if HTTP-01 fails
   behind the proxy, install a Cloudflare Origin Certificate (free, 15 years) in the Caddyfile.
4. Security → WAF → Rate limiting rules (one rule on the free plan): `hostname eq
   "search.assoli.site"` → characteristic **IP** → **30 requests / 10 seconds** → block for 10 s.
5. **Do not turn on Bot Fight Mode for `search`** without testing it. It challenges `fetch`
   requests and will break search.

> Skipped: Cloudflare caching for search responses. Meilisearch search is a POST, so it is not
> cacheable anyway.

---

## 2. Security headers — one new file

`vercel.json`:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains" },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=(), payment=()" },
        { "key": "Content-Security-Policy", "value": "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.youtube.com https://s.ytimg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://i.ytimg.com; font-src 'self'; connect-src 'self' https://search.assoli.site https://eu.i.posthog.com https://eu-assets.i.posthog.com; frame-src https://www.youtube-nocookie.com https://www.youtube.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'; upgrade-insecure-requests" }
      ]
    }
  ]
}
```

`'unsafe-inline'` in `script-src` is forced by the `is:inline` theme scripts
(`src/layouts/Base.astro:96`, `:269`, `src/pages/p/index.astro:78`). The real value in this
header is `frame-ancestors 'none'`, `nosniff`, and `object-src 'none'`.

### Why not hash the inline scripts (declined, 2026-08-20)

`experimental: { csp: true }` in `astro.config.mjs` would hash the inline scripts and let
`'unsafe-inline'` go. Declined for now.

The only hole `'unsafe-inline'` leaves is injected inline script, and this site has two HTML
sinks — `highlight()` in `src/lib/meili.ts` and `markMatches()` in `src/lib/mark.ts`. Both
escape `&<>` at the source and both carry an `<img src=x onerror=alert(1)>` assert in
`scripts/selfcheck.ts`, which item 5's CI runs on every push. Article bodies from the Wayback
corpus are never rendered raw; `src/pages/a/[id].astro` has no `set:html`. No server, no auth,
no cookies once PostHog runs with `persistence: 'memory'`.

Against that, the flag costs: it is experimental while Dependabot bumps Astro weekly, and a
stale hash fails at runtime in the browser, not at build, so `pnpm build` will not catch it.
It also splits the policy across a `<meta>` and this header, whose intersection is what the
browser enforces. `frame-ancestors` is ignored in meta CSP, so `vercel.json` survives either
way and no file is saved.

Revisit when a new HTML sink appears — rendering article bodies as HTML to keep the WordPress
bold and links is the likely one — not on a calendar. At that point the escape boundary stops
being two tested functions and the hashes start earning their keep. Enabling it means setting
the flag and deleting `script-src` and `style-src` from the header above.

---

## 3. Uptime and server monitoring — Better Stack Free

Free plan: 10 monitors, 3-minute checks, heartbeats, one status page, email + mobile alerts.

`ops/monitors.sh` creates all of it through the API, so the configuration is a file rather than
a memory of clicks:

```bash
BETTERSTACK_API_TOKEN=... SEARCH_KEY=... ops/monitors.sh
```

`SEARCH_KEY` is the public search key that already ships inside the JS bundle, so nothing
secret enters the repo. Re-running skips whatever already exists under the same name.

| # | Monitor | Catches |
|---|---|---|
| 1 | `GET alkulify.assoli.site/` — keyword `كشّاف` | Vercel down, bad build |
| 2 | `GET search.assoli.site/health` — keyword `available` | Meilisearch or Caddy dead |
| 3 | `POST /indexes/cues/search` — keyword `video_id` | Revoked key, empty or stale index |
| 4 | `POST /multi-search` with `hybrid` — keyword `video_id` | Embedder missing from the index |

Monitor 4 was meant to be the one that catches a dead Ollama, and it cannot. Meilisearch caches
20k query embeddings and a monitor asks the same question every three minutes, so the answer
comes out of the cache and the monitor stays green for as long as the cache holds. It still
earns its slot — it fails when the embedder config is gone from the index, or when
`MEILI_EXPERIMENTAL_ALLOWED_IP_NETWORKS` is lost across a restart, since a restart empties the
cache too — but the dead-Ollama check had to move onto the box, where the question can change
on every run.

`ops/kashaf-beat`, every ten minutes:

```bash
sudo install -m 755 ops/kashaf-beat /usr/local/bin/kashaf-beat
printf 'HEARTBEAT_URL=%s\nSEARCH_KEY=%s\n' "$url" "$key" | sudo tee /etc/kashaf-beat.env
sudo chmod 600 /etc/kashaf-beat.env
echo '*/10 * * * * root /usr/local/bin/kashaf-beat' | sudo tee /etc/cron.d/kashaf-heartbeat
```

It beats only if `/health` answers, `/` is below 85% full, and a hybrid search with
`semanticRatio: 1` and a timestamp inside the question comes back with a semantic hit. That
last one costs 0.6 s, which is the tell: it is a real trip through Ollama, not a cache read.
Silence is the alert — period 10 minutes, grace 5, so one missed run is forgiven and two raise
an incident.

Verified on the box by breaking each leg in turn: a wrong embedder name, a wrong Meilisearch
port, and a disk threshold of 1% each stop the beat; unmodified, it beats. The monitors got the
same treatment — a throwaway copy of monitor 1 asking for a keyword that is not on the page went
down in 20 seconds, which is what says the keyword is really asserted and not decoration. All
five are live and green as of 2026-08-20.

Ten minutes rather than five for one reason: every run puts a throwaway entry into that same
20k embedding cache. 144 a day is a rounding error against real traffic; 288 starts to be a tax
on it.

> Skipped: a metrics agent (CPU/RAM graphs) and a status page. A full disk is what actually
> kills Meilisearch — it goes read-only while `/health` still answers `available` — and the
> beat covers that. Add the agent when you want history.

---

## 4. Analytics — PostHog Free (1M events/month)

```bash
pnpm add posthog-js
```

```ts
// src/lib/analytics.ts — ponytail: pageviews plus one event, nothing else
import posthog from 'posthog-js'

posthog.init(import.meta.env.PUBLIC_POSTHOG_KEY, {
  api_host: 'https://eu.i.posthog.com',
  // People search personal fiqh questions here. No person profiles, no cookies, no consent banner.
  person_profiles: 'never',
  persistence: 'memory',
  autocapture: false,
  disable_session_recording: true,
})

export const track = posthog.capture.bind(posthog)
```

In `Base.astro`, before `</body>`:

```astro
<script>import '../lib/analytics'</script>
```

Astro bundles it, so it stays same-origin and passes the CSP above.

The one event worth having, where the search result resolves in `src/islands/Search.tsx`:

```ts
track('search', { q: text, tab: next, total: res.total, widened: res.widened })
```

That answers the only question a search site really has: what do people search for, and which
queries return zero or fall back to the widened pass. It feeds straight back into the eval set.
Turn on "Discard client IP data" in the PostHog project settings.

> Skipped: autocapture, session recording, feature flags. Noise on a static site, and dropping
> them shrinks the bundle.

---

## 5. Dependabot and a small CI

The repo is public, so GitHub Actions minutes are free.

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
    groups:
      all: { patterns: ['*'] }      # one PR a week, not fifteen
    open-pull-requests-limit: 3
```

```yaml
# .github/workflows/ci.yml
name: ci
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    env: { PUBLIC_MEILI_HOST: 'https://search.assoli.site' }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
      - run: pnpm build
```

Without the CI, Dependabot is a liability rather than a help: `main` auto-deploys to Vercel in
about 50 seconds.

---

## 6. Two free fixes found on the way

```json
"build": "astro build && pnpm run guard",
"guard": "! grep -rql '127.0.0.1:7700' dist || (echo 'PUBLIC_MEILI_HOST is still localhost — set the public one and rebuild' && false)",
```

- The `predeploy` guard **never runs today**. It is bound to `pnpm deploy`, which is a dead
  wrangler script — deployment is Vercel, not Cloudflare Pages. Chaining it onto `build` with
  `&&` (rather than relying on a `postbuild` hook, whose pnpm default has changed between
  versions) makes it run on Vercel and in CI.
- Delete `"deploy": "wrangler pages deploy dist"`.

---

## Where the plan stands (2026-08-20)

| Item | State |
|---|---|
| 1. Rate limiting | done — 30 requests / 10 s per IP in Caddy; the Cloudflare edge stays optional |
| 2. Security headers | done — `vercel.json` |
| 3. Uptime and server monitoring | done — four monitors and the heartbeat are live and green |
| 4. Analytics | done — `src/lib/analytics.ts`, silent unless `PUBLIC_POSTHOG_KEY` is set |
| 5. Dependabot and CI | done — `.github/` |
| 6. The build guard | **open** — `predeploy` is still bound to the dead `pnpm deploy`, so it never runs |

Item 6 is all that is left, and it is a two-line change to `package.json`.

## Deliberately skipped

- **Sentry** — PostHog captures exceptions with one toggle if you ever need it.
- **Prometheus/Grafana** on a single-core box — it would eat the core this plan is protecting.
- **Meilisearch backups** — the laptop is the backup and `scripts/index.ts` is idempotent.
- **Public status page** — free on Better Stack, but nobody is asking for one yet.

Add any of them when their absence actually bites.
