#!/usr/bin/env node
// Read data/raw/listing/index.json, fetch each article that hasn't been
// fetched yet, save raw HTML + parsed JSON next to it.
//
// Usage:
//   node scripts/crawl-articles.mjs               # all articles
//   node scripts/crawl-articles.mjs --limit=20    # first 20 (smoke test)
//   node scripts/crawl-articles.mjs --refresh     # re-fetch even if cached
//   node scripts/crawl-articles.mjs --recheck=0   # don't re-visit known non-reviews

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RateLimiter,
  politeFetch,
  atomicWrite,
  atomicWriteJson,
  readJsonIfExists,
  ensureDir,
  fileExists,
  idFromUrl,
} from './util.mjs';
import { parseArticle } from './parse-article.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARTICLES_DIR = resolve(ROOT, 'data/raw/articles');
const INDEX_PATH = resolve(ROOT, 'data/raw/listing/index.json');
// The slim digest committed to the repo. We use it as a known-IDs skip list:
// if the article's already in here, we've parsed it on a prior run (some
// branch / CI run / local dev) and don't need to re-bother NRK.
const PROCESSED_REVIEWS = resolve(ROOT, 'data/processed/reviews.json');
// The mirror image: plugs we fetched and found are NOT reviews (news,
// interviews, festival round-ups, top-10 lists). Committed so a cold CI
// cache doesn't re-fetch a thousand known non-reviews from NRK every
// morning.
const NOT_REVIEW_PATH = resolve(ROOT, 'data/raw/listing/not-review.json');

// Non-reviews are re-checked eventually rather than blacklisted forever:
// NRK does re-migrate old articles, and some pre-2009 /kultur/ pages have
// since gained the schema.org Review markup they originally shipped
// without. Each run re-fetches the N least-recently-checked entries, so
// the whole skip list rotates through in a few weeks for N requests a day.
const DEFAULT_RECHECK = 25;

const argv = parseArgs(process.argv.slice(2));

