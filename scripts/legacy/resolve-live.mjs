#!/usr/bin/env node
// Find the live nrk.no URL for legacy reviews that survived NRK's CMS
// migration, so the site can link to NRK instead of the Internet Archive.
//
//   node scripts/legacy/resolve-live.mjs [--radius=300] [--limit=N]
//
// Articles from the old /film/filmanmeldelser/ section were migrated into
// /kultur/<slug>-1.5xxxxx. Nothing links to them any more (not NRK's
// search, not the author API — the byline is a bare mailto:), but two
// properties make them findable without downloading pages:
//
//   1. https://www.nrk.no/1.<id> answers 301 → the canonical URL, so a
//      HEAD request reveals an id's slug at the cost of a few hundred bytes.
//   2. Ids in that block were assigned in publication order, so a
//      review's date predicts its id to within a few hundred.
//
// For each review we interpolate an id from the nearest known anchors and
// scan outward until the slug matches the film's title. Every hit becomes
// an anchor for the next review, and every probed id is cached, so the
// scan tightens as it goes and a re-run costs nothing.
//
// Crawl rules (see PLAN.md): identifying UA, ≤ 1 request/second, HEAD only.
// A match is then confirmed with ONE GET that must show Birger's byline
// and the same publication date.
//
// Writes data/raw/legacy/live-urls.json { "<old id>": "https://www.nrk.no/kultur/…" }
//        data/raw/legacy/nrk-id-slugs.json   probe cache { "<id>": "<slug>" | null }

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RateLimiter, USER_AGENT, atomicWriteJson, readJsonIfExists, sleep } from '../util.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LEGACY = resolve(ROOT, 'data/raw/legacy');
const LIVE = resolve(LEGACY, 'live-urls.json');
const PROBES = resolve(LEGACY, 'nrk-id-slugs.json');

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const RADIUS = Number(args.radius ?? 300);

// date → id, read off articles confirmed by hand. Bounds the block too:
// outside it the ids belong to other NRK sections.
const SEED_ANCHORS = [
  ['2001-12-18', 526965],   // Ringenes Herre: Ringens brorskap
  ['2003-01-30', 531934],   // Bowling for Columbine
  ['2003-06-27', 533588],   // Daddy Day Care
  ['2003-10-23', 534840],   // Kill Bill: Volume 1
  ['2004-11-10', 538674],   // Kjemper for reklamefrie TV-filmer
];
const BLOCK = [524500, 542500];

const squash = (s) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a').replace(/[^a-z0-9]+/g, '');

async function main() {
  const records = (await readJsonIfExists(resolve(ROOT, 'data/processed/legacy-reviews.json'))) ?? [];
  const live = (await readJsonIfExists(LIVE)) ?? {};
  // Slug matches already opened and found to be another critic's review.
  const rejected = (live._rejected ??= {});
  const probes = (await readJsonIfExists(PROBES)) ?? {};
  const limiter = new RateLimiter({ minIntervalMs: 1000 });

  const anchors = SEED_ANCHORS.map(([d, id]) => [Date.parse(d), id]);
  const todo = records
    .filter((r) => r.legacy.path.startsWith('film/filmanmeldelser/'))
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));

  let found = 0, missed = 0, requests = 0;
  try {
  for (const r of todo) {
    const oldId = r.id.slice(3);
    if (live[oldId]) { anchors.push([Date.parse(r.publishedAt), Number(/-1\.(\d+)$/.exec(live[oldId])[1])]); continue; }
    if (args.limit && found + missed >= Number(args.limit)) break;

    // Slugs were cut from the headline as published, which for this section
    // is the film title — but try the headline form too.
    const wanted = new Set([squash(r.name), squash(r.headline)].filter((s) => s.length >= 3));
    const guess = predict(anchors, Date.parse(r.publishedAt));

    // Several critics reviewed the same film the same week, under the same
    // slug, so a slug match is only a candidate. Keep scanning past the
    // ones that turn out to be somebody else's.
    let hit = null;
    for (const id of outward(guess, RADIUS)) {
      if (id < BLOCK[0] || id > BLOCK[1]) continue;
      if (!(id in probes)) {
        await limiter.wait();
        probes[id] = await probe(id);
        if (++requests % 50 === 0) await atomicWriteJson(PROBES, probes);
      }
      const slug = probes[id];
      if (!slug?.startsWith('kultur/') || !wanted.has(squash(slug.slice(7)))) continue;
      const verdict = (rejected[`${oldId}:${id}`] ? false : await confirm(id, slug, r, limiter));
      if (verdict) { hit = id; break; }
      rejected[`${oldId}:${id}`] = true;
    }

    if (hit) {
      live[oldId] = `https://www.nrk.no/${probes[hit]}-1.${hit}`;
      anchors.push([Date.parse(r.publishedAt), hit]);
      found++;
      console.log(`  ✓ ${r.publishedAt.slice(0, 10)} ${r.name} → 1.${hit} (guess was off by ${hit - guess})`);
    } else {
      missed++;
      console.log(`  · ${r.publishedAt.slice(0, 10)} ${r.name} — no page of Birger's within ±${RADIUS} of 1.${guess}`);
    }
    await atomicWriteJson(LIVE, live);
  }
  } finally {
    // Also on NetworkDown: keep what was learned before the connection went.
    await atomicWriteJson(PROBES, probes);
    await atomicWriteJson(LIVE, live);
  }

  await atomicWriteJson(PROBES, probes);
  await atomicWriteJson(LIVE, live);
  console.log(`[live] ${found} resolved, ${missed} not found, ${requests} HEAD requests; ${Object.keys(live).filter((k) => !k.startsWith('_')).length} live URLs total`);
}

