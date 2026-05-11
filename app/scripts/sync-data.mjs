// Build-time data shaping. Splits the processed dataset into:
//
//   src/_data/enrichment.json      build-time only (NOT shipped)
//                                  full TMDB enrichment, used by review-detail SSG
//   public/data/reviews.json       slim per-record list — only fields the
//                                  reviews-index UI actually needs
//   public/data/stats.json         pre-computed aggregates for /stats so it
//                                  doesn't refetch & recompute the full corpus
//   public/data/tmdb-ratings.json  {id: {v, c}} for the scatter plot
//
// Run by `npm run prebuild` and `npm run predev`.

import { mkdir, copyFile, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC  = resolve(ROOT, '..', 'data', 'processed');
const ENR_SRC = resolve(SRC, 'enrichment');
const IMDB_RATINGS_PATH = resolve(SRC, 'imdb-ratings.json');
const OMDB_RATINGS_PATH = resolve(SRC, 'omdb-ratings.json');
// Committed snapshot of the TMDB enrichment aggregate. Lives in data/processed/
// so the workflow can commit it, unlike the gitignored per-review files in
// data/processed/enrichment/. This is the file enrich-tmdb.mjs reads as its
// cold-start skip-list, and the file sync-data reads as a baseline before
// merging in any fresh per-review enrichments.
const TMDB_SNAPSHOT_PATH = resolve(SRC, 'tmdb-enrichment.json');
const PUB = resolve(ROOT, 'public', 'data');
const INTERNAL = resolve(ROOT, 'src', '_data');

await mkdir(PUB, { recursive: true });
await mkdir(INTERNAL, { recursive: true });

// ----- 1. Trim the per-record list shipped to /reviews -----
const reviewsRaw = JSON.parse(await readFile(resolve(SRC, 'reviews.json'), 'utf8'));
// Same-day dedupe runs BEFORE we trim, since it needs the enrichment lookup
// for TMDB ids. The dropped ids are also written to a small audit file so
// you can see what was removed and why on every build.
const dedupeResult = await dedupeSameDay(reviewsRaw);
const slim = dedupeResult.kept.map((r) => trimReview(r));
await writeFile(resolve(PUB, 'reviews.json'), JSON.stringify(slim));
console.log(`[sync] reviews.json (slim) — ${slim.length} records (dropped ${dedupeResult.droppedIds.size} same-day dupes), ${kb(JSON.stringify(slim).length)}`);
if (dedupeResult.droppedIds.size) {
  await writeFile(resolve(INTERNAL, 'dedupe-audit.json'), JSON.stringify(dedupeResult.audit, null, 2));
  console.log(`[sync] dedupe details → src/_data/dedupe-audit.json`);
}
// Always write the dropped-ids list (possibly empty) so lib/data.ts has a
// stable file to read against. Without this, SSG would still generate the
// duplicate review-detail pages even though /reviews omits them.
await writeFile(resolve(INTERNAL, 'dropped-ids.json'), JSON.stringify([...dedupeResult.droppedIds]));

// Read enrichment from per-review files for the TMDB lookup the dedupe needs.
// This is the same source aggregated below; we read it once early.
async function dedupeSameDay(reviews) {
  // Build {reviewId → tmdbId} from per-review enrichment files.
  const tmdbOf = new Map();
  try {
    const enrFiles = await readdir(ENR_SRC);
    for (const f of enrFiles) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      try {
        const raw = JSON.parse(await readFile(resolve(ENR_SRC, f), 'utf8'));
        if (raw?.miss) continue;
        const tmdbId = raw?.match?.tmdbId;
        if (tmdbId && raw.reviewId) tmdbOf.set(raw.reviewId, tmdbId);
      } catch {}
    }
  } catch {}

  // Group by (tmdbId, publishedDay). Only act when 2+ records collide.
  const groups = new Map();
  for (const r of reviews) {
    const t = tmdbOf.get(r.id);
    if (!t) continue;
    const day = (r.publishedAt ?? '').slice(0, 10);
    const key = `${t}::${day}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const droppedIds = new Set();
  const audit = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    // Pick canonical: non-placeholder headline wins, then lowest id (stable).
    const ranked = [...group].sort((a, b) => {
      const aPh = isPlaceholderHeadline(a) ? 1 : 0;
      const bPh = isPlaceholderHeadline(b) ? 1 : 0;
      if (aPh !== bPh) return aPh - bPh;            // non-placeholder first
      return (a.id ?? '').localeCompare(b.id ?? ''); // stable tie-break
    });
    const [keep, ...drop] = ranked;
    audit.push({
      tmdbId: key.split('::')[0],
      day: key.split('::')[1],
      kept: { id: keep.id, headline: keep.headline },
      dropped: drop.map((r) => ({ id: r.id, headline: r.headline })),
    });
    for (const r of drop) droppedIds.add(r.id);
  }

  return { kept: reviews.filter((r) => !droppedIds.has(r.id)), droppedIds, audit };
}

function isPlaceholderHeadline(r) {
  const h = (r.headline ?? '').trim().toLowerCase();
  if (!h) return true;
  const n = (r.name ?? '').trim().toLowerCase();
  return h === n;        // "Civil War" / "Civil War" → placeholder
}

function trimReview(r) {
  const fb = r.factbox ?? {};
  const out = {
    id: r.id,
    name: r.name,
    type: r.type,
    rating: r.rating,
    publishedAt: r.publishedAt,
    headline: r.headline ?? null,
    originalTitle: r.originalTitle ?? null,
    image: r.image ?? null,
    platform: r.platform ?? null,
    factbox: {
      regi: fb.regi ?? null,
      serieskaper: fb.serieskaper ?? null,
      skuespillere: fb.skuespillere ?? null,
      sjanger: fb.sjanger ?? null,
      lengdeMinutes: fb.lengdeMinutes ?? null,
      aldersgrense: fb.aldersgrense ?? null,
      norgespremiere: fb.norgespremiere ?? null,
      land: fb.land ?? null,
      distributor: fb.distributor ?? null,
    },
  };
  return out;
}

// ----- 2. Aggregate full enrichment for build-time SSG only -----
//
// Start from the committed snapshot (so CI cold-starts with empty caches
// still have data to render), then merge in any fresh per-review files
// from data/processed/enrichment/* (which only exist for reviews enriched
// on this machine since the last commit). Fresh files override the
// snapshot — they're newer and authoritative.
let enrichment = {};
try { enrichment = JSON.parse(await readFile(TMDB_SNAPSHOT_PATH, 'utf8')); } catch {}
const snapshotKeys = new Set(Object.keys(enrichment));

try {
  const files = await readdir(ENR_SRC);
  let hits = 0, misses = 0;
  for (const f of files) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    let raw;
    try { raw = JSON.parse(await readFile(resolve(ENR_SRC, f), 'utf8')); } catch { continue; }
    if (raw.miss || !raw.tmdb) {
      enrichment[raw.reviewId] = { miss: true };
      misses++;
      continue;
    }
    const t = raw.tmdb;
    const credits = t.credits ?? {};
    const crew = Array.isArray(credits.crew) ? credits.crew : [];
    const cast = Array.isArray(credits.cast) ? credits.cast : [];

    const dir = crew.find((c) => c.job === 'Director');
    const writer = crew.find((c) => c.job === 'Writer' || c.job === 'Screenplay');
    const dop = crew.find((c) => c.job === 'Director of Photography');
    const composer = crew.find((c) => c.job === 'Original Music Composer' || c.job === 'Music');
    const editor = crew.find((c) => c.job === 'Editor');

    const slimCast = cast.slice(0, 12).map((c) => ({
      name: c.name,
      character: c.character,
      profile: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null,
    }));
    const ext = t.external_ids ?? {};

    enrichment[raw.reviewId] = {
      mediaType: raw.match?.mediaType ?? null,
      tmdbId: raw.match?.tmdbId ?? t.id ?? null,
      confidence: raw.match?.confidence ?? null,
      title: t.title ?? t.name ?? null,
      originalTitle: t.original_title ?? t.original_name ?? null,
      releaseDate: t.release_date ?? t.first_air_date ?? null,
      runtime: t.runtime ?? (t.episode_run_time?.[0]) ?? null,
      tagline: t.tagline ?? null,
      overview: t.overview ?? null,
      genres: (t.genres ?? []).map((g) => g.name),
      keywords: (t.keywords?.keywords ?? t.keywords?.results ?? []).slice(0, 10).map((k) => k.name),
      poster: t.poster_path ? `https://image.tmdb.org/t/p/w500${t.poster_path}` : null,
      backdrop: t.backdrop_path ? `https://image.tmdb.org/t/p/w1280${t.backdrop_path}` : null,
      voteAverage: t.vote_average ?? null,
      voteCount: t.vote_count ?? null,
      popularity: t.popularity ?? null,
      budget: t.budget ?? null,
      revenue: t.revenue ?? null,
      productionCompanies: (t.production_companies ?? []).slice(0, 6).map((c) => c.name),
      productionCountries: (t.production_countries ?? []).map((c) => c.name),
      spokenLanguages: (t.spoken_languages ?? []).map((l) => l.english_name ?? l.name),
      crew: {
        director: dir ? { name: dir.name, profile: dir.profile_path ? `https://image.tmdb.org/t/p/w185${dir.profile_path}` : null } : null,
        writer: writer?.name ?? null,
        dop: dop?.name ?? null,
        composer: composer?.name ?? null,
        editor: editor?.name ?? null,
      },
      cast: slimCast,
      external: { imdb: ext.imdb_id ?? null, wikidata: ext.wikidata_id ?? null, instagram: ext.instagram_id ?? null },
      collection: t.belongs_to_collection ? {
        id: t.belongs_to_collection.id, name: t.belongs_to_collection.name,
        poster: t.belongs_to_collection.poster_path ? `https://image.tmdb.org/t/p/w500${t.belongs_to_collection.poster_path}` : null,
      } : null,
    };
    hits++;
  }
  await writeFile(resolve(INTERNAL, 'enrichment.json'), JSON.stringify(enrichment));
  // Mirror the build-time aggregate to the committable snapshot location.
  // That way the daily workflow can git-add a single fresh JSON that next
  // run will read as its skip-list + render-data baseline.
  await writeFile(TMDB_SNAPSHOT_PATH, JSON.stringify(enrichment));
  // Also remove any old copy from public/ that older builds left behind.
  await rm(resolve(PUB, 'enrichment.json'), { force: true });
  console.log(
    `[sync] enrichment — ${hits} fresh hits + ${misses} fresh misses, ` +
    `${snapshotKeys.size} from committed snapshot ` +
    `→ ${Object.keys(enrichment).length} total entries written to ` +
    `src/_data/enrichment.json + data/processed/tmdb-enrichment.json`,
  );
} catch (e) {
  console.warn(`[sync] enrichment skipped: ${e.message}`);
  await writeFile(resolve(INTERNAL, 'enrichment.json'), '{}');
}

