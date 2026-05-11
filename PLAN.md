# Birgerpedia — the Birger Vestmo review oppslagsverk

A homage / fan project: a complete searchable, graphable, nerdable index of
every film, TV, and game review by **Birger Vestmo** — Norwegian film critic at
NRK Filmpolitiet since 1998.

The site is client-side only: a static Astro app with Vue 3 islands. All data
ships as JSON; all queries, filters, and stats run in the browser.

---

## ⚠️ Crawl ethics

NRK's `robots.txt` blocks the `Claude-Web`, `anthropic-ai`, and `ClaudeBot`
user-agents and states content cannot be used for training large language
models without permission.

What we are doing is **not** LLM training — it is a fan index of publicly
published reviews credited to a single named journalist on a public-broadcaster
website. Rules we follow regardless:

- Custom, identifying User-Agent (`birgerpedia-research/0.1 (+contact email)`)
  — not a Claude UA, not a generic browser UA.
- Rate-limit: ≤ 1 request/second, single-threaded.
- Cache aggressively: each page fetched at most once; re-runs are incremental.
- Respect HTTP errors (back off on 429/5xx).
- Crawl only `/forfatter/birger-vestmo-18.264` content + the articles it links
  to. No general crawl of nrk.no.
- The site we publish will credit NRK + Birger Vestmo prominently and link
  back to every original review. Hosting it publicly is the user's call;
  contacting NRK before going public is recommended.

---

## Data sources we discovered (recon notes)

### 1. Author articles API (the gold)

```
GET https://www.nrk.no/komponenter/api/author/articles/18.264.json
    ?count=<1..50>
    &cursor=<base64 of [timestamp_ms, "last_id"]>
```

- `18.264` is Birger Vestmo's stable NRK content ID.
- Returns JSON: `{ cursor, plugs: [{title, lead, url, image, published}] }`.
- `count` capped at 50 (count=100 silently falls back to 6).
- `cursor` is base64 of `[publishedMs, articleId]`; pass it back to get the
  next-older page.
- **Total articles by Birger: 3,198** (per `totalPlugsAvailable` on the
  rendered author page). Not all are reviews — some will be news pieces,
  interviews, "behind the scenes," etc. Filter by URL pattern
  (`/anmeldelse_-_`) and JSON-LD `@type === "Review"`.

### 2. Per-article HTML

Every review article — old (pre-Astro CMS) and new (Astro) — has:

- `<meta property="nrk:content_id" content="1.NNNNNNNN">`
- `<meta property="article:published_time" content="ISO">`
- `<meta property="article:modified_time" content="ISO">`
- `<meta property="article:author" content="Birger Vestmo / Journalist">`
- `<meta property="og:image">`, `og:title`, `og:url`
- `<script type="application/ld+json">` — schema.org `Review`:
  - `author[].identifier` (e.g. `"18.264"` for Birger)
  - `itemReviewed.@type` — `Movie` | `TVSeries` | `VideoGame` | …
  - `itemReviewed.name`, `itemReviewed.director` (Person, when present)
  - `reviewRating.ratingValue` (the **terningkast** 1–6) and `bestRating`
  - `datePublished`, `dateModified`, `inLanguage`, `headline`, `abstract`

Modern articles also expose a header block and a body factbox:

```html
<div class="review-info">
  <h3>«Mortal Kombat II»</h3>
  <p>Regi: Simon McQuoid</p>
  <p>Action, eventyr, fantasy</p>
  <p>Aldersgrense: 15 år</p>
  <p class="secondary">8. mai 2026</p>   <!-- premiere -->
  <p class="secondary">Kino</p>          <!-- format/platform -->
</div>
```

Plus a body factbox of `<p>Label: Value</p>` pairs, e.g.

```
Tittel: «Mortal Kombat II»
Regi: Simon McQuoid
Skuespillere: Karl Urban, Lewis Tan, …
Distributør: Warner Bros. Discovery
Sjanger: Action, eventyr, fantasy
Lengde: 1 time og 56 minutter
Aldersgrense: 15 år
Norgespremiere: 8. mai 2026
Originaltittel: …
Land: …
Manus: …
Serieskaper: …            (TV series instead of "Regi")
```