async function main() {
  await ensureDir(ARTICLES_DIR);
  const index = JSON.parse(await readFile(INDEX_PATH, 'utf8'));
  const limiter = new RateLimiter({ minIntervalMs: 1000 });

  // Load whatever's already been committed. Two-tier "known" check:
  //   (a) raw HTML is on disk (this run or a previous local cache)  → use it
  //   (b) ID is already in the committed slim dataset                → skip entirely
  // Without (b), CI cold-starts would re-fetch every single article from
  // NRK on the first deploy — the Actions cache is empty, so every .html
  // is missing locally, yet the work was already done on a prior machine.
  let knownIdsInDigest = new Set();
  try {
    const slim = JSON.parse(await readFile(PROCESSED_REVIEWS, 'utf8'));
    knownIdsInDigest = new Set(slim.map((r) => r.id));
  } catch { /* no prior digest — fresh project, fetch everything */ }

  // Every plug is a candidate. NRK's slugs have shifted repeatedly across
  // 25 years — `anmeldelse_-_`, `anmeldelse_--_`, `anmeldelse---`,
  // `spillanmeldelse-`, and before ~2009 no marker at all
  // (/kultur/kill-bill-volume-1-1.534840) — so URL shape is not a usable
  // signal for review-ness. Gating on it silently dropped ~700 real
  // reviews, most of Birger's 2001–2012 back catalogue. parseArticle's
  // Review JSON-LD check is the only authority; NOT_REVIEW_PATH below
  // keeps us from re-fetching what it has already rejected.
  const all = index.plugs ?? [];
  let targets;
  if (argv.sample) {
    // Stratified sample: take N items spread evenly across the (already
    // newest→oldest) list so smoke tests touch every era.
    const N = argv.sample;
    targets = [];
    if (all.length <= N) targets = all;
    else {
      for (let i = 0; i < N; i++) {
        const idx = Math.floor((i * (all.length - 1)) / (N - 1));
        targets.push(all[idx]);
      }
    }
  } else if (argv.limit) {
    targets = all.slice(0, argv.limit);
  } else {
    targets = all;
  }

  // Non-review skip list, plus the rotating re-check slice. Only entries
  // we're NOT re-checking this run actually suppress a fetch.
  const notReview = (await readJsonIfExists(NOT_REVIEW_PATH))?.ids ?? {};
  const recheckIds = new Set(
    Object.entries(notReview)
      .sort((a, b) => (a[1]?.checkedAt ?? '').localeCompare(b[1]?.checkedAt ?? ''))
      .slice(0, argv.recheck)
      .map(([id]) => id),
  );

  console.log(`[articles] ${all.length} plugs in the listing, considering ${targets.length}.`);
  if (argv.refresh) console.log('[articles] --refresh: ignoring cache');
  if (knownIdsInDigest.size) console.log(`[articles] ${knownIdsInDigest.size} known IDs from committed digest`);
  if (Object.keys(notReview).length) {
    console.log(
      `[articles] ${Object.keys(notReview).length} known non-reviews skipped ` +
      `(re-checking the ${recheckIds.size} least-recently-checked)`,
    );
  }

  let fetched = 0, cached = 0, knownDigest = 0, parsed = 0, skipped = 0, errored = 0;
  let notReviewSkipped = 0, notReviewNew = 0, promoted = 0;
  const errors = [];

  for (let i = 0; i < targets.length; i++) {
    const plug = targets[i];
    const id = plug.id ?? idFromUrl(plug.url);
    if (!id) { skipped++; continue; }
    const htmlPath = resolve(ARTICLES_DIR, `${id}.html`);
    const jsonPath = resolve(ARTICLES_DIR, `${id}.json`);

    // A re-check has to go past the local HTML too — the whole point is to
    // see whether NRK now serves markup it didn't when we cached this.
    const forceFetch = argv.refresh || recheckIds.has(id);

    let html, didFetch = false;
    if (!forceFetch && (await fileExists(htmlPath))) {
      // Raw HTML is free to re-parse, so we always do — that's how parser
      // improvements reach articles crawled before them.
      html = await readFile(htmlPath, 'utf8');
      cached++;
    } else if (!forceFetch && knownIdsInDigest.has(id)) {
      // Already in the committed slim dataset → don't re-fetch from NRK.
      // build-dataset.mjs will keep the existing record in the digest, so
      // there's nothing to do for this iteration.
      knownDigest++;
      continue;
    } else if (!forceFetch && notReview[id]) {
      notReviewSkipped++;
      continue;
    } else {
      try {
        const res = await politeFetch(plug.url, { limiter });
        html = await res.text();
        await atomicWrite(htmlPath, html);
        fetched++;
        didFetch = true;
      } catch (e) {
        errored++;
        errors.push({ id, url: plug.url, error: e.message });
        console.warn(`  [err] ${id}: ${e.message}`);
        continue;
      }
    }

    try {
      const record = parseArticle(html, { url: plug.url, id });
      if (record) {
        // The listing came from Birger's author API, so when JSON-LD/meta
        // lack author info (common for pre-2015 articles) attribute the
        // article to him.
        if (!record.author) {
          record.author = {
            id: '18.264',
            name: 'Birger Vestmo',
            url: 'https://www.nrk.no/forfatter/birger-vestmo-18.264',
            email: 'birger.vestmo@nrk.no',
            inferred: true,
          };
        }
        record.fetched = {
          fetchedAt: new Date().toISOString(),
          rawHtmlPath: `data/raw/articles/${id}.html`,
        };
        record.listingPlug = plug;
        await atomicWriteJson(jsonPath, record);
        parsed++;
        // Re-check turned up Review markup NRK didn't serve last time.
        if (notReview[id]) { delete notReview[id]; promoted++; }
      } else {
        // No Review JSON-LD → not a review. Remember that so we stop
        // asking NRK for it. checkedAt tracks the last *fetch*, not the
        // last parse of a cached copy — it's what the re-check rotation
        // sorts on, and re-parsing local HTML tells us nothing new.
        if (!notReview[id]) notReviewNew++;
        notReview[id] = {
          url: plug.url,
          checkedAt: didFetch ? new Date().toISOString() : (notReview[id]?.checkedAt ?? null),
        };
      }
    } catch (e) {
      errored++;
      errors.push({ id, url: plug.url, error: `parse: ${e.message}` });
      console.warn(`  [parse-err] ${id}: ${e.message}`);
    }

    if ((i + 1) % 25 === 0 || i === targets.length - 1) {
      console.log(`  [${i + 1}/${targets.length}] fetched ${fetched}, cached ${cached}, knownDigest ${knownDigest}, parsed ${parsed}, errors ${errored}`);
    }
  }

  // Only rewrite the skip list on a full pass — --limit/--sample runs see
  // a slice of the listing and would otherwise look like the rest of the
  // corpus had turned into non-reviews.
  if (!argv.limit && !argv.sample) {
    await atomicWriteJson(NOT_REVIEW_PATH, {
      updatedAt: new Date().toISOString(),
      note: 'Listing plugs with no schema.org Review markup. Skipped by crawl-articles.mjs, re-checked on rotation.',
      ids: notReview,
    });
  }

  console.log(
    `\n[articles] done. fetched=${fetched} cached=${cached} knownDigest=${knownDigest} ` +
    `notReviewSkipped=${notReviewSkipped} parsed=${parsed} skipped=${skipped} errored=${errored}`,
  );
  console.log(
    `[articles] non-reviews: ${Object.keys(notReview).length} on the skip list ` +
    `(+${notReviewNew} new, ${promoted} promoted to reviews this run)`,
  );
  if (errors.length) {
    const errPath = resolve(ARTICLES_DIR, '_errors.json');
    await atomicWriteJson(errPath, { at: new Date().toISOString(), errors });
    console.log(`[articles] wrote ${errors.length} errors to ${errPath}`);
  }
}

function parseArgs(args) {
  const out = { limit: null, sample: null, refresh: false, recheck: DEFAULT_RECHECK };
  for (const a of args) {
    if (a === '--refresh') out.refresh = true;
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice('--limit='.length));
    else if (a.startsWith('--sample=')) out.sample = Number(a.slice('--sample='.length));
    else if (a.startsWith('--recheck=')) out.recheck = Number(a.slice('--recheck='.length));
  }
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
