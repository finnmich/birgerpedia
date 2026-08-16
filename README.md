# Birgerpedia

> previously *Vestmodex* — renamed 2026-05-11 for a friendlier door.

A homage oppslagsverk of every film, TV, and game review by **Birger Vestmo**,
NRK Filmpolitiet's veteran critic. **1,914 reviews, 2007–2026,
95.9% TMDB-enriched.**

See [`PLAN.md`](./PLAN.md) for the full design, recon and crawl-ethics notes.

## Quick start

### Data pipeline

```bash
npm install                                      # nothing required, but installs nothing too
npm run crawl:listing                            # ~1 min: pages of Birger's NRK author feed
npm run crawl:articles                           # ~32 min: every /anmeldelse_-_/ article (resumable)
npm run build:dataset                            # produces data/processed/reviews.json
TMDB_API_KEY=… node scripts/enrich-tmdb.mjs      # ~8 min: TMDB cast/crew/posters
```

Both crawlers are resumable, polite (1 req/s, identifying UA), and produce
incremental output so re-runs only touch new content.

### The website

```bash
cd app
npm install
npm run dev                                      # http://localhost:4321
npm run build                                    # static dist/, ready to deploy
```

## Deploying

The project hosts on **GitHub Pages** and stays up to date via a daily
**GitHub Actions** workflow (`.github/workflows/daily.yml`).

### One-time setup

1. Push this repo to a GitHub remote (`gh repo create` or via web UI).
2. **Settings → Pages → Source** → choose *GitHub Actions*.
3. **Settings → Secrets and variables → Actions → Secrets**, add:
   - `TMDB_API_KEY` — same value as `.env`
   - `OMDB_API_KEY` — same value as `.env`
4. **Settings → Secrets and variables → Actions → Variables** (different
   tab — not secrets), optionally set:
   - `ASTRO_SITE` — your final site URL (e.g. `https://your.domain/`).
     Defaults to `https://<your-username>.github.io/<repo-name>/` if unset;
     the workflow falls back to that automatically.
5. Either wait for the next 04:00 UTC run, or trigger immediately:
   **Actions → Daily crawl + deploy → Run workflow**.

### What the daily run does

```
04:00 UTC  ⏰
   │
   ├─ restore raw-HTML + OMDb + IMDb + enrichment caches
   ├─ walk NRK listing API           ~1 min
   ├─ fetch any new articles         ~1 min (typical: 1–3 new/day)
   ├─ rebuild slim dataset
   ├─ TMDB enrich new titles only
   ├─ refresh IMDb ratings dataset
   ├─ OMDb backfill (≤950 calls)     until full corpus is covered
   ├─ Astro build                    ~5 s for ~5,900 pages
   ├─ Deploy to GitHub Pages
   └─ commit processed digests back  [skip ci]
```

The whole job costs ~3–4 GH Action minutes/day (well within the 2 000 min/mo
free quota), produces no waste fetches against NRK (everything is resumable
and cached), and self-heals if a step fails (next day picks up where it left
off).

### Custom domain

Drop a `CNAME` file with your domain at the repo root, then add an A/CNAME
record at your DNS pointing to GitHub Pages. The workflow re-deploys the
CNAME on every run, so it sticks.

### If you outgrow GitHub Pages

Cloudflare Pages migration takes minutes: point CF at the repo, set the
build command to `cd app && npm run build`, set the output to `app/dist`.
Same daily workflow keeps committing to main; CF picks up automatically.

## Layout

```
scripts/         # crawlers, parser, dataset builder, TMDB enrichment (Node ESM)
data/raw/        # original NRK responses (gitignored)
  listing/       #   author-API JSON pages + index.json
  articles/      #   one HTML + parsed JSON per review, by NRK content ID
data/processed/  # the published dataset (reviews.json, stats.json, enrichment/)
app/             # Astro 7 + Vue 3 + Tailwind 4 static site
PLAN.md          # design + recon notes + progress
```

## Site stack

Astro · Vue 3 islands · Tailwind v4 · MiniSearch · self-hosted Fraunces /
Newsreader / JetBrains Mono. Editorial cinema-noir aesthetic, terningkast die
as the central visual element. All charts hand-built SVG. ~70 MB of static
output, no runtime backend.
