#!/usr/bin/env node
// Enumerate Birger's pre-2007 review pages as preserved by the Wayback
// Machine.
//
// Between 2000 and 2006 Filmpolitiet's written reviews lived on NRK
// sections that no longer exist (every old URL is a 404 today), and the
// pages that were migrated into /kultur/ lost their author link — the
// byline became a bare mailto:, so they never appeared in the author API
// the main crawl was built on. The Internet Archive is the only complete
// listing left.
//
//   node scripts/legacy/wayback-index.mjs
//
// Writes data/raw/legacy/wayback-index.json:
//   { pages: { "<host-less path>": { original, captures: ["YYYYMMDDhhmmss", …] } } }
//
// Re-runnable: merges into the existing index, so a CDX outage on one
// prefix (archive.org goes "Temporarily Offline" several times a day)
// never loses what an earlier run found.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RateLimiter, politeFetch, atomicWriteJson, readJsonIfExists, ensureDir } from '../util.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = resolve(ROOT, 'data/raw/legacy/wayback-index.json');

// Every old home of Filmpolitiet's written reviews, oldest first.
const PREFIXES = [
  'nrk.no/p3/filmpolitiet/',                 // 1998–2000, mostly RealAudio clips
  'nrk.no/magasin/upunkt/film/',             // 2000–2001, P3's "Upunkt" web magazine
  'nrk.no/filmpolitiet/',                    // 2001–2003 stub section
  'nrk.no/programmer/radio/filmpolitiet/',   // 2001–2007, the P3 programme site
  'nrk.no/film/filmanmeldelser/',            // 2000–2005, NRK-wide review section
];

// 0.html and friends are section fronts; anything with a query string is
// a paginated view of one. Neither is an article.
const isArticle = (path) => /\.html?$/i.test(path) && !/\/(0|index|forside)\.html?$/i.test(path);

function pageKey(original) {
  const u = new URL(original.replace(/^http:\/\/([^/]+):80\//, 'http://$1/'));
  if (u.search) return null;
  const path = decodeURIComponent(u.pathname).replace(/\/+/g, '/');
  return isArticle(path) ? path.replace(/^\//, '') : null;
}

async function cdx(prefix, limiter) {
  const q = new URLSearchParams({
    url: `${prefix}*`,
    output: 'json',
    fl: 'original,timestamp',
    from: '1999',
    to: '2009',
    collapse: 'digest',            // skip byte-identical re-captures
  });
  const url = `https://web.archive.org/cdx/search/cdx?${q}&filter=statuscode:200&filter=mimetype:text/html`;
  const res = await politeFetch(url, { limiter, retries: 5 });
  const text = await res.text();
  // The outage page is served with HTTP 200, so the status check in
  // politeFetch can't catch it.
  if (!text.trimStart().startsWith('[')) throw new Error(`CDX returned non-JSON for ${prefix} (archive.org offline?)`);
  return JSON.parse(text).slice(1);
}

async function main() {
  await ensureDir(dirname(OUT));
  const limiter = new RateLimiter({ minIntervalMs: 3000 });
  const index = (await readJsonIfExists(OUT)) ?? { pages: {} };
  let failed = 0;

  for (const prefix of PREFIXES) {
    let rows;
    try { rows = await cdx(prefix, limiter); }
    catch (e) { console.warn(`[wb-index] ${prefix}: ${e.message} — keeping previous entries`); failed++; continue; }

    let added = 0;
    for (const [original, ts] of rows) {
      let key;
      try { key = pageKey(original); } catch { continue; }
      if (!key) continue;
      const page = (index.pages[key] ??= { original, captures: [] });
      if (!page.captures.includes(ts)) { page.captures.push(ts); added++; }
    }
    console.log(`[wb-index] ${prefix}: ${rows.length} captures → +${added} new`);
  }

  for (const p of Object.values(index.pages)) p.captures.sort();
  index.generatedAt = new Date().toISOString();
  await atomicWriteJson(OUT, index);
  console.log(`[wb-index] ${Object.keys(index.pages).length} pages in ${OUT}`);
  if (failed) process.exit(2);     // partial — worth re-running
}

main().catch((e) => { console.error(e); process.exit(1); });
