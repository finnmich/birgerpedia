#!/usr/bin/env node
// Read all parsed per-article JSONs and produce the master dataset.
//
//   data/processed/reviews.json   — pretty array, suitable for committing
//   data/processed/reviews.ndjson — one record per line, easy to grep
//   data/processed/stats.json     — top-level counts, mostly for sanity
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

const BIRGER_ID = '18.264';

async function main() {
  await ensureDir(OUT_DIR);
  const files = (await readdir(ARTICLES_DIR)).filter((f) => f.endsWith('.json') && !f.startsWith('_'));

  const records = [];
  let dropped = 0;
  for (const f of files) {
    const r = JSON.parse(await readFile(resolve(ARTICLES_DIR, f), 'utf8'));
    if (!r || !r.id) { dropped++; continue; }
    if (r.author?.id && r.author.id !== BIRGER_ID) { dropped++; continue; }
    records.push(r);
  }

  records.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));

  const slim = records.map((r) => ({
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
  }));

  await atomicWriteJson(resolve(OUT_DIR, 'reviews.json'), slim);
  await atomicWrite(resolve(OUT_DIR, 'reviews.ndjson'), slim.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // stats
  const byType = tally(slim, (r) => r.type);
  const byRating = tally(slim, (r) => r.rating);
  const byPlatform = tally(slim, (r) => r.platform);
  const byYear = tally(slim, (r) => r.publishedAt?.slice(0, 4));
  const stats = {
    builtAt: new Date().toISOString(),
    total: slim.length,
    droppedNonBirgerOrInvalid: dropped,
    byType, byRating, byPlatform, byYearTop10: top(byYear, 10),
    yearRange: yearRange(slim),
  };
  await atomicWriteJson(resolve(OUT_DIR, 'stats.json'), stats);

  console.log(`[build] wrote ${slim.length} reviews to data/processed/`);
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