Older articles (pre-Astro era, identifiable by absence of `<astro-island>` and
the presence of `class="review-rating"`) have richer JSON-LD but sparser
factboxes — we'll fall back to JSON-LD + body text in those cases.

---

## Data model (target)

A single normalized review record (one per article):

```jsonc
{
  "id": "1.17873593",                    // NRK stable content ID
  "url": "https://www.nrk.no/...",       // canonical
  "slug": "mortal-kombat-ii",            // derived from URL
  "section": "filmpolitiet",             // article:section
  "type": "Movie",                       // Movie | TVSeries | VideoGame | other
  "name": "Mortal Kombat II",            // itemReviewed.name (de-quoted)
  "headline": "Teite typer i tøffe tvekamper",
  "abstract": "ANMELDELSE: «Mortal Kombat II»",
  "rating": 4,                           // terningkast 1-6
  "ratingMax": 6,
  "publishedAt": "2026-05-06T18:00:00+02:00",
  "modifiedAt": "2026-05-06T18:00:00+02:00",
  "author": {
    "id": "18.264",
    "name": "Birger Vestmo",
    "url": "https://www.nrk.no/forfatter/birger-vestmo-18.264"
  },
  "image": "https://gfx.nrk.no/...jpg",
  "factbox": {                           // raw label→value pairs from <p>
    "tittel": "Mortal Kombat II",
    "regi": "Simon McQuoid",
    "skuespillere": ["Karl Urban", "Lewis Tan", "..."],
    "distributor": "Warner Bros. Discovery",
    "sjanger": ["Action", "eventyr", "fantasy"],
    "lengde": "1 time og 56 minutter",
    "lengdeMinutes": 116,
    "aldersgrense": "15 år",
    "norgespremiere": "2026-05-08",
    "originaltittel": null,
    "land": null,
    "manus": null,
    "serieskaper": null
  },
  "platform": "Kino",                    // Kino | Netflix | HBO | Viaplay | …
  "bodyText": "…",                       // plain-text article body (for FT search)
  "wordCount": 412,
  "fetched": {
    "fetchedAt": "2026-05-10T…",
    "etag": null,
    "rawHtmlPath": "data/raw/articles/1.17873593.html"
  }
}
```

Phase 2 will add an `enrichment` block (TMDB/OMDb data) keyed off `name + year`
or `originaltittel + year`.

---

## Phases

### Phase 1 — Crawl & parse all reviews   ← we are here

1. **Listing crawler** — `scripts/crawl-listing.mjs`. Cursor-paginates the
   author API at count=50, dumps each raw page to
   `data/raw/listing/page-NNN.json` and writes a deduped
   `data/raw/listing/index.json` of every plug. Resumable: re-running picks
   up where the cursor left off, and a `--full` flag re-walks from the top
   to catch new articles.
2. **Article crawler** — `scripts/crawl-articles.mjs`. For each plug whose
   URL matches `/anmeldelse_-_`, fetch the article HTML, save to
   `data/raw/articles/<id>.html`, then parse via the parser module.
   Resumable: skips IDs already on disk unless `--refresh` is given.
3. **Parser** — `scripts/parse-article.mjs`. Extracts the data-model record
   above. Pure, importable, easy to unit-test on cached HTML.
4. **Build dataset** — `scripts/build-dataset.mjs`. Joins listing + parsed
   articles, applies normalization (skuespillere split into array, runtime
   string → minutes, premiere string → ISO date), filters to
   `author.id === "18.264"` AND `@type === "Review"`. Writes
   `data/processed/reviews.json` and `reviews.ndjson`.

### Phase 2 — Metadata enrichment  *(next)*

For each parsed review, look up:

- **TMDB** by title + year (originaltittel preferred). Pull: poster, backdrop,
  cast list with character names, full crew, runtime, budget, revenue,
  production companies, countries, languages, popularity, vote average,
  collection (e.g. Mission: Impossible series), keywords.
- **OMDb** as a cross-reference (Rotten Tomatoes / Metacritic / IMDb scores).
- **Wikidata** via SPARQL for: filming locations, directors-of-photography,
  composers, related works, awards.

Stored side-by-side as `data/processed/enrichment/<id>.json` so we can re-run
without re-crawling NRK. Match confidence stored. Fallback: hand-curate
`data/processed/overrides.json` for ambiguous matches.