// Piecewise-linear date → id over the two anchors bracketing `t`.
function predict(anchors, t) {
  const sorted = [...anchors].sort((a, b) => a[0] - b[0]);
  let lo = sorted[0], hi = sorted.at(-1);
  for (const a of sorted) { if (a[0] <= t) lo = a; if (a[0] >= t) { hi = a; break; } }
  if (lo === hi || hi[0] === lo[0]) return lo[1];
  return Math.round(lo[1] + (hi[1] - lo[1]) * ((t - lo[0]) / (hi[0] - lo[0])));
}

function* outward(center, radius) {
  yield center;
  for (let d = 1; d <= radius; d++) { yield center + d; yield center - d; }
}

// → "kultur/bowling-for-columbine" | null (unassigned id).
// Throws when the network is the problem. A laptop that slept or changed
// wifi mid-run must not get its timeouts cached as "no such article" —
// that turned 21 real pages into false misses once.
class NetworkDown extends Error {}

async function probe(id) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`https://www.nrk.no/1.${id}`, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': USER_AGENT } });
      if (res.status === 429 || res.status >= 500) { await sleep(5000 * 2 ** attempt); continue; }
      const loc = res.headers.get('location');
      const m = loc && /^https:\/\/www\.nrk\.no\/(.+)-1\.\d+$/.exec(loc);
      return m ? m[1] : null;
    } catch { await sleep(5000 * 2 ** attempt); }
  }
  throw new NetworkDown(`no answer for 1.${id}`);
}

// A slug match alone could be a colleague's review of the same film.
// false = definitely not Birger's page; a fetch failure throws instead, so
// it is never remembered as a rejection.
async function confirm(id, slug, r, limiter) {
  await limiter.wait();
  let res;
  try { res = await fetch(`https://www.nrk.no/${slug}-1.${id}`, { headers: { 'User-Agent': USER_AGENT } }); }
  catch (e) { throw new NetworkDown(`confirm 1.${id}: ${e.message}`); }
  if (res.status === 429 || res.status >= 500) throw new NetworkDown(`confirm 1.${id}: HTTP ${res.status}`);
  if (!res.ok) return false;
  const html = await res.text();
  const published = /"datePublished":"(\d{4}-\d{2}-\d{2})/.exec(html)?.[1];
  if (published !== r.publishedAt.slice(0, 10)) return false;
  // Credited three ways over the years: a mailto: link, a plain "Av Birger
  // Vestmo" paragraph, or only in the ingress ("…, mener Birger Vestmo").
  // A colleague's review of the same film also contains his name, but
  // only inside the title="" of a related-articles link — so look at the
  // description and at byline-shaped text, never the whole page.
  // NRK doesn't escape quotes inside content="", so read up to the tag end.
  const description = /<meta name="description" content="([\s\S]*?)"\s*\/>/.exec(html)?.[1] ?? '';
  return description.includes('Birger Vestmo')
    || /mailto:birger\.vestmo@nrk\.no/.test(html)
    || />\s*Av:?\s*(?:<[^>]+>\s*)*Birger Vestmo/.test(html);
}

main().catch((e) => { console.error(e instanceof NetworkDown ? `[live] network down (${e.message}) — progress is saved, re-run to continue` : e); process.exit(1); });