// ----- 3a. tmdb-ratings.json (for scatter plot) -----
const tmdbRatings = {};
for (const [id, e] of Object.entries(enrichment)) {
  if (e.miss) continue;
  if (e.voteAverage != null && e.voteCount && e.voteCount >= 10) {
    tmdbRatings[id] = { v: e.voteAverage, c: e.voteCount };
  }
}
await writeFile(resolve(PUB, 'tmdb-ratings.json'), JSON.stringify(tmdbRatings));
console.log(`[sync] tmdb-ratings.json — ${Object.keys(tmdbRatings).length} entries, ${kb(JSON.stringify(tmdbRatings).length)}`);

// ----- 3b. external-ratings.json (IMDb + Rotten Tomatoes + Metacritic) -----
// Built from imdb-ratings.json (script fetch-imdb-ratings.mjs) and
// omdb-ratings.json (script fetch-omdb.mjs). Either may be absent during
// early-stage builds; the merge just emits whatever is available.
let imdbLookup = {};
try { imdbLookup = JSON.parse(await readFile(IMDB_RATINGS_PATH, 'utf8')); } catch {}
let omdbLookup = {};
try { omdbLookup = JSON.parse(await readFile(OMDB_RATINGS_PATH, 'utf8')); } catch {}

const externalRatings = {};
for (const [reviewId, e] of Object.entries(enrichment)) {
  if (e.miss) continue;
  const imdb = e.external?.imdb;
  if (!imdb) continue;
  const i = imdbLookup[imdb];
  const o = omdbLookup[imdb];
  const row = {};
  // Prefer the IMDb dataset's rating (canonical) over OMDb's cached IMDb rating.
  if (i?.rating != null) { row.imdb = i.rating; row.imdbVotes = i.votes ?? null; }
  else if (o?.imdbRating != null) { row.imdb = o.imdbRating; row.imdbVotes = o.imdbVotes ?? null; }
  if (o?.rt != null) row.rt = o.rt;
  if (o?.metacritic != null) row.mc = o.metacritic;
  if (Object.keys(row).length) externalRatings[reviewId] = row;
}
await writeFile(resolve(PUB, 'external-ratings.json'), JSON.stringify(externalRatings));
const withImdb = Object.values(externalRatings).filter((r) => r.imdb != null).length;
const withRt = Object.values(externalRatings).filter((r) => r.rt != null).length;
const withMc = Object.values(externalRatings).filter((r) => r.mc != null).length;
console.log(`[sync] external-ratings.json — ${Object.keys(externalRatings).length} entries (${withImdb} IMDb, ${withRt} RT, ${withMc} Metacritic), ${kb(JSON.stringify(externalRatings).length)}`);