### Phase 3 — The website

Astro 5 + Vue 3 islands, client-only. Static deploy.

Pages:

- `/` — Hero with score histogram, latest reviews, "random review" button.
- `/reviews` — Searchable, filterable index. Filters: rating, type
  (Film/TV/Game), platform, year, decade, genre, director, actor, country.
  Sort: date, rating, alphabetical. URL-encoded state.
- `/review/<slug>` — Single review: NRK quote (excerpt only, link out for
  full text), poster, factbox, TMDB cast/crew, related works.
- `/stats` — Dashboards:
  - Reviews per year (line)
  - Rating distribution overall + per type/platform/genre (bars)
  - "Birger's average for genre X" rankings
  - Most-reviewed directors / actors
  - "Hardest to please" / "Easiest to please" decades
  - Streaming platform shifts over time
  - Word-cloud of headlines per rating bucket
- `/people/<slug>` — Director or actor page: every Vestmo review where they
  appear, average rating, timeline.
- `/timeline` — Scrubbable horizontal timeline 1998 → today.
- `/random` — Random review.

Tech:

- Astro pages, Vue 3 islands for interactive widgets.
- [Pinia] or composables for shared state.
- [MiniSearch] or [FlexSearch] for in-browser full-text + filter search.
- [Visx] or [D3] (or vanilla SVG) for charts. Probably [unovis] or
  [@unovis/vue] given Vue 3.
- Tailwind for styling, but with a strong custom design — the goal is a
  distinctive *dex aesthetic, not a generic dashboard.

---

## Progress

- [x] Recon: NRK API endpoints, page structures, JSON-LD, factbox markup.
- [x] Discover author API + cursor format.
- [x] Confirm parser anchors work for both old (pre-Astro) and new articles.
- [x] PLAN.md.
- [x] Project skeleton (package.json, scripts/, data/).
- [x] Listing crawler — **2,935 plugs across 65 pages, 1,915 reviews**, date
      range 2007-09-27 → 2026-05-06.
- [x] Article crawler + parser.
- [x] Smoke tests (20 newest + stratified-50 across the full date range,
      0 errors).
- [x] Full crawl — **1,915 / 1,915 fetched, 0 errors**, 309 MB raw HTML.
- [x] Phase 2 — TMDB enrichment, **1,835 hits / 79 misses (95.9%)**, full
      cast/crew/keywords/external IDs/posters/budget per match.
- [x] Phase 3 — Astro + Vue 3 site, see below.

## Phase 3 — the website  (built)

**Stack** Astro 5 (1921 static pages built in ≈3s) · Vue 3 islands · Tailwind v4
· MiniSearch (client-side full-text) · self-hosted variable fonts (Fraunces,
Newsreader, JetBrains Mono).

**Aesthetic** Editorial Cinema Noir. Cream paper / film-leader black /
Filmpolitiet red. SVG terningkast die used everywhere ratings appear.
MESTERVERK / UNDERMÅLER stamp seals. Film grain overlay. Asymmetric editorial
grids. Norwegian copy throughout.

**Pages**
- `/` — hero with self-rolling die (server-rendered initial pick), big
  typographic statement, terningkast histogram (interactive), three
  spotlighted "MESTERVERK" cards with red wax-stamp seal, latest 8 reviews,
  director / genre / type taxa.
- `/reviews` — Vue island with faceted filters (rating, type, year range,
  genre, format), MiniSearch, sortable, URL-encoded state.
- `/reviews/[slug]` — full review detail. NRK header (rating die, factbox,
  poster) + a TMDB-fed second half (synopsis, cast cards w/ profile photos,
  crew, keywords, financials, IMDb / Wikidata links), prev/next navigation,
  related-by-director and related-by-genre.
- `/stats` — multi-chart Vue dashboard (volume per year, average rating per
  year, year×rating heatmap, top directors with bars + average ratings,
  rating distribution).
- `/timeline` — every year, every review, in two columns per year, sticky
  year-header with mini-distribution.
- `/random` — meta-refresh + JS shuffle for instant random landings.
- `/about` — project rationale + tech.
- `/404` — random review suggestion as soft-landing.

**Build artefacts**

