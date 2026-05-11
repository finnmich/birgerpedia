// Build-time aggregation of every person who shows up in the corpus, with
// the reviews they're connected to. Used to generate /people pages.
//
// Sources:
//   - factbox.regi / serieskaper / manus     → director / showrunner / writer
//   - factbox.skuespillere                    → cast (NRK-supplied, often partial)
//   - tmdb.cast (top 12 per review)           → cast (TMDB, with profile photos)
//   - tmdb.crew.director.profile              → director photo when available

import { reviewIndex } from './data';
import type { ReviewIndexEntry } from './types';
import { allEnrichment } from './enrichment';
import { slugify } from './slug';

// Read once at module init — see enrichment.ts for why this is a runtime
// fs read rather than a `import enrichmentJson from '...'` (Vite would
// have to transform 4.4 MB of JSON on every cold page render otherwise).
const enrichment = allEnrichment() as Record<string, any>;

export type PersonRole = 'director' | 'writer' | 'creator' | 'actor';

export interface PersonReview {
  review: ReviewIndexEntry;
  role: PersonRole;
  character?: string | null;
}

export interface PersonPage {
  name: string;
  slug: string;
  profile: string | null;
  roles: Set<PersonRole>;
  appearances: PersonReview[];
  ratedAppearances: PersonReview[];
  total: number;
  totalRated: number;
  avgRating: number | null;
  best: PersonReview | null;
  worst: PersonReview | null;
  yearRange: { min: number; max: number } | null;
  asDirector: number;
  asActor: number;
  asWriter: number;
  asCreator: number;
}

// Names like "Phil Lord og Christopher Miller" → ["Phil Lord", "Christopher Miller"]
function splitDirectors(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .split(/\s+og\s+|,\s*/i)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);
}

// Normalize a name to a case/diacritics-insensitive key for portrait lookup.
// We avoid `localeCompare` here because it's ~50× slower than string ops at
// scale — invoked 200M+ times during graph-build it added 90+ seconds.
function nameKey(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();
}

const peopleMap = new Map<string, PersonPage>();
// `profileByName` maps a name (from TMDB cast/crew) to its profile URL.
// `profileByKey` is a case/diacritics-insensitive index over the same data
// so that `ensure()` can do an O(1) fallback when a NRK-spelt name and a
// TMDB-spelt name disagree on case or accents.
const profileByName = new Map<string, string>();
const profileByKey = new Map<string, string>();
const seenAppearance = new Set<string>();   // `${slug}::${reviewId}::${role}` for O(1) dedupe

// First pass: collect TMDB profile photos so each person gets their best portrait.
for (const r of reviewIndex) {
  const e = enrichment[r.id];
  if (!e || e.miss) continue;
  if (e.crew?.director?.profile) {
    const dirName = e.crew.director.name as string;
    if (dirName && !profileByName.has(dirName)) {
      profileByName.set(dirName, e.crew.director.profile);
      const k = nameKey(dirName);
      if (k && !profileByKey.has(k)) profileByKey.set(k, e.crew.director.profile);
    }
  }
  for (const c of e.cast ?? []) {
    if (c.profile && c.name && !profileByName.has(c.name)) {
      profileByName.set(c.name, c.profile);
      const k = nameKey(c.name);
      if (k && !profileByKey.has(k)) profileByKey.set(k, c.profile);
    }
  }
}

function ensure(name: string): PersonPage {
  const slug = slugify(name);
  let p = peopleMap.get(slug);
  if (!p) {
    // Exact match → case/diacritics-insensitive fallback. Both O(1).
    const profile = profileByName.get(name)
      ?? profileByKey.get(nameKey(name))
      ?? null;
    p = {
      name,
      slug,
      profile,
      roles: new Set(),
      appearances: [],
      ratedAppearances: [],
      total: 0, totalRated: 0,
      avgRating: null,
      best: null, worst: null,
      yearRange: null,
      asDirector: 0, asActor: 0, asWriter: 0, asCreator: 0,
    };
    peopleMap.set(slug, p);
  }
  return p;
}

