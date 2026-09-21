#!/usr/bin/env node
// Download the raw HTML of every page in wayback-index.json.
//
//   node scripts/legacy/wayback-fetch.mjs [--limit=N] [--only=<substring>]
//
// Output: data/raw/legacy/wayback/<key>.html (bytes exactly as archived —
// these pages are ISO-8859-1, so they're written undecoded) plus
// data/raw/legacy/wayback-manifest.json recording which capture each file
// came from. Both the cache and the run are resumable; a page that's
// already on disk is never requested again.
//
// The `id_` URL flavour returns the original bytes without the Wayback
// toolbar or rewritten links.

import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RateLimiter, politeFetch, atomicWriteJson, readJsonIfExists, ensureDir, fileExists } from '../util.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LEGACY = resolve(ROOT, 'data/raw/legacy');
const CACHE = resolve(LEGACY, 'wayback');
const MANIFEST = resolve(LEGACY, 'wayback-manifest.json');

// archive.org starts answering with empty bodies well before it sends a
// 429, so stay far below whatever the real limit is.
const INTERVAL_MS = 2000;
// A real article page is 20–60 kB. Anything this small is the throttle
// response or an archived error stub.
const MIN_BYTES = 3000;
// Captures to try per page before giving up on it for this run.
const MAX_CAPTURES = 3;

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

export const fileFor = (key) => `${key.replace(/\.html?$/i, '').replace(/[^a-zA-Z0-9]+/g, '_')}.html`;

async function main() {
  await ensureDir(CACHE);
  const index = await readJsonIfExists(resolve(LEGACY, 'wayback-index.json'));
  if (!index) throw new Error('run wayback-index.mjs first');
  const manifest = (await readJsonIfExists(MANIFEST)) ?? {};
  const limiter = new RateLimiter({ minIntervalMs: INTERVAL_MS });

  let keys = Object.keys(index.pages).sort();
  if (args.only) keys = keys.filter((k) => k.includes(args.only));
  let fetched = 0, cached = 0, failed = 0;

  for (const key of keys) {
    const file = fileFor(key);
    if (manifest[key]?.skipped) { cached++; continue; }
    if (manifest[key] && await fileExists(resolve(CACHE, file))) { cached++; continue; }
    if (args.limit && fetched >= Number(args.limit)) break;

    const { original, captures } = index.pages[key];
    // Earliest capture first: it's the template the review was published
    // in, before later redesigns moved the rating and byline around.
    let ok = false;
    let stubs = 0;
    for (const ts of captures.slice(0, MAX_CAPTURES)) {
      try {
        const res = await politeFetch(`https://web.archive.org/web/${ts}id_/${original}`, { limiter, retries: 3 });
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < MIN_BYTES || buf.includes('Temporarily Offline')) {
          // Empty = throttled, worth retrying next run. Small but non-empty
          // = a genuine frameset/redirect stub, which no retry will grow.
          if (buf.length > 0 && !buf.includes('Temporarily Offline')) stubs++;
          console.warn(`  [thin] ${key} @${ts}: ${buf.length} B — trying another capture`);
          continue;
        }
        await writeFile(resolve(CACHE, file), buf);
        manifest[key] = { file, ts, original, bytes: buf.length };
        ok = true;
        break;
      } catch (e) {
        console.warn(`  [fail] ${key} @${ts}: ${e.message}`);
      }
    }
    if (!ok && stubs === Math.min(captures.length, MAX_CAPTURES)) {
      manifest[key] = { skipped: 'stub', original };
    }
    if (ok) fetched++; else failed++;
    if ((fetched + failed) % 25 === 0) {
      await atomicWriteJson(MANIFEST, manifest);
      console.log(`[wb-fetch] ${fetched} fetched, ${failed} failed, ${cached} cached / ${keys.length}`);
    }
  }

  await atomicWriteJson(MANIFEST, manifest);
  console.log(`[wb-fetch] done: ${fetched} fetched, ${failed} failed, ${cached} already cached / ${keys.length}`);
}

// Importable for fileFor(); only crawl when run directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