```
dist/                                       70 MB total
├── index.html                             292 KB
├── reviews/index.html                      17 KB   (Vue island)
├── reviews/<slug>/index.html         22–30 KB × 1914
├── stats/index.html                       9.7 KB   (Vue island)
├── timeline/index.html                    1.8 MB   (full archive)
├── random/index.html                       68 KB   (slug list embedded)
├── about/index.html                        10 KB
├── 404.html                                8.2 KB
├── data/reviews.json                      2.7 MB
├── data/enrichment.json                   4.4 MB
└── _astro/*.js                             ~140 KB total (4 islands)
```

## How to run

```bash
# crawlers + builders (root of repo)
npm run crawl:listing                    # ~1 min — refreshes data/raw/listing
npm run crawl:articles                   # ~32 min for new articles only (resumable)
npm run build:dataset                    # rebuilds data/processed/reviews.json
TMDB_API_KEY=… node scripts/enrich-tmdb.mjs   # ~8 min, idempotent

# the website
cd app
npm install
npm run dev                              # http://localhost:4321
npm run build                            # → dist/, ready for static hosting
```

## What's intentionally not done yet

- **Full-text excerpts**: we keep `bodyText` only in `data/raw/articles/<id>.json`
  (not shipped). The site shows the headline + abstract and links out. If
  NRK is willing, we could quote one or two paragraphs.
- **Streaming-availability filter**: the platform field in NRK is a mix of
  cinema/streaming/distributor names. Could be normalized into a single
  "where can I watch this" badge using TMDB's `/watch/providers` endpoint.
- **OG image generation** — dynamic per-review social cards with the die +
  title.
- **Norwegian Bokmål → Nynorsk language toggle** — lol, but maybe.

## v2 features (round 2)

The first iteration shipped with the bones; this round adds the meat.

- **`/people/[slug]`** — **4,179 static person pages** generated at build
  time. Combines NRK factbox credits + TMDB cast/crew. Pages show:
  primary role badge, profile photo (TMDB), totals, year-range, "Birgers
  favoritt" / "minst-favoritt" bookends, separate sections for "Som
  regissør / serieskaper / manus / på lerretet". Cast appearances list
  the character name. Names in the review-detail factbox auto-link to
  these pages when one exists.
- **`/people`** — directory: top 12 "Birgers ynglinger" (highest avg with
  ≥3 reviews) and 12 "Lavest snitt", plus 24 most-reviewed directors and
  24 most-tilbakevendende skuespillere as photo cards.
- **Birger-vs-TMDB scatter** on `/stats` — every rated review with ≥10
  TMDB votes plotted; gold dots are where Birger is mildere, red where
  he's strengere; the dashed gold line is "we agree". Lists the top 5
  most-divergent reviews in each direction.
- **Headline word cloud** on `/stats` — words that recur in 6+ headlines,
  sized by frequency, coloured red→cream→gold by avg terningkast. Reveals
  Birger's vocabulary tells: words that almost always mean a 5+, words
  that signal a 3.
- **Decade ledger** on `/stats` — tens-decade summary cards: count,
  snitt, mesterverk, ettere, with a "Se alle" link that filters
  `/reviews` by decade.
- **Faceted-filter bug fix**: rating dice + genre/type/decade/format
  chips now actually toggle (Vue auto-unwraps refs in templates, so the
  generic `toggle(refObject, v)` was passing the unwrapped Set; replaced
  with named per-filter handlers).
- **Search highlighting** — matched terms in titles, headlines and
  director names get a subtle gold mark on `/reviews`.
- **Decade chips** on `/reviews` for one-click decade filters; URL state
  syncs.
- **List ↔ Grid toggle** on `/reviews` — magazine cards or dense list.
- **Result summary line** — when filters are active, shows the average
  terningkast within the result set, mesterverk and 1-stars count.
- **Active-filter counter** — the "Nullstill" button announces how many
  filters are active.
- **Genre expand** — show top 14 by default, "+N more" button reveals
  the long tail.
- **Empty-state styling** — when filters return nothing, an editorial
  empty card with a "nullstill" CTA.
- **Keyboard shortcuts** — `/` focuses search, `r` jumps to a random
  review (within the current filter), `esc` clears filters. On a single
  review page: `n` next, `p` previous, `r` random.
- **`feed.xml`** RSS for the 50 latest reviews.