function add(name: string, role: PersonRole, review: ReviewIndexEntry, character?: string | null) {
  if (!name || name.length < 2) return;
  const p = ensure(name);
  // O(1) dedupe via a global Set (the previous Array.find was O(n) per call,
  // making the total cost O(N²) for popular actors).
  const key = `${p.slug}::${review.id}::${role}`;
  if (seenAppearance.has(key)) return;
  seenAppearance.add(key);
  p.appearances.push({ review, role, character: character ?? null });
  p.roles.add(role);
}

// Second pass: walk every review and add its credits.
for (const r of reviewIndex) {
  // Director(s) — split "x og y"
  for (const name of splitDirectors(r.factbox?.regi)) add(name, 'director', r);
  // Series creator(s)
  for (const name of splitDirectors(r.factbox?.serieskaper)) add(name, 'creator', r);
  // Writer(s)
  for (const name of splitDirectors(r.factbox?.manus)) add(name, 'writer', r);
  // NRK-listed actors
  for (const name of (r.factbox?.skuespillere ?? [])) add(name.trim(), 'actor', r);
  // TMDB cast (richer when available — includes actors NRK didn't list)
  const e = enrichment[r.id];
  if (e && !e.miss) {
    for (const c of e.cast ?? []) {
      add(c.name, 'actor', r, c.character);
    }
  }
}

// Final pass: derive per-person stats.
for (const p of peopleMap.values()) {
  p.total = p.appearances.length;
  p.ratedAppearances = p.appearances.filter((a) => a.review.rating != null);
  p.totalRated = p.ratedAppearances.length;
  if (p.totalRated) {
    p.avgRating = p.ratedAppearances.reduce((s, a) => s + (a.review.rating ?? 0), 0) / p.totalRated;
    p.best = p.ratedAppearances.reduce((b, a) => (a.review.rating ?? 0) > (b.review.rating ?? 0) ? a : b, p.ratedAppearances[0]);
    p.worst = p.ratedAppearances.reduce((w, a) => (a.review.rating ?? 0) < (w.review.rating ?? 0) ? a : w, p.ratedAppearances[0]);
  }
  const years = p.appearances.map((a) => a.review.year).filter(Boolean) as number[];
  if (years.length) p.yearRange = { min: Math.min(...years), max: Math.max(...years) };
  p.asDirector = p.appearances.filter((a) => a.role === 'director').length;
  p.asActor    = p.appearances.filter((a) => a.role === 'actor').length;
  p.asWriter   = p.appearances.filter((a) => a.role === 'writer').length;
  p.asCreator  = p.appearances.filter((a) => a.role === 'creator').length;

  // Most-recent first within each role; appearances list also chrono-sorted
  p.appearances.sort((a, b) => (b.review.publishedAt ?? '').localeCompare(a.review.publishedAt ?? ''));
}

export const people: PersonPage[] = [...peopleMap.values()].sort((a, b) => b.total - a.total);

export function findPerson(slug: string): PersonPage | undefined {
  return peopleMap.get(slug);
}

// Threshold for static-page generation:
//   - 2+ appearances always qualify (real cross-corpus presence)
//   - 1-credit directors / creators only qualify when we have a TMDB profile
//     photo for them — otherwise the page is just a single review card and
//     nothing else, which is wasted weight (876 such pages in the previous
//     build). Their name simply renders as plain text on review pages.
export function eligibleForPage(p: PersonPage): boolean {
  if (p.total >= 2) return true;
  if ((p.asDirector + p.asCreator) >= 1 && p.profile) return true;
  return false;
}

export const eligiblePeople = people.filter(eligibleForPage);
export const eligibleSlugs = new Set(eligiblePeople.map((p) => p.slug));
