#!/usr/bin/env node
// Pull IMDb's title.ratings dataset (free, no API key) and produce a slim
// lookup of {imdbId → {rating, votes}} for the ids we actually use.
//
// The full dataset is ~7 MB gzipped and contains every IMDb title ever; we
// filter it down to the ~1,800 ids that match our corpus before writing.
//
// Output:  data/processed/imdb-ratings.json
// Cache:   data/raw/imdb-ratings.tsv.gz  (refreshed once a week)
//
// IMDb licensing: "Subsets of IMDb data are available for access to customers
// for personal and non-commercial use" — this fan archive qualifies. See
// https://developer.imdb.com/non-commercial-datasets/

import { createReadStream, createWriteStream } from 'node:fs';
import { stat, readdir, readFile } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  USER_AGENT,
  atomicWriteJson,
  ensureDir,
  fileExists,
} from './util.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENR_DIR = resolve(ROOT, 'data/processed/enrichment');
const RAW_DIR = resolve(ROOT, 'data/raw');
const OUT = resolve(ROOT, 'data/processed/imdb-ratings.json');
const TSV_GZ = resolve(RAW_DIR, 'imdb-ratings.tsv.gz');
const URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly

async function main() {
  await ensureDir(RAW_DIR);

  // 1. Download (or reuse cache)
  let needFetch = !(await fileExists(TSV_GZ));
  if (!needFetch) {
    const s = await stat(TSV_GZ);
    if (Date.now() - s.mtimeMs > MAX_AGE_MS) needFetch = true;
  }
  if (needFetch) {
    console.log(`[imdb] downloading ${URL}…`);
    const res = await fetch(URL, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching IMDb dataset`);
    await pipeline(res.body, createWriteStream(TSV_GZ));
    const s = await stat(TSV_GZ);
    console.log(`[imdb] saved ${(s.size / 1024).toFixed(0)} KB to data/raw/imdb-ratings.tsv.gz`);
  } else {
    console.log('[imdb] using cached data/raw/imdb-ratings.tsv.gz (fresh enough).');
  }

  // 2. Build the set of IMDb ids we actually need
  const wanted = new Set();
  for (const f of await readdir(ENR_DIR)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try {
      const r = JSON.parse(await readFile(resolve(ENR_DIR, f), 'utf8'));
      const imdb = r?.tmdb?.external_ids?.imdb_id;
      if (imdb) wanted.add(imdb);
    } catch {}
  }
  console.log(`[imdb] looking up ${wanted.size} ids from the corpus`);

  // 3. Stream-scan the TSV, picking out only the rows we need
  const out = {};
  let scanned = 0;
  const rl = createInterface({
    input: createReadStream(TSV_GZ).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  let header = true;
  for await (const line of rl) {
    if (header) { header = false; continue; }
    scanned++;
    const tab1 = line.indexOf('\t');
    if (tab1 < 0) continue;
    const id = line.slice(0, tab1);
    if (!wanted.has(id)) continue;
    const rest = line.slice(tab1 + 1).split('\t');
    const rating = parseFloat(rest[0]);
    const votes = parseInt(rest[1], 10);
    if (Number.isFinite(rating) && Number.isFinite(votes)) {
      out[id] = { rating, votes };
    }
  }

  console.log(`[imdb] scanned ${scanned.toLocaleString('en-US')} rows, matched ${Object.keys(out).length}`);
  await atomicWriteJson(OUT, out);
  console.log(`[imdb] wrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