## Build totals (v2)

```
6,101 static pages built in ≈100s
137 MB total dist
  1,915 review pages
  4,179 person pages
   ~7  navigation pages (/, /reviews, /people, /stats, /timeline, /random, /about)
       + 404, robots.txt, sitemap, feed.xml
```

## v3 — review · improve · simplify (this round)

### 🐛 Hard data bug

`/people/review/` had **643 distinct people colliding on it** — every CJK,
Thai, Hebrew, etc. name slugifies to empty under the old ASCII pipeline,
and the fallback was the literal string `'review'`. Tadanobu Asano (浅野忠信)
shared a URL with 642 strangers. `slug.ts` now hashes empty Latin output
into a stable `n-<7-char-base36>` slug so each person gets their own page.

### 🚀 Performance — what's shipped to the browser

| Asset                       | v2          | v3            | Δ            |
|-----------------------------|-------------|---------------|--------------|
| `data/reviews.json`         | 2.7 MB      | **924 KB**    | −66 %        |
| `data/enrichment.json`      | 4.4 MB      | **(removed)** | −100 %       |
| `data/stats.json`           | 6 KB stub   | 193 KB full   | now usable   |
| `index.html` (built)        | 292 KB      | **132 KB**    | −55 %        |
| Total `dist/data/`          | 7.1 MB      | **1.2 MB**    | **−83 %**    |

How:

- `enrichment.json` is build-time only now — moved to `src/_data/` so it
  drives SSG of review-detail pages without ever reaching the browser.
- `reviews.json` slimmed to only the fields the index actually filters/
  displays on; long-tail factbox subfields stay in the source dataset.
- `stats.json` is now a comprehensive aggregate computed at build time:
  histogram, per-year volume + averages, year×rating heatmap, top
  directors, genres, decade ledger, scatter (Birger × TMDB), word
  cloud — all precomputed. `/stats` fetches one ~200 KB file and
  renders. The previous version refetched `reviews.json` and recomputed
  in-browser.
- Hero pool trimmed from 600 → 200 entries; only the field shape the
  hero needs.
- `client:idle` for the homepage hero die (was `client:load`).
- 876 bare 1-credit-no-photo person pages dropped (eligibility tightened
  to "≥2 credits OR (director-or-creator AND TMDB profile photo)").

### 🆕 UI improvements

- **Active filter chip bar** on `/reviews`: every active filter shown as
  a removable pill above the result count; "Tøm alle" clears everything;
  the search query gets its own gold-tinted chip.
- **Mobile filter drawer**: a sticky `Filtre` button reveals the
  filter sidebar as a full-screen drawer below 980 px viewport.
- **View-mode persistence**: list/grid choice now persisted in
  localStorage so it stays across visits.
- **Timeline lazy years**: every year is wrapped in a `<details>` with
  the two most recent open by default. Per-rating mini-distribution is
  now color-coded (red→cream→gold) so the spread is readable at a glance.
- **Per-entry rating marker**: each timeline entry shows a thin colored
  bar matching its terningkast on the left edge of the row.
- **Year-nav stars**: the sticky year navigator at the top of /timeline
  shows ★ marks indicating mesterverk count for each year.
- **Heatmap is now interactive**: every cell links to the corresponding
  `/reviews?r=…&y0=…&y1=…` filter combo.

### 🧹 Simplifications

- Removed unused `Filmstrip.astro` component.
- `lib/people.ts` now exports `eligibleSlugs` Set so review pages can
  do an O(1) "does this person have a page" check instead of linear scans.
- `StatsDashboard.vue` lost ~150 lines of in-browser aggregation —
  everything's precomputed.
- `tmdb-ratings.json` threshold raised from 5 votes → 10 votes
  (eliminates noisier under-voted entries from the scatter).

## Build totals (v3)

```
5,887 static pages built in ≈100s
128 MB total dist (was 137)
  1,914 review pages
  3,965 person pages (was 4,179 — collision fixed + tightened eligibility)
       + 404, robots.txt, sitemap, feed.xml
```

## v3.1 — pre-deploy review fixes

External code review surfaced 13 issues; 8 fixed before the first GH push.

### Critical (blocked deploy)