// ----- 4. Pre-computed stats aggregate for /stats -----
const stats = computeStats(slim, tmdbRatings, enrichment, externalRatings);
await writeFile(resolve(PUB, 'stats.json'), JSON.stringify(stats));
console.log(`[sync] stats.json (full aggregate) — ${kb(JSON.stringify(stats).length)}`);

// ----- 5. people.json — slim person index for the global search palette -----
const people = computePeopleIndex(slim, enrichment);
await writeFile(resolve(PUB, 'people.json'), JSON.stringify(people));
console.log(`[sync] people.json — ${people.length} entries, ${kb(JSON.stringify(people).length)}`);

function computeStats(reviews, tmdb, enrichment, externalRatings) {
  const yearOf = (r) => Number(r.publishedAt?.slice(0, 4)) || 0;
  const slugOf = (r) => slugify(r);

  const total = reviews.length;
  const rated = reviews.filter((r) => r.rating != null);
  const avg = rated.length ? rated.reduce((s, r) => s + (r.rating ?? 0), 0) / rated.length : 0;

  const ratingHist = [0,0,0,0,0,0];
  for (const r of rated) if (r.rating >= 1 && r.rating <= 6) ratingHist[r.rating - 1]++;

  // per year
  const yearMap = new Map();
  for (const r of reviews) {
    const y = yearOf(r); if (!y) continue;
    const cur = yearMap.get(y) ?? { n: 0, sum: 0, rated: 0, byRating: [0,0,0,0,0,0] };
    cur.n++;
    if (r.rating != null) {
      cur.sum += r.rating; cur.rated++;
      if (r.rating >= 1 && r.rating <= 6) cur.byRating[r.rating - 1]++;
    }
    yearMap.set(y, cur);
  }
  const reviewsPerYear = [...yearMap.entries()].sort((a, b) => a[0] - b[0])
    .map(([year, v]) => ({ year, n: v.n, rated: v.rated, avg: v.rated ? v.sum / v.rated : null, byRating: v.byRating }));

  // decade ledger
  const decMap = new Map();
  for (const r of reviews) {
    const y = yearOf(r); if (!y) continue;
    const d = Math.floor(y / 10) * 10;
    const cur = decMap.get(d) ?? { n: 0, sum: 0, rated: 0, sixes: 0, ones: 0 };
    cur.n++;
    if (r.rating != null) {
      cur.sum += r.rating; cur.rated++;
      if (r.rating === 6) cur.sixes++;
      if (r.rating === 1) cur.ones++;
    }
    decMap.set(d, cur);
  }
  const decades = [...decMap.entries()].sort((a, b) => a[0] - b[0])
    .map(([decade, v]) => ({ decade, n: v.n, avg: v.rated ? v.sum / v.rated : null, sixes: v.sixes, ones: v.ones }));

  // top directors (incl. serieskaper)
  const credMap = new Map();
  for (const r of reviews) {
    const v = r.factbox?.regi ?? r.factbox?.serieskaper;
    if (!v) continue;
    for (const name of String(v).split(/\s+og\s+/)) {
      const k = name.trim();
      if (!k) continue;
      const cur = credMap.get(k) ?? { n: 0, sum: 0, rated: 0 };
      cur.n++;
      if (r.rating != null) { cur.sum += r.rating; cur.rated++; }
      credMap.set(k, cur);
    }
  }
  const topDirectors = [...credMap.entries()]
    .filter(([, v]) => v.n >= 3)
    .map(([name, v]) => ({ name, slug: personSlug(name), n: v.n, avg: v.rated ? v.sum / v.rated : null }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 18);

  // genres
  const gMap = new Map();
  for (const r of reviews)
    for (const g of r.factbox?.sjanger ?? []) {
      const k = g.toLowerCase().trim();
      if (!k) continue;
      const cur = gMap.get(k) ?? { n: 0, sum: 0, rated: 0 };
      cur.n++;
      if (r.rating != null) { cur.sum += r.rating; cur.rated++; }
      gMap.set(k, cur);
    }
  const topGenres = [...gMap.entries()]
    .map(([key, v]) => ({ key, n: v.n, avg: v.rated ? v.sum / v.rated : null }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 24);

  // scatter (Birger × TMDB)
  const scatter = [];
  for (const r of reviews) {
    if (r.rating == null) continue;
    const t = tmdb[r.id];
    if (!t) continue;
    const birgerNorm = ((r.rating - 1) / 5) * 10;
    scatter.push({
      id: r.id,
      slug: slugOf(r),
      name: r.name,
      birger: r.rating,
      tmdb: Math.round(t.v * 100) / 100,
      diff: Math.round((birgerNorm - t.v) * 100) / 100,
    });
  }

  // scatter (Birger × IMDb) — points share an `id` so we can cross-reference.
  const scatterImdb = [];
  for (const r of reviews) {
    if (r.rating == null) continue;
    const e = externalRatings?.[r.id];
    if (!e || e.imdb == null) continue;
    const birgerNorm = ((r.rating - 1) / 5) * 10;
    scatterImdb.push({
      id: r.id,
      slug: slugOf(r),
      name: r.name,
      birger: r.rating,
      imdb: Math.round(e.imdb * 100) / 100,
      votes: e.imdbVotes ?? null,
      diff: Math.round((birgerNorm - e.imdb) * 100) / 100,
    });
  }

  // scatter (Birger × Rotten Tomatoes) — RT is 0..100, normalize Birger to same.
  const scatterRt = [];
  for (const r of reviews) {
    if (r.rating == null) continue;
    const e = externalRatings?.[r.id];
    if (!e || e.rt == null) continue;
    const birgerPct = ((r.rating - 1) / 5) * 100;
    scatterRt.push({
      id: r.id,
      slug: slugOf(r),
      name: r.name,
      birger: r.rating,
      rt: e.rt,
      diff: Math.round((birgerPct - e.rt) * 100) / 100,
    });
  }

  // scatter (Birger × Metacritic)
  const scatterMc = [];
  for (const r of reviews) {
    if (r.rating == null) continue;
    const e = externalRatings?.[r.id];
    if (!e || e.mc == null) continue;
    const birgerPct = ((r.rating - 1) / 5) * 100;
    scatterMc.push({
      id: r.id,
      slug: slugOf(r),
      name: r.name,
      birger: r.rating,
      mc: e.mc,
      diff: Math.round((birgerPct - e.mc) * 100) / 100,
    });
  }

  // Cross-source averages by Birger rating bucket — "when Birger gives a 6,
  // what does IMDb / RT / Metacritic typically say?"
  const ratingBuckets = {};
  for (let b = 1; b <= 6; b++) {
    const subset = reviews.filter((r) => r.rating === b);
    const tmdbVals = subset.map((r) => tmdb[r.id]?.v).filter((x) => x != null);
    const imdbVals = subset.map((r) => externalRatings?.[r.id]?.imdb).filter((x) => x != null);
    const rtVals = subset.map((r) => externalRatings?.[r.id]?.rt).filter((x) => x != null);
    const mcVals = subset.map((r) => externalRatings?.[r.id]?.mc).filter((x) => x != null);
    const avg = (xs) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
    ratingBuckets[b] = {
      n: subset.length,
      tmdb: tmdbVals.length ? Math.round(avg(tmdbVals) * 100) / 100 : null,
      imdb: imdbVals.length ? Math.round(avg(imdbVals) * 100) / 100 : null,
      rt: rtVals.length ? Math.round(avg(rtVals)) : null,
      mc: mcVals.length ? Math.round(avg(mcVals)) : null,
      tmdbN: tmdbVals.length,
      imdbN: imdbVals.length,
      rtN: rtVals.length,
      mcN: mcVals.length,
    };
  }

  // year × rating heatmap
  const heatmapYears = reviewsPerYear.map((x) => x.year);
  const heatmap = { years: heatmapYears, byRating: reviewsPerYear.map((x) => x.byRating) };

  // headline word analysis
  const STOPWORDS = new Set('og i en et som er for av at det med på til den de har var er ikke har men eller etter mot fra også så bare hva hvem hvor hvorfor da når sin sitt seg the a an is are be of to in for and or but with this that not no but yet still much very less few many one two three four five ja nei jo nok seg sin sitt sine hans hennes deres dere meg deg blir bli ble blitt alle noen hver hvert her dit der opp ned ut inn første andre tredje ny nye nytt god gode godt bra kan skal vil må veldig svært ganske ennå litt mye mer mest over under noen få mange noe alt én ett to tre fire fem seks syv åtte ni ti'.split(/\s+/));
  const wMap = new Map();
  for (const r of reviews) {
    if (!r.headline || r.rating == null) continue;
    const tokens = r.headline.toLowerCase()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[«»"'.,!?:;()—–…]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 4 && !STOPWORDS.has(t) && !/^\d/.test(t));
    for (const t of new Set(tokens)) {
      const cur = wMap.get(t) ?? { count: 0, sum: 0 };
      cur.count++; cur.sum += r.rating;
      wMap.set(t, cur);
    }
  }
  const words = [...wMap.entries()]
    .filter(([, v]) => v.count >= 4)              // surface richer vocabulary
    .map(([token, v]) => ({ token, count: v.count, avg: Math.round((v.sum / v.count) * 1000) / 1000 }))
    .sort((a, b) => b.count - a.count);

  // type counts
  const types = { Movie: 0, TVSeries: 0, Game: 0 };
  for (const r of reviews) {
    if (r.type === 'Movie') types.Movie++;
    else if (r.type === 'TVSeries') types.TVSeries++;
    else if (r.type === 'Game' || r.type === 'VideoGame') types.Game++;
  }

  // ----- "Fun lists" — top-N tallies over various dimensions -----

  // Helper: tally a (key → {n, sum, rated, slug?}) map into a sorted top-N
  // array of { key, n, avg, slug }, optionally with a min-N gate.
  const collect = (rows, opts = {}) => {
    const minN = opts.minN ?? 3;
    const limit = opts.limit ?? 18;
    const sortBy = opts.sortBy ?? 'n';        // 'n' | 'avg-desc' | 'avg-asc'
    const arr = [...rows.entries()]
      .filter(([, v]) => v.n >= minN)
      .map(([key, v]) => ({
        key, n: v.n,
        avg: v.rated ? Math.round((v.sum / v.rated) * 1000) / 1000 : null,
        ...(opts.withSlug ? { slug: personSlug(key) } : {}),
        ...(opts.profileFor ? { profile: opts.profileFor.get(key) ?? null } : {}),
      }));
    if (sortBy === 'avg-desc') arr.sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1) || b.n - a.n);
    else if (sortBy === 'avg-asc') arr.sort((a, b) => (a.avg ?? 99) - (b.avg ?? 99) || b.n - a.n);
    else arr.sort((a, b) => b.n - a.n);
    return arr.slice(0, limit);
  };

  // Per-review tally helpers
  const tallyByName = (extract) => {
    const m = new Map();
    for (const r of reviews) {
      for (const name of extract(r)) {
        const k = name.trim();
        if (!k) continue;
        const cur = m.get(k) ?? { n: 0, sum: 0, rated: 0 };
        cur.n++;
        if (r.rating != null) { cur.sum += r.rating; cur.rated++; }
        m.set(k, cur);
      }
    }
    return m;
  };

  // Profile photos collected from TMDB enrichment so person rankings can
  // show a portrait. Same case-insensitive trick as lib/people.ts.
  const profileExact = new Map();
  const profileFold = new Map();
  const fold = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();
  if (enrichment) {
    for (const e of Object.values(enrichment)) {
      if (!e || e.miss) continue;
      if (e.crew?.director?.profile && e.crew.director.name) {
        if (!profileExact.has(e.crew.director.name)) profileExact.set(e.crew.director.name, e.crew.director.profile);
        const k = fold(e.crew.director.name);
        if (k && !profileFold.has(k)) profileFold.set(k, e.crew.director.profile);
      }
      for (const c of e.cast ?? []) {
        if (c.profile && c.name) {
          if (!profileExact.has(c.name)) profileExact.set(c.name, c.profile);
          const k = fold(c.name);
          if (k && !profileFold.has(k)) profileFold.set(k, c.profile);
        }
      }
    }
  }
  // Single lookup helper
  const profileFor = new Map();   // key (raw name) → URL
  const lookupProfile = (name) => profileExact.get(name) ?? profileFold.get(fold(name)) ?? null;
  // We pre-populate after we know which names to ask for, but for `collect()`
  // it's easier to prebuild on the fly per list:
  const profilesFor = (names) => {
    const m = new Map();
    for (const name of names) {
      const url = lookupProfile(name);
      if (url) m.set(name, url);
    }
    return m;
  };

  // ----- Cast / actors (NRK skuespillere + TMDB cast) -----
  const actorMap = tallyByName((r) => {
    const out = [];
    for (const n of r.factbox?.skuespillere ?? []) out.push(n);
    const e = enrichment?.[r.id];
    if (e && !e.miss) for (const c of e.cast ?? []) out.push(c.name);
    return out;
  });
  // Dedupe per-(name, review) so an actor double-counted (NRK and TMDB) isn't
  // double-counted in the totals.
  const dedupActor = new Map();
  for (const r of reviews) {
    const seen = new Set();
    const all = [];
    for (const n of r.factbox?.skuespillere ?? []) all.push(n);
    const e = enrichment?.[r.id];
    if (e && !e.miss) for (const c of e.cast ?? []) all.push(c.name);
    for (const n of all) {
      const key = (n ?? '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const cur = dedupActor.get(key) ?? { n: 0, sum: 0, rated: 0 };
      cur.n++;
      if (r.rating != null) { cur.sum += r.rating; cur.rated++; }
      dedupActor.set(key, cur);
    }
  }
  const actorNames = [...dedupActor.keys()];
  const topActors = collect(dedupActor, { minN: 4, limit: 24, withSlug: true, profileFor: profilesFor(actorNames) });

  // ----- Cinematographers (NRK foto + TMDB DOP) -----
  const dopMap = tallyByName((r) => {
    const out = [];
    if (r.factbox?.foto) for (const n of String(r.factbox.foto).split(/\s+og\s+|,\s*/i)) out.push(n);
    const e = enrichment?.[r.id];
    if (e && !e.miss && e.crew?.dop) out.push(e.crew.dop);
    return out;
  });
  const topCinematographers = collect(dopMap, { minN: 3, limit: 18, withSlug: true });

  // ----- Composers (NRK musikk + TMDB composer) -----
  const composerMap = tallyByName((r) => {
    const out = [];
    if (r.factbox?.musikk) for (const n of String(r.factbox.musikk).split(/\s+og\s+|,\s*/i)) out.push(n);
    const e = enrichment?.[r.id];
    if (e && !e.miss && e.crew?.composer) out.push(e.crew.composer);
    return out;
  });
  const topComposers = collect(composerMap, { minN: 3, limit: 18, withSlug: true });

  // ----- Editors (NRK klipp + TMDB editor) -----
  const editorMap = tallyByName((r) => {
    const out = [];
    if (r.factbox?.klipp) for (const n of String(r.factbox.klipp).split(/\s+og\s+|,\s*/i)) out.push(n);
    const e = enrichment?.[r.id];
    if (e && !e.miss && e.crew?.editor) out.push(e.crew.editor);
    return out;
  });
  const topEditors = collect(editorMap, { minN: 3, limit: 18, withSlug: true });

  // ----- Distributors -----
  const distMap = tallyByName((r) => r.factbox?.distributor ? [r.factbox.distributor] : []);
  const topDistributors = collect(distMap, { minN: 6, limit: 18 });

  // ----- Production countries (TMDB) -----
  const countryMap = new Map();
  for (const r of reviews) {
    const e = enrichment?.[r.id];
    if (!e || e.miss) continue;
    for (const c of e.productionCountries ?? []) {
      const cur = countryMap.get(c) ?? { n: 0, sum: 0, rated: 0 };
      cur.n++;
      if (r.rating != null) { cur.sum += r.rating; cur.rated++; }
      countryMap.set(c, cur);
    }
  }
  const topCountries = collect(countryMap, { minN: 4, limit: 18 });

  // ----- Spoken languages (TMDB) -----
  const langMap = new Map();
  for (const r of reviews) {
    const e = enrichment?.[r.id];
    if (!e || e.miss) continue;
    for (const l of e.spokenLanguages ?? []) {
      if (!l || l === 'No Language') continue;
      const cur = langMap.get(l) ?? { n: 0, sum: 0, rated: 0 };
      cur.n++;
      if (r.rating != null) { cur.sum += r.rating; cur.rated++; }
      langMap.set(l, cur);
    }
  }
  const topLanguages = collect(langMap, { minN: 4, limit: 18 });

  // ----- "Birgers strengeste regissører" — directors with the lowest avg
  //         (min 3 reviews so it's not noise). Companion to topDirectors. -----
  const dirMap = new Map();
  for (const r of reviews) {
    const v = r.factbox?.regi ?? r.factbox?.serieskaper;
    if (!v) continue;
    for (const name of String(v).split(/\s+og\s+/)) {
      const k = name.trim();
      if (!k) continue;
      const cur = dirMap.get(k) ?? { n: 0, sum: 0, rated: 0 };
      cur.n++;
      if (r.rating != null) { cur.sum += r.rating; cur.rated++; }
      dirMap.set(k, cur);
    }
  }
  const lovedDirectors = collect(dirMap, { minN: 3, limit: 12, withSlug: true, sortBy: 'avg-desc', profileFor: profilesFor([...dirMap.keys()]) });
  const harshDirectors = collect(dirMap, { minN: 3, limit: 12, withSlug: true, sortBy: 'avg-asc', profileFor: profilesFor([...dirMap.keys()]) });

  // ----- Highest- and lowest-rated genres (with ≥10 reviews) -----
  const lovedGenres = collect(gMap, { minN: 10, limit: 8, sortBy: 'avg-desc' });
  const harshGenres = collect(gMap, { minN: 10, limit: 8, sortBy: 'avg-asc' });

  // ----- "Birgers favoritter per år" — single highest-rated review of each year -----
  const yearTopByYear = new Map();
  for (const r of reviews) {
    if (!r.rating) continue;
    const y = yearOf(r); if (!y) continue;
    const cur = yearTopByYear.get(y);
    if (!cur || (r.rating > cur.rating) || (r.rating === cur.rating && (r.publishedAt ?? '') > (cur.publishedAt ?? ''))) {
      yearTopByYear.set(y, r);
    }
  }
  const yearFavorites = [...yearTopByYear.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, r]) => ({
      year, id: r.id, slug: slugOf(r), name: r.name, rating: r.rating,
      regi: r.factbox?.regi ?? r.factbox?.serieskaper ?? null,
    }));

  // Year range
  const years = reviews.map(yearOf).filter(Boolean);

  return {
    builtAt: new Date().toISOString(),
    total,
    rated: rated.length,
    avg: Math.round(avg * 1000) / 1000,
    yearMin: Math.min(...years),
    yearMax: Math.max(...years),
    types,
    ratingHist,
    reviewsPerYear,
    decades,
    topDirectors,
    topGenres,
    scatter,
    heatmap,
    words,
    perfect6: ratingHist[5],
    worst1: ratingHist[0],
    notRated: total - rated.length,
    // New for v3
    topActors,
    topCinematographers,
    topComposers,
    topEditors,
    topDistributors,
    topCountries,
    topLanguages,
    lovedDirectors,
    harshDirectors,
    lovedGenres,
    harshGenres,
    yearFavorites,
    // External rating cross-references
    scatterImdb,
    scatterRt,
    scatterMc,
    ratingBuckets,
    coverage: {
      imdb: scatterImdb.length,
      rt: scatterRt.length,
      mc: scatterMc.length,
    },
  };
}

