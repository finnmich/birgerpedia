#!/usr/bin/env node
// Smoke test for scripts/legacy/parse-legacy.mjs against the Wayback cache.
//
//   npm run legacy:test
//
// Two kinds of check:
//   1. Known pages, one per template generation and rating strip, with
//      values read off the rendered page by a human.
//   2. A corpus-wide gate: ~50 of these reviews were also hand-migrated by
//      NRK and reached the dex through the normal crawl with a proper
//      schema.org rating. Wherever build-legacy.mjs recognised one of those
//      as a duplicate, the rating it read off the strip image must equal
//      NRK's own. That's an independent check on all three strip maps.
//
// The cache is gitignored (run legacy:fetch to fill it), so a missing page
// is a skip, not a failure.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonIfExists } from '../util.mjs';
import { decodeLegacy, parseLegacy, resolveRating } from './parse-legacy.mjs';
import { fileFor } from './wayback-fetch.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LEGACY = resolve(ROOT, 'data/raw/legacy');

const KNOWN = [
  // star strip, film section, byline on top
  { key: 'film/filmanmeldelser/2496251.html', title: 'Bowling for Columbine', rating: 6, date: '2003-01-30', birger: true, regi: 'Michael Moore' },
  { key: 'film/filmanmeldelser/2871680.html', title: 'Daddy Day Care', rating: 1, date: '2003-06-27', birger: true },
  { key: 'film/filmanmeldelser/3486783.html', title: 'The Dreamers', rating: 4, date: '2004-02-05', birger: true },
  // 2001–02 <p>/<span> variant of the template; another critic
  { key: 'film/filmanmeldelser/1813638.html', title: 'Bella Martha', rating: 5, date: '2002-04-26', birger: false },
  // six-box meter, P3 section, byline as last line
  { key: 'programmer/radio/filmpolitiet/1421860.html', title: 'Kaptein Corellis mandolin: Ukebladsuppe', rating: 3, date: '2001-11-08', birger: true },
  // "(N)" title suffix + star strip agreeing
  { key: 'programmer/radio/filmpolitiet/3667178.html', title: 'Øye for kjærlighet', rating: 4, date: '2004-04-01', birger: true },
  // "(N)" title suffix + popcorn strip
  { key: 'programmer/radio/filmpolitiet/5342902.html', title: 'The Ice Harvest', rating: 4, date: '2005-12-22', birger: true },
  // shared byline
  { key: 'programmer/radio/filmpolitiet/5768842.html', title: 'Lady in the water', rating: 5, date: '2006-09-08', birger: true, coAuthor: 'Lars Andersen' },
];

async function main() {
  const audit = await readJsonIfExists(resolve(LEGACY, 'legacy-audit.json'));
  const maps = { popcorn: audit?.popcorn ?? {} };
  let failed = 0, skipped = 0;

  for (const k of KNOWN) {
    let buf;
    try { buf = await readFile(resolve(LEGACY, 'wayback', fileFor(k.key))); }
    catch { skipped++; console.log(`  skip ${k.key} (not cached)`); continue; }
    const p = parseLegacy(decodeLegacy(buf));
    const r = p && resolveRating(p.strips, maps);
    const problems = [];
    if (!p) problems.push('did not parse');
    else {
      if (p.title !== k.title) problems.push(`title "${p.title}"`);
      if (r.rating !== k.rating) problems.push(`rating ${r.rating} ${JSON.stringify(r.found)}`);
      if (!p.publishedAt.startsWith(k.date)) problems.push(`date ${p.publishedAt}`);
      if ((p.byline?.birger ?? false) !== k.birger) problems.push(`byline ${JSON.stringify(p.byline)}`);
      if (k.regi && p.factbox.regi !== k.regi) problems.push(`regi "${p.factbox.regi}"`);
      if (k.coAuthor && !p.byline?.names.includes(k.coAuthor)) problems.push(`co-author missing: ${JSON.stringify(p.byline)}`);
    }
    if (problems.length) { failed++; console.log(`  FAIL ${k.key}: ${problems.join('; ')}`); }
    else console.log(`  ok   ${k.key} → «${p.title}» ${r.rating}`);
  }

  const overlaps = (audit?.dupOfExisting ?? []).filter((d) => d.rating != null && d.existingRating != null);
  const disagree = overlaps.filter((d) => d.rating !== d.existingRating);
  console.log(`\n  ${overlaps.length - disagree.length}/${overlaps.length} overlaps with NRK-migrated reviews agree on the rating`);
  for (const d of disagree) { failed++; console.log(`  FAIL ${d.key} «${d.name}»: strip says ${d.rating}, NRK says ${d.existingRating} (${d.existing})`); }
  if (audit?.conflicts?.length) console.log(`  note: ${audit.conflicts.length} pages skipped for disagreeing rating sources — see legacy-audit.json`);

  console.log(`\n[legacy:test] ${failed ? `${failed} FAILED` : 'passed'}${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