1. **OMDb / TMDB API keys leaked into Actions logs.**
   `politeFetch` emitted full URLs (with `?apikey=…`) on 429/5xx retries.
   In a public-readable Actions log, the first OMDb hiccup would expose the
   key. Added an opt-in `redact` parameter to `politeFetch` that scrubs
   given strings to `***` before any console.warn / Error.message. Used
   in `fetch-omdb.mjs` (`redact: KEY`) and `enrich-tmdb.mjs`.

2. **`astro.config.mjs` `site:` silently fell back to `birgerpedia.local`.**
   If you forgot to set `ASTRO_SITE` in the workflow, every URL in
   sitemap-0.xml, feed.xml, and the OG meta would point at a non-existent
   `birgerpedia.local`. Astro now **throws on CI** when `ASTRO_SITE` is
   missing (`process.env.CI === 'true'` check); the workflow auto-defaults
   to `https://<owner>.github.io/<repo>/` and respects a repo
   variable override.

3. **Daily workflow's `git push` had no drift handling.**
   If a commit landed on main between the action's checkout and push, the
   push would fail and the day's data update would silently disappear.
   Added a 3-attempt `git pull --rebase --autostash` + `git push` loop;
   the data commit only touches `data/processed/*.json`, so the conflict
   surface against manual edits is tiny.

### Polish

4. **`crawl-listing` now stops early.** Was walking all 65 NRK pages every
   single day. Reads the previous `index.json`, paginates only until two
   consecutive pages contain zero new IDs. Verified: steady-state runs go
   from **65 pages → 2 pages**, saving ≈ 60 polite-but-pointless NRK
   requests/day. `--full` flag forces a complete re-walk.

5. **SearchPalette is now searchable in ~50 ms instead of waiting for
   2.1 MB to land.** Split the cold-open load into three phases:
   reviews.json (922 KB) loads on open, people.json (614 KB) and
   stats.json (597 KB) follow via `requestIdleCallback`. Searches gracefully
   show partial results — reviews first, people + categories fold in as
   they arrive.

6. **SearchPalette has focus management.** Saves `document.activeElement`
   when opening, restores it when closing. Tab / Shift-Tab inside the
   modal traps focus so it can't leak to the page behind the overlay
   (keyboard users were previously dropped onto random page links after
   the last result).

7. **`scripts/test-parser.mjs` is now actually runnable** — was a memo to
   self that pointed at `/tmp/old.html` files long since deleted. Rewrote
   as a proper smoke test that picks a stratified sample (5 spaced HTML
   files from the live corpus) and asserts required fields. Wired to
   `npm run smoke` at the root. `--all` parses every cached HTML and
   reports the bad ones; `--id 1.NNNNNN` parses a single article.

8. **Removed orphans.** Empty `app/src/data/` and `app/public/fonts/`
   directories deleted (scaffolded but never used). `package.json`
   re-pointed at the new `test-parser.mjs`. Added `enrich:tmdb / imdb /
   omdb` script aliases so the daily pipeline can be re-run by name.

### Reviewed and OK-as-is

- The `v-html` usage in `ReviewIndex.vue` (search highlighting) — confirmed
  XSS-safe (escapes first, then injects sanitized `<mark>` from regex
  matches).
- robots.txt + crawler User-Agent — `birgerpedia-research/0.1 (+mailto:…)`,
  rate-limited at 1 req/s, exponential backoff. Compliant with NRK's
  policy (which blocks AI-training UAs specifically).
- JS bundle hashing — Astro emits `*.HASH.js` so far-future caching works.

### v3.1.1 — post-first-deploy fix (cold-cache discovery)

The first GH Actions run kicked off `crawl-articles.mjs` against an empty
Actions cache and immediately started re-fetching every single article
from NRK (1,915 requests over ~32 minutes). That's both impolite to NRK
and a complete waste of CI minutes, since the digest at
`data/processed/reviews.json` already records every article we've parsed.

Root cause: three scripts checked only the raw-cache directory to decide
what's "known". On CI the Actions cache hadn't been seeded, so every file
looked new.

Fix — all three crawlers now also consult the committed digest as a
known-IDs skip-list:

