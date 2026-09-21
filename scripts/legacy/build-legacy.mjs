#!/usr/bin/env node
// Turn the cached Wayback pages into review records.
//
//   node scripts/legacy/build-legacy.mjs
//
// Reads  data/raw/legacy/wayback/*.html (+ wayback-manifest.json)
// Writes data/processed/legacy-reviews.json   — merged by build-dataset.mjs
//        data/raw/legacy/legacy-audit.json    — everything that was NOT
//                                               imported, and why
//
// A page becomes a review only if it carries Birger's byline and either a
// rating strip or a home in the dedicated review section. Everything else
// in those old sections is news, interviews and index pages.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson, readJsonIfExists } from '../util.mjs';
import { decodeLegacy, parseLegacy, resolveRating } from './parse-legacy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LEGACY = resolve(ROOT, 'data/raw/legacy');
const OUT = resolve(ROOT, 'data/processed/legacy-reviews.json');
const REVIEWS = resolve(ROOT, 'data/processed/reviews.json');
// Set by resolve-live.mjs: old id → the article's current nrk.no URL.
const LIVE = resolve(LEGACY, 'live-urls.json');
// Hand-verified film titles for the few headlines no rule can decode.
const NAME_OVERRIDES = resolve(ROOT, 'data/legacy-name-overrides.json');

const BIRGER = {
  id: '18.264',
  name: 'Birger Vestmo',
  url: 'https://www.nrk.no/forfatter/birger-vestmo-18.264',
  email: 'birger.vestmo@nrk.no',
};

// Same film, same critic, weeks apart → same review. The old sections
// cross-published, and the ~50 that were hand-migrated to p3.no were
// sometimes re-dated by a fortnight («Mulholland Drive»: 18.03 vs 04.04).
// A cinema review and its DVD review sit months apart, so they survive.
const DUP_WINDOW_DAYS = 45;

