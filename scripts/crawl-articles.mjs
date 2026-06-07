#!/usr/bin/env node
// Read data/raw/listing/index.json, fetch each article that hasn't been
// fetched yet, save raw HTML + parsed JSON next to it.
//
// Usage:
//   node scripts/crawl-articles.mjs               # all articles
//   node scripts/crawl-articles.mjs --limit=20    # first 20 (smoke test)
//   node scripts/crawl-articles.mjs --refresh     # re-fetch even if cached

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RateLimiter,
  politeFetch,
  atomicWrite,
  atomicWriteJson,
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

  // Filter to plugs that look like reviews. Birger has 3198 articles total
  // but only the /anmeldelse_-_/ ones are reviews. New-CMS (May 2026+)
  // /artikkel/ plugs come pre-verified from crawl-newcms.mjs and don't
  // encode review-ness in the URL — parseArticle's Review JSON-LD check
  // decides for those. We still write parsed results for all of them —
  // the build step decides what makes the dex.
  const all = index.plugs ?? [];
  const review = all.filter((p) => /\/anmeldelse_-_/.test(p.url) || /\/artikkel\//.test(p.url));
  let targets;
  if (argv.sample) {
    // Stratified sample: take N items spread evenly across the (already
    // newest→oldest) list so smoke tests touch every era.
    const N = argv.sample;
    targets = [];
    if (review.length <= N) targets = review;
    else {
      for (let i = 0; i < N; i++) {
        const idx = Math.floor((i * (review.length - 1)) / (N - 1));
        targets.push(review[idx]);
      }
    }
  } else if (argv.limit) {
    targets = review.slice(0, argv.limit);
  } else {
    targets = review;
  }

  console.log(
    `[articles] ${all.length} plugs, ${review.length} look like reviews, considering ${targets.length}.`,
  );
  if (argv.refresh) console.log('[articles] --refresh: ignoring cache');
  if (knownIdsInDigest.size) console.log(`[articles] ${knownIdsInDigest.size} known IDs from committed digest`);

  let fetched = 0, cached = 0, knownDigest = 0, parsed = 0, skipped = 0, errored = 0;
  const errors = [];

  for (let i = 0; i < targets.length; i++) {
    const plug = targets[i];
    const id = plug.id ?? idFromUrl(plug.url);
    if (!id) { skipped++; continue; }
    const htmlPath = resolve(ARTICLES_DIR, `${id}.html`);
    const jsonPath = resolve(ARTICLES_DIR, `${id}.json`);

    let html;
    if (!argv.refresh && (await fileExists(htmlPath))) {
      html = await readFile(htmlPath, 'utf8');
      cached++;
    } else if (!argv.refresh && knownIdsInDigest.has(id)) {
      // Already in the committed slim dataset → don't re-fetch from NRK.
      // build-dataset.mjs will keep the existing record in the digest, so
      // there's nothing to do for this iteration.
      knownDigest++;
      continue;
    } else {
      try {
        const res = await politeFetch(plug.url, { limiter });
        html = await res.text();
        await atomicWrite(htmlPath, html);
        fetched++;
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

  console.log(
    `\n[articles] done. fetched=${fetched} cached=${cached} knownDigest=${knownDigest} parsed=${parsed} skipped=${skipped} errored=${errored}`,
  );
  if (errors.length) {
    const errPath = resolve(ARTICLES_DIR, '_errors.json');
    await atomicWriteJson(errPath, { at: new Date().toISOString(), errors });
    console.log(`[articles] wrote ${errors.length} errors to ${errPath}`);
  }
}

function parseArgs(args) {
  const out = { limit: null, sample: null, refresh: false };
  for (const a of args) {
    if (a === '--refresh') out.refresh = true;
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice('--limit='.length));
    else if (a.startsWith('--sample=')) out.sample = Number(a.slice('--sample='.length));
  }
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