| Script | New behaviour |
|---|---|
| `scripts/crawl-articles.mjs` | If an ID is in committed `data/processed/reviews.json` AND raw HTML isn't on disk, treat as known and skip the NRK fetch entirely |
| `scripts/build-dataset.mjs` | Use committed `data/processed/reviews.json` as a baseline; merge in any newly-parsed records from `data/raw/articles/`. Survives an empty articles dir by just rewriting the baseline |
| `scripts/fetch-omdb.mjs` | Build a Set of IMDb ids already in `data/processed/omdb-ratings.json`; skip the API call for those |

Local verification (with `data/raw/articles/` moved aside):
```
crawl-articles --limit=5: fetched=0 cached=0 knownDigest=5  ✓
build-dataset:            baseline 1914 + merged 0 → 1914   ✓
fetch-omdb:               skips digest-known ids            ✓
```

After this fix the first CI run is expected to fetch **only the Sigurd
Vik 2015-best-of article** (which gets dropped by the author filter
anyway) instead of all 1,915.

### Deferred to follow-up

- `/timeline` is 1.8 MB raw / 101 KB gz. Acceptable post-gzip; deferred SSR
  of older years would help further but isn't urgent.
- `vmx-` CSS prefix and `vmx:` event names — relic of the old project name,
  user-invisible. Migration script is one big find-and-replace; deferred.
- `n=1` people pages (494 of 4082 in the shipped index) — directors with a
  single Vestmo review and a TMDB photo. The "stub" feeling shows up in
  search results occasionally. Raising the threshold to `n≥2` would drop
  them; deferred pending real user feedback.
- `/random.astro` inlines 1,911 slugs (23 KB gz). Fine for now.

### Listing breakdown

```
section / URL prefix             count
nrk.no/filmpolitiet/             2813      ← the main column
nrk.no/kultur/                     98      ← culture/news pieces
nrk.no/anmeldelser/                20      ← newer dedicated review section
nrk.no/trondelag/                   2
nrk.no/tromsogfinnmark/             2
                                 -----
                                 2935 total
of which /anmeldelse_-_/         1915      ← the dex
```

Reviews per year (peaks in mid-2010s, dips early as the digital archive
thins out — Birger has been on radio since 1998 but written reviews online
seem to start in 2007):

```
2007  1     2014 130    2021 131
2008  1     2015 149    2022 127
2009 11     2016 147    2023 115
2010 17     2017 119    2024 116
2011 105    2018 112    2025  99
2012 119    2019 121    2026  37 (YTD May)
2013 147    2020 110
```

### Parser learnings (post-implementation)

- The author API caps `count` at 50; `count=100` silently degrades to 6.
- Cursor is base64 of `[publishedTimestampMs, lastArticleId]` — keep it
  opaque; we don't synthesize cursors.
- Old (pre-Astro) articles use Norwegian-format dates `DD.MM.YYYY`, modern
  ones use `8. mai 2026`. Parser handles both.
- The `<div class="review-info">` block exists in both eras with the same
  structural anchors (`<h3>` for title, `<p class="secondary">` outside the
  inner divs for original title, inner divs for credits + meta).
- "Platform" semantics drift: in modern reviews the second secondary `<p>`
  is `Kino|Netflix|HBO|Viaplay`; in older reviews it's the *distributor*
  (`SF Studios`, `Norsk Filmdistribusjon`, `Twentieth Century Fox Norway`).
  We keep them in the same field — Phase 3 can decide whether to split.
- Older articles often lack JSON-LD `author`, so the article crawler
  attributes them to Birger when sourcing from his author API (we're sure
  it's him because we crawled his author API).

## Open questions / decisions to revisit

- **Older articles' factbox**: pre-2015 articles likely have no
  `<p>Regi: …</p>` factbox. We'll see how much we can salvage from JSON-LD
  + body extraction. Worst case Phase 2 (TMDB) fills the gap if we can match.
- **Non-review Birger articles** (interviews, news pieces): keep them in a
  separate `articles.json` for completeness, or drop entirely? Lean: keep
  them, but tag `kind: "review" | "article"` so the *dex defaults to reviews.
- **Game reviews**: confirm `@type === "VideoGame"` exists in the corpus.
  Birger's beat is mostly film, but Filmpolitiet covers games too.
- **Excerpt vs full body** in published site: full body is NRK's IP. We'll
  store it locally for search/index purposes but only display short excerpts
  on the public site, deep-linking to NRK for the full review.