// ---------- people index for global search ----------
function computePeopleIndex(reviews, enrichment) {
  // Tally every person who shows up anywhere (factbox or TMDB) and emit a
  // single row with their primary role + counts. This is what the search
  // palette searches against.
  const map = new Map();   // slug → { name, profile, asDirector, asCreator, asActor, asWriter, n, sum, rated }
  const profileExact = new Map();
  const profileFold = new Map();
  const fold = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();

  for (const e of Object.values(enrichment)) {
    if (!e || e.miss) continue;
    if (e.crew?.director?.profile && e.crew.director.name) {
      if (!profileExact.has(e.crew.director.name)) profileExact.set(e.crew.director.name, e.crew.director.profile);
      const k = fold(e.crew.director.name);
      if (k && !profileFold.has(k)) profileFold.set(k, e.crew.director.profile);
    }
    for (const c of e.cast ?? []) {
      if (c.profile && c.name) {
        if (!profileExact.has(c.name)) profileExact.set(c.name, c.profile);
        const k = fold(c.name);
        if (k && !profileFold.has(k)) profileFold.set(k, c.profile);
      }
    }
  }
  const lookup = (name) => profileExact.get(name) ?? profileFold.get(fold(name)) ?? null;

  function bump(name, role, rating) {
    if (!name || name.length < 2) return;
    const slug = personSlug(name);
    let p = map.get(slug);
    if (!p) {
      p = { slug, name, profile: lookup(name), asDirector: 0, asCreator: 0, asWriter: 0, asActor: 0, n: 0, sum: 0, rated: 0 };
      map.set(slug, p);
    }
    if (role === 'director') p.asDirector++;
    else if (role === 'creator') p.asCreator++;
    else if (role === 'writer') p.asWriter++;
    else p.asActor++;
    p.n++;
    if (rating != null) { p.sum += rating; p.rated++; }
  }
  function splitNames(s) {
    return (s ?? '').split(/\s+og\s+|,\s*/i).map((x) => x.trim()).filter((x) => x.length >= 2);
  }
  for (const r of reviews) {
    for (const n of splitNames(r.factbox?.regi)) bump(n, 'director', r.rating);
    for (const n of splitNames(r.factbox?.serieskaper)) bump(n, 'creator', r.rating);
    for (const n of splitNames(r.factbox?.manus)) bump(n, 'writer', r.rating);
    for (const n of (r.factbox?.skuespillere ?? [])) bump((n ?? '').trim(), 'actor', r.rating);
    const e = enrichment[r.id];
    if (e && !e.miss) for (const c of e.cast ?? []) bump(c.name, 'actor', r.rating);
  }

  const out = [];
  for (const p of map.values()) {
    // Same eligibility as people.ts — keep search results aligned with the
    // pages that actually exist.
    const eligible = p.n >= 2 || ((p.asDirector + p.asCreator) >= 1 && p.profile);
    if (!eligible) continue;
    out.push({
      slug: p.slug,
      name: p.name,
      profile: p.profile,
      n: p.n,
      avg: p.rated ? Math.round((p.sum / p.rated) * 100) / 100 : null,
      role:
        p.asDirector >= p.asActor && p.asDirector > 0 ? 'director' :
        p.asCreator > 0 ? 'creator' :
        p.asActor > 0 ? 'actor' : 'writer',
    });
  }
  out.sort((a, b) => b.n - a.n);
  return out;
}

// Review slug: <name-slug>-<idTail> — the trailing id keeps title-clashes apart.
function slugify(r) {
  const tail = (r.id ?? '').split('.').pop() ?? '';
  const base = nameSlug(r.name);
  return `${base}-${tail}`;
}

// Person slug: pure name slug, no id tail. Same logic as src/lib/slug.ts.
function personSlug(name) {
  return nameSlug(name);
}

function nameSlug(name) {
  const ascii = (name ?? '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (ascii) return ascii;
  let h = 0x811c9dc5;
  const s = String(name ?? '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `n-${(h >>> 0).toString(36).padStart(7, '0').slice(-7)}`;
}

function kb(n) { return `${(n / 1024).toFixed(1)} KB`; }
