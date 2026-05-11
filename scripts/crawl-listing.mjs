#!/usr/bin/env node
// Crawl the NRK author-articles API for Birger Vestmo.
//
//   GET /komponenter/api/author/articles/18.264.json?count=50&cursor=…
//
// Writes one file per page to data/raw/listing/page-NNN.json and a
// deduped, sorted master index to data/raw/listing/index.json.
//
// Incremental by default: re-reads the existing index.json and stops as soon
// as it sees STREAK_STOP consecutive pages where every plug is already
// known. A `--full` flag forces a complete walk (useful if you suspect the
// existing index is stale or corrupt).

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RateLimiter,
  politeFetch,
  atomicWriteJson,
  ensureDir,
} from './util.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LISTING_DIR = resolve(ROOT, 'data/raw/listing');

const AUTHOR_ID = '18.264'; // Birger Vestmo
const PAGE_SIZE = 50;       // server cap
const STREAK_STOP = 2;      // consecutive all-known pages → stop
const BASE = `https://www.nrk.no/komponenter/api/author/articles/${AUTHOR_ID}.json`;

const argv = parseArgs(process.argv.slice(2));

async function main() {
  await ensureDir(LISTING_DIR);
  const limiter = new RateLimiter({ minIntervalMs: 1000 });

  // Load the prior index so we can short-circuit when we hit a contiguous
  // run of already-seen plugs. On a typical day NRK publishes 0–3 new
  // reviews, so the walk stops after ~2 pages instead of ~65.
  const existingPath = resolve(LISTING_DIR, 'index.json');
  const known = new Map();          // id → plug from previous run
  if (!argv.full) {
    try {
      const prev = JSON.parse(await readFile(existingPath, 'utf8'));
      for (const p of prev.plugs ?? []) if (p?.id) known.set(p.id, p);
      console.log(`[listing] resumable mode — ${known.size} known plugs from previous index`);
    } catch {
      console.log('[listing] no previous index found, doing a full walk');
    }
  } else {
    console.log('[listing] --full: ignoring previous index, walking everything');
  }

  const collected = new Map();      // id → plug from this run (newest data wins)
  let cursor = null;
  let pageNum = 0;
  let streak = 0;                   // pages in a row with zero new IDs
  let stoppedEarly = false;

  while (true) {
    pageNum++;
    const url = `${BASE}?count=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    console.log(`[listing] page ${pageNum}: ${url}`);

    const res = await politeFetch(url, { limiter, headers: { Accept: 'application/json' } });
    const body = await res.json();
    const plugs = body.plugs ?? [];
    cursor = typeof body.cursor === 'string' ? body.cursor : null;

    await atomicWriteJson(
      resolve(LISTING_DIR, `page-${String(pageNum).padStart(3, '0')}.json`),
      body,
    );

    let addedNew = 0, refreshed = 0;
    for (const p of plugs) {
      const id = idFromUrl(p.url);
      if (!id) continue;
      if (known.has(id)) refreshed++;
      else addedNew++;
      collected.set(id, { id, ...p });
    }

    console.log(
      `  +${addedNew} new, ${refreshed} known on this page ` +
      `(total seen this run: ${collected.size}) — newest ${plugs[0]?.published ?? '—'}, ` +
      `oldest ${plugs.at(-1)?.published ?? '—'}`,
    );

    if (plugs.length === 0) break;
    if (!cursor) break;

    // Early-stop in incremental mode: if a whole page contained no fresh
    // IDs AND we have a prior index, count the streak. Two such pages in a
    // row means we've already seen everything older than this.
    if (known.size && addedNew === 0) {
      streak++;
      if (streak >= STREAK_STOP) {
        console.log(`  ${STREAK_STOP} pages in a row had no new IDs — stopping early.`);
        stoppedEarly = true;
        break;
      }
    } else {
      streak = 0;
    }
  }

  // Merge: prefer fresh data from this run, fall back to the prior index
  // for IDs we never re-touched (only happens in early-stop mode).
  const allById = new Map(known);
  for (const [id, p] of collected) allById.set(id, p);
  const allPlugs = [...allById.values()].sort((a, b) =>
    (b.published ?? '').localeCompare(a.published ?? ''),
  );

  await atomicWriteJson(resolve(LISTING_DIR, 'index.json'), {
    authorId: AUTHOR_ID,
    fetchedAt: new Date().toISOString(),
    pageCount: pageNum,
    pluggCount: allPlugs.length,
    stoppedEarly,
    plugs: allPlugs,
  });

  const reviewish = allPlugs.filter((p) => /\/anmeldelse_-_/.test(p.url));
  const newThisRun = [...collected.keys()].filter((id) => !known.has(id)).length;
  console.log(`\n[listing] done: ${allPlugs.length} plugs across ${pageNum} pages${stoppedEarly ? ' (stopped early)' : ''}.`);
  console.log(`[listing] new this run: ${newThisRun}. /anmeldelse_-_/ URLs: ${reviewish.length}.`);
  console.log(`[listing] index: data/raw/listing/index.json`);
}

function idFromUrl(url) {
  const m = /-(\d+\.\d+)(?:[.?#]|$)/.exec(url ?? '');
  return m ? m[1] : null;
}

function parseArgs(args) {
  const out = { full: false };
  for (const a of args) {
    if (a === '--full') out.full = true;
  }
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
