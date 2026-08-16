#!/usr/bin/env node
// Read all parsed per-article JSONs and produce the master dataset.
//
//   data/processed/reviews.json   — pretty array, suitable for committing
//   data/processed/reviews.ndjson — one record per line, easy to grep
//   data/processed/stats.json     — top-level counts, mostly for sanity
//
// Incremental by default: starts from the existing committed
// data/processed/reviews.json (1 BLOB ~2.7 MB) and merges in whatever
// per-article JSONs are present in data/raw/articles/ (newly fetched).
// This means a CI cold-start with an empty raw-articles cache produces
// a non-empty output by trusting what's already committed, instead of
// silently regressing to an empty digest.
//
// Filters: keep only records with @type === Review (parser already
// guarantees this) AND author.id === '18.264' (drops the few collab
// pieces). bodyText is dropped from the public dataset to keep it small;
// rawHtmlPath stays so the site can deep-link back to NRK.

import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, atomicWriteJson, ensureDir } from './util.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARTICLES_DIR = resolve(ROOT, 'data/raw/articles');
const OUT_DIR = resolve(ROOT, 'data/processed');
const REVIEWS_OUT = resolve(OUT_DIR, 'reviews.json');
// Hand-verified types for pre-2009 articles whose pages carry no
// schema.org itemReviewed for the parser to read one off. See the note in
// the file itself — entries are added only after reading the review.
const TYPE_OVERRIDES = resolve(ROOT, 'data/type-overrides.json');

const BIRGER_ID = '18.264';

// Mirrors reviewTypeFromItemType in parse-article.mjs, so an overridden
// type and the label rendered next to it can't drift apart.
const REVIEW_TYPE_LABEL = { Movie: 'Film', TVSeries: 'Serie', Game: 'Spill', VideoGame: 'Spill' };

function slim(r) {
  return {
    id: r.id,
    url: r.url,
    type: r.type,
    name: r.name,
    originalTitle: r.originalTitle ?? null,
    headline: r.headline,
    abstract: r.abstract,
    rating: r.rating,
    ratingMax: r.ratingMax,
    publishedAt: r.publishedAt,
    modifiedAt: r.modifiedAt,
    author: r.author,
    image: r.image,
    section: r.section,
    platform: r.platform,
    reviewType: r.reviewType,
    factbox: r.factbox,
    wordCount: r.wordCount,
  };
}

async function main() {
  await ensureDir(OUT_DIR);

  // Start from the committed digest. On CI cold-start this is the only
  // thing we have. On a local dev machine with a full raw/articles cache,
  // we'll completely overwrite each record below.
  const byId = new Map();
  let baselineCount = 0;
  try {
    const existing = JSON.parse(await readFile(REVIEWS_OUT, 'utf8'));
    for (const r of existing) {
      if (r?.id) byId.set(r.id, r);
    }
    baselineCount = byId.size;
  } catch { /* no prior digest; first build ever */ }

  // Merge in fresh per-article JSONs. These exist for any article that the
  // current run actually fetched (or had cached locally as raw HTML).
  let merged = 0, droppedNotBirger = 0, droppedInvalid = 0;
  let articleFiles = [];
  try { articleFiles = (await readdir(ARTICLES_DIR)).filter((f) => f.endsWith('.json') && !f.startsWith('_')); }
  catch { /* empty cache on CI cold start — that's fine */ }

  for (const f of articleFiles) {
    let r;
    try { r = JSON.parse(await readFile(resolve(ARTICLES_DIR, f), 'utf8')); }
    catch { droppedInvalid++; continue; }
    if (!r || !r.id) { droppedInvalid++; continue; }
    if (r.author?.id && r.author.id !== BIRGER_ID) { droppedNotBirger++; continue; }
    byId.set(r.id, slim(r));
    merged++;
  }

  // Apply the verified type overrides last, so they land on records from
  // either source (freshly parsed or carried over from the digest).
  let overridden = 0;
  try {
    const { types } = JSON.parse(await readFile(TYPE_OVERRIDES, 'utf8'));
    for (const [id, o] of Object.entries(types ?? {})) {
      const r = byId.get(id);
      if (!r || !o?.type || r.type === o.type) continue;
      r.type = o.type;
      r.reviewType ??= REVIEW_TYPE_LABEL[o.type] ?? null;
      overridden++;
    }
  } catch { /* no override file — every type comes from the markup */ }

  const records = [...byId.values()]
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));

  await atomicWriteJson(REVIEWS_OUT, records);
  await atomicWrite(resolve(OUT_DIR, 'reviews.ndjson'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  console.log(
    `[build] baseline ${baselineCount} + merged ${merged} ` +
    `(dropped ${droppedNotBirger} non-Birger, ${droppedInvalid} invalid, ` +
    `${overridden} types from verified overrides) ` +
    `→ ${records.length} reviews.`,
  );
  // Reassign so the legacy stats block below keeps working unchanged.
  // eslint-disable-next-line no-var
  var slim_records = records;

  // stats
  const byType = tally(slim_records, (r) => r.type);
  const byRating = tally(slim_records, (r) => r.rating);
  const byPlatform = tally(slim_records, (r) => r.platform);
  const byYear = tally(slim_records, (r) => r.publishedAt?.slice(0, 4));
  const stats = {
    builtAt: new Date().toISOString(),
    total: slim_records.length,
    droppedNonBirgerOrInvalid: droppedNotBirger + droppedInvalid,
    byType, byRating, byPlatform, byYearTop10: top(byYear, 10),
    yearRange: yearRange(slim_records),
  };
  await atomicWriteJson(resolve(OUT_DIR, 'stats.json'), stats);

  console.log(`[build] type:`, byType);
  console.log(`[build] rating:`, byRating);
  console.log(`[build] year range:`, stats.yearRange);
}

function tally(items, keyFn) {
  const out = {};
  for (const it of items) {
    const k = keyFn(it) ?? '∅';
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

function top(obj, n) {
  return Object.fromEntries(Object.entries(obj).slice(0, n));
}

function yearRange(items) {
  const ys = items.map((r) => r.publishedAt?.slice(0, 4)).filter(Boolean).sort();
  return { earliest: ys[0] ?? null, latest: ys.at(-1) ?? null };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