const norm = (s) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
  .replace(/&[a-z#0-9]+;/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const days = (a, b) => Math.abs(new Date(a) - new Date(b)) / 864e5;

async function main() {
  const manifest = await readJsonIfExists(resolve(LEGACY, 'wayback-manifest.json'));
  if (!manifest) throw new Error('run wayback-fetch.mjs first');
  const live = (await readJsonIfExists(LIVE)) ?? {};
  const overrides = (await readJsonIfExists(NAME_OVERRIDES))?.names ?? {};

  // ---- parse everything -------------------------------------------------
  const pages = [];
  for (const [key, m] of Object.entries(manifest)) {
    if (m.skipped) continue;
    let parsed;
    try { parsed = parseLegacy(decodeLegacy(await readFile(resolve(LEGACY, 'wayback', m.file)))); }
    catch { continue; }
    if (!parsed) continue;
    const oldId = /(\d+)\.html?$/.exec(key)?.[1];
    if (!oldId) continue;
    pages.push({ key, oldId, section: key.replace(/\/[^/]+$/, ''), ts: m.ts, original: m.original, ...parsed });
  }

  // ---- learn the strip maps from pages that state the score twice --------
  const popcorn = learn(pages, (p) => p.strips.popcorn, 'popcorn');
  // ---- classify -----------------------------------------------------------
  const audit = { notBirger: [], noByline: [], unratedP3: [], conflicts: [], dupOfExisting: [], dupWithinLegacy: [] };
  const candidates = [];
  for (const p of pages) {
    if (p.section.includes('din_filmanmeldelse')) continue;            // reader-submitted reviews
    if (/^Filmpremierer\b/i.test(p.title)) continue;                   // weekly roundup, scored as a whole
    const r = resolveRating(p.strips, { popcorn });
    const brief = { key: p.key, title: p.title, publishedAt: p.publishedAt.slice(0, 10) };
    if (!p.byline) { if (r.found.title != null || r.found.star != null) audit.noByline.push(brief); continue; }
    if (!p.byline.birger) { audit.notBirger.push({ ...brief, by: p.byline.names.join(', ') }); continue; }
    if (r.conflict) { audit.conflicts.push({ ...brief, found: r.found }); continue; }
    const inReviewSection = p.section === 'film/filmanmeldelser';
    const hasStrip = Object.values(r.found).some((v) => v != null);
    if (!hasStrip && !inReviewSection) { audit.unratedP3.push(brief); continue; }
    candidates.push({ ...p, rating: r.rating, ratingFound: r.found });
  }

  // ---- dedupe -------------------------------------------------------------
  const existing = JSON.parse(await readFile(REVIEWS, 'utf8')).filter((r) => !String(r.id).startsWith('wb.'));
  const existingByName = new Map();
  for (const r of existing) {
    for (const n of [r.name, r.originalTitle]) {
      const k = norm(n);
      if (k) (existingByName.get(k) ?? existingByName.set(k, []).get(k)).push(r);
    }
  }

  const kept = new Map();                                              // norm(name) → record[]
  // Richest first, so the survivor of a within-legacy duplicate is the
  // rated, longer copy from the section that still has a live NRK page.
  candidates.sort((a, b) =>
    (b.rating != null) - (a.rating != null)
    || (b.section === 'film/filmanmeldelser') - (a.section === 'film/filmanmeldelser')
    || b.wordCount - a.wordCount);

  for (const c of candidates) {
    const derived = deriveName(c);
    const name = overrides[c.oldId]?.name ?? derived.name;
    c.dvd = derived.dvd;
    const k = norm(name);
    const brief = { key: c.key, name, publishedAt: c.publishedAt.slice(0, 10), rating: c.rating };

    const old = (existingByName.get(k) ?? []).find((r) => days(r.publishedAt, c.publishedAt) <= DUP_WINDOW_DAYS);
    if (old) { audit.dupOfExisting.push({ ...brief, existing: old.id, existingRating: old.rating }); continue; }

    const twin = (kept.get(k) ?? []).find((r) => days(r.publishedAt, c.publishedAt) <= DUP_WINDOW_DAYS);
    if (twin) { audit.dupWithinLegacy.push({ ...brief, keptKey: twin.legacy.path }); continue; }

    (kept.get(k) ?? kept.set(k, []).get(k)).push(toRecord(c, name, live));
  }

  const records = [...kept.values()].flat().sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  await atomicWriteJson(OUT, records);
  await atomicWriteJson(resolve(LEGACY, 'legacy-audit.json'), { builtAt: new Date().toISOString(), popcorn, ...audit });

  console.log(`[legacy] ${pages.length} article pages parsed → ${candidates.length} Birger reviews → ${records.length} new records`);
  console.log(`[legacy] skipped: ${audit.dupOfExisting.length} already in the dex, ${audit.dupWithinLegacy.length} cross-posted twins, ` +
    `${audit.notBirger.length} other critics, ${audit.unratedP3.length} unrated P3 articles, ${audit.conflicts.length} rating conflicts`);
  console.log('[legacy] rating:', tally(records, (r) => r.rating ?? '∅'));
  console.log('[legacy] year:  ', tally(records, (r) => r.publishedAt.slice(0, 4)));
  console.log('[legacy] popcorn map:', popcorn);
  console.log(`[legacy] live nrk.no URL resolved for ${records.filter((r) => !r.url.includes('web.archive.org')).length}/${records.length}`);
}

// A strip id → score map is only trusted if the pages that state the score
// twice (strip + "(N)" in the title) never disagree.
function learn(pages, idOf, label) {
  const votes = {};
  for (const p of pages) {
    const id = idOf(p);
    if (id == null || p.strips.title == null) continue;
    ((votes[id] ??= {})[p.strips.title] ??= 0);
    votes[id][p.strips.title]++;
  }
  const map = {};
  for (const [id, v] of Object.entries(votes)) {
    const ranked = Object.entries(v).sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((n, [, c]) => n + c, 0);
    if (ranked[0][1] / total >= 0.95) map[id] = Number(ranked[0][0]);
    else console.warn(`[legacy] ${label} strip ${id} is inconsistent:`, v);
  }
  return map;
}

// The film section titled reviews with the film's name; the P3 section
// wrote headlines: "Zoolander: Intern spøk", "Insomnia - vellykket plagiat",
// "Idiotisk Mr. Deeds", "DVD: Near Dark". The running text always names the
// film in quotes, which is what tells "American Pie: Bryllupet" (a title)
// from "Gosford Park: God gammeldags krim" (a title plus a verdict).
function deriveName(c) {
  let title = unquote(c.title);
  // "DVD: X", "DVD | X", "X (DVD)", "X (dvd 2005)", "X (DVD) 5", "X – DVD"
  const bare = title.replace(/^DVD\s*[:|–-]?\s+(?:\|\s*)?/i, '').replace(/\s*(?:\(dvd[^)]*\)\s*\d?|[-–]\s*DVD)\s*$/i, '').trim();
  const dvd = bare !== title;
  title = bare || title;

  const t = norm(title);
  const quoted = c.quoted.map((q) => [q, norm(q)]).filter(([, n]) => n.length >= 2);
  const done = (name) => ({ name: name.trim(), dvd });

  // The text quotes the headline verbatim → the headline is the title.
  if (quoted.some(([, n]) => n === t)) return done(title);

  const m = /^(.{2,50}?)(: +| +[-–] +|, +)(.{3,})$/.exec(title);
  if (m) {
    const [, left, sep, right] = m;
    const shouted = /[!?]$/.test(right);
    const verdict = sep.startsWith(',') ? shouted : shouted || /^\p{Ll}/u.test(right);
    // Until 2003 P3 wrote every headline as "Film: Dom", capitalised.
    const earlyP3 = sep.startsWith(':') && c.section !== 'film/filmanmeldelser' && c.publishedAt < '2003';
    if (quoted.some(([, n]) => n === norm(left)) || verdict || earlyP3) {
      // "A.I. - Tankevekkende …" where the text says "A.I. Kunstig intelligens".
      const fuller = quoted.find(([, n]) => n.startsWith(`${norm(left)} `) && !t.includes(n));
      return done(fuller ? fuller[0] : left);
    }
  }

  // A quoted title inside a verdict: "Idiotisk Mr. Deeds", "Jævlig god og
  // jævlig Lilja 4-ever". What's left over must read like prose — one word,
  // or containing a lower-case one — so "Star Wars" + "Episode III – …"
  // stays whole.
  const inside = quoted.filter(([, n]) => t.includes(n) && n !== t).sort((x, y) => y[1].length - x[1].length)[0];
  if (inside) {
    const rest = title.replace(new RegExp(inside[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ').split(/\s+/).filter(Boolean);
    if (rest.length === 1 || rest.some((w) => /^\p{Ll}/u.test(w))) return done(inside[0]);
  }

  // What's left is a headline that never names the film — "Monstrene
  // avsløres!", "Bittersøte Tenenbaums", "Gi Britney en sjanse" — which P3
  // stopped writing in 2003. The film is what the ingress puts in quotes.
  // Reviews keep naming their film and never repeat their own headline, so
  // demand both before renaming: a real title whose ingress happens to
  // quote another film ("Black Hawk down" … «Pang, du er død») stays put.
  const earlyP3 = c.section !== 'film/filmanmeldelser' && c.publishedAt < '2003';
  const shouted = /[!?]$/.test(title);
  if ((shouted || earlyP3) && c.ingressQuoted.length && !inside) {
    const prose = ` ${norm(c.prose)} `;
    const mentions = (q) => prose.split(` ${norm(q)} `).length - 1;
    // Most-mentioned wins: «Nei, jeg snakker ikke om "E.T.", men om
    // Disneys siste tegnefilm "Lilo & Stitch"».
    const best = c.ingressQuoted.map((q) => [q, mentions(q)]).sort((x, y) => y[1] - x[1])[0];
    if (mentions(title) === 0 && best[1] >= (shouted ? 1 : 2)) return done(best[0]);
  }
  return done(title);
}

const unquote = (s) => s.replace(/^["«“”]+|["»”]+$/g, '').trim();

function toRecord(c, name, live) {
  const archiveUrl = `https://web.archive.org/web/${c.ts}/${c.original.replace(':80/', '/')}`;
  const fb = c.factbox;
  const list = (s) => (s ? s.split(/\s*,\s*|\s+og\s+/).map((x) => x.trim()).filter(Boolean) : null);
  // Most stills from the period are ≤ 250 px wide and turn to mush in the
  // review page's hero slot. Keep only the 450 px ones P3 used from 2005;
  // with no image the site falls back to the TMDB poster.
  const still = c.images.filter((i) => i.width >= 400 && i.id !== c.strips.meter).sort((a, b) => b.width - a.width)[0];
  const title = unquote(c.title);

  return {
    id: `wb.${c.oldId}`,
    url: live[c.oldId] ?? archiveUrl,
    type: 'Movie',
    name,
    originalTitle: fb.originaltittel ?? null,
    headline: norm(title) !== norm(name) ? title : null,
    abstract: c.ingress,
    rating: c.rating,
    ratingMax: 6,
    publishedAt: c.publishedAt,
    modifiedAt: c.modifiedAt,
    author: BIRGER,
    image: still ? `https://img.nrk.no/img/${still.id}.jpeg` : null,
    section: c.section === 'film/filmanmeldelser' ? 'Filmanmeldelser' : 'Filmpolitiet',
    platform: c.dvd ? 'DVD' : null,
    reviewType: 'Film',
    factbox: {
      tittel: null,
      originaltittel: fb.originaltittel ?? null,
      regi: fb.regi ?? null,
      serieskaper: null,
      manus: fb.manus ?? null,
      skuespillere: list(fb.skuespillere),
      distributor: fb.distributor ?? null,
      sjanger: list(fb.sjanger),
      lengde: fb.lengde ?? null,
      lengdeMinutes: Number(/(\d{2,3})\s*min/i.exec(fb.lengde ?? '')?.[1]) || null,
      aldersgrense: fb.aldersgrense ?? null,
      norgespremiere: null,
      norgespremiereRaw: fb.norgespremiere ?? null,
      produksjonsAr: null,
      land: list(fb.land),
      sprak: null,
      produsent: fb.produsent ?? null,
      foto: fb.foto ?? null,
      musikk: fb.musikk ?? null,
      klipp: null,
      basertPa: null,
      utgiver: null,
      spillselskap: null,
    },
    wordCount: c.wordCount,
    // Provenance. `archiveUrl` always works; `url` is the live nrk.no page
    // when resolve-live.mjs has found one, else the same archive link.
    legacy: {
      source: 'wayback',
      path: c.key,
      archiveUrl,
      coAuthors: c.byline.names.filter((n) => n !== BIRGER.name),
      bylineFrom: c.byline.from,
      ratingFrom: Object.entries(c.ratingFound).filter(([, v]) => v != null).map(([k]) => k),
    },
  };
}

function tally(items, keyFn) {
  const out = {};
  for (const it of items) { const k = keyFn(it); out[k] = (out[k] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(out).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

main().catch((e) => { console.error(e); process.exit(1); });
