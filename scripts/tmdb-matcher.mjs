// TMDB candidate scoring, shared by enrich-tmdb.mjs (new matches) and
// audit-tmdb.mjs (re-checking existing ones).
//
// The original matcher took the first-page hit with an exact title, else the
// most popular hit, filtered by the year the *review* was published. That
// went wrong in three repeatable ways:
//   - no exact title → popularity wins outright: «Hop» → Star Wars (its
//     title contains "Hope"), «K-19» → The Empire Strikes Back;
//   - remakes and re-releases: «Halloween» (2018) → the 1978 original,
//     «Jaws» reviewed on Blu-ray in 2012 → "Cruel Jaws";
//   - an exact title is not the same film: «Bardo» (Iñárritu) → a 2021
//     short also called Bardo, «Thelma» → Thelma & Louise.
// NRK's factbox names the director for most reviews, which is the one
// signal that tells these apart, so candidates are ranked on it first.

const TMDB = 'https://api.themoviedb.org/3';
const SHORTLIST = 8;     // candidates verified per ordering in findBest
export const NEAR_EXACT = 0.9;

function normalize(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Levenshtein ratio in [0, 1]; callers pass normalized strings.
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

// `altTitles` is filled in by the client when the listed titles aren't
// enough: TMDB often lists an older film only under its English or
// original title (Biler → Cars), with the Norwegian one among the
// alternatives.
function candidateTitles(c) {
  return [c.title, c.original_title, c.name, c.original_name, ...(c.altTitles ?? [])].filter(Boolean);
}

// "Night Watch" vs "Night Watch 2", "Breaking Dawn - Part 1" vs "Part 2":
// the same title but for a sequel number. Close by edit distance, and
// often by director too, but a different film.
const SEQUEL = /^(?:\d+|i{1,3}|iv|v|vi{0,3}|ix|x)$/;
function splitSequel(t) {
  const i = t.lastIndexOf(' ');
  const last = t.slice(i + 1);
  return i > 0 && SEQUEL.test(last) ? [t.slice(0, i), last] : [t, null];
}
function sequelOf(a, b) {
  const [baseA, numA] = splitSequel(a), [baseB, numB] = splitSequel(b);
  return baseA === baseB && numA !== numB;
}

// `title`: best similarity between any review title and any candidate
// title. A review title of two or more words that the candidate's own title
// starts with counts as a strong match («Ringenes herre» → «Ringenes herre
// - Ringens brorskap»); alternative titles are too varied for that.
// `sequel`: the candidate is another instalment of the reviewed title —
// a sequel pair and no exact title anywhere.
function titleMatch(refs, cand) {
  const own = new Set([cand.title, cand.original_title, cand.name, cand.original_name].filter(Boolean).map(normalize));
  const titles = candidateTitles(cand).map(normalize);
  let title = 0, exact = false, sequel = false;
  for (const nr of refs) {
    for (const nt of titles) {
      if (nr === nt) exact = true;
      if (sequelOf(nr, nt)) { sequel = true; continue; }
      title = Math.max(title, similarity(nr, nt));
      if (own.has(nt) && nr.includes(' ') && nt.startsWith(nr + ' ')) title = Math.max(title, 0.8);
    }
  }
  return { title, sequel: sequel && !exact };
}

function releaseYear(c) {
  const y = Number((c.release_date ?? c.first_air_date ?? '').slice(0, 4));
  return y || null;
}

const nameTokens = (s) => normalize(s).split(' ').filter((t) => t.length >= 3);
const tokenMatch = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && similarity(a, b) >= 0.8);

// One NRK name against one TMDB name: two shared tokens, or a surname
// (either side's last token) found on the other side. Tolerates the
// factbox's typos («Washowski», «Kossakovksy») and name order.
function sameName(nrk, tmdb) {
  const a = nameTokens(nrk), b = nameTokens(tmdb);
  if (!a.length || !b.length) return false;
  const shared = a.filter((t) => b.some((u) => tokenMatch(t, u))).length;
  if (shared >= 2) return true;
  return b.some((u) => tokenMatch(a.at(-1), u)) || a.some((t) => tokenMatch(t, b.at(-1)));
}

/**
 * 1 = the factbox director is among `names`, -1 = they disagree, 0 = can't
 * tell (no usable factbox director, or no TMDB directors). `names` holds
 * every director's name plus their TMDB aliases, since TMDB now often
 * lists people in their own script (是枝裕和 for Kore-eda).
 */
function directorVerdict(regi, names) {
  if (!regi || !names?.length) return 0;
  const text = Array.isArray(regi) ? regi.join(', ') : String(regi);
  if (/flere|diverse|m\.\s*fl/i.test(text)) return 0;
  const people = text.split(/\s*(?:,|\/|&|\bog\b|\band\b)\s*/i).filter((p) => nameTokens(p).length);
  if (!people.length) return 0;
  return people.some((p) => names.some((n) => sameName(p, n))) ? 1 : -1;
}

/**
 * Score a candidate for a review. `ctx` comes from reviewContext().
 * A film released more than a year after the review was published can't
 * be the one reviewed («Skyggespill», 2007 → Sherlock Holmes 2011) —
 * unless the director confirms it, since TMDB sometimes dates a film by a
 * later re-release.
 */
export function scoreCandidate(ctx, cand, directorNames) {
  const y = releaseYear(cand);
  const dir = directorVerdict(ctx.regi, directorNames);
  return {
    eligible: dir === 1 || !(y && ctx.reviewYear && y > ctx.reviewYear + 1),
    dir,
    yearClose: !!(y && ctx.reviewYear && Math.abs(ctx.reviewYear - y) <= 1),
    ...titleMatch(ctx.refs, cand),
    pop: cand.popularity ?? 0,
  };
}

// A candidate is acceptable when the director confirms it, or — with no
// director signal — when the title genuinely resembles the review's. Edit
// distance is lenient on short titles («Edison City» is 0.64 from «Sin
// City»), hence the high bar.
const TITLE_OK = 0.75;
export const acceptable = (s) => s.eligible && !s.sequel && s.dir >= 0 && (s.dir === 1 || s.title >= TITLE_OK);

// Director first; then a near-exact title over a near year, since a
// re-release keeps its title but not its date («The Warriors» on DVD in
// 2006 is the 1979 film, not 2007's "The Warriors: The Way Home").
function compareScores(a, b) {
  return (b.dir - a.dir)
    || (Number(b.title >= NEAR_EXACT) - Number(a.title >= NEAR_EXACT))
    || (Number(b.yearClose) - Number(a.yearClose))
    || (b.pop - a.pop);
}

/** Minimal TMDB v3 client with per-run caches for details and aliases. */
export function tmdbClient({ key, fetchJson }) {
  const details = new Map(), aliases = new Map();
  const get = (path, params = {}) =>
    fetchJson(`${TMDB}${path}?${new URLSearchParams({ api_key: key, ...params })}`);

  async function search(query, year, mediaType) {
    const params = { query, language: 'nb-NO', include_adult: 'false' };
    if (year) params[mediaType === 'tv' ? 'first_air_date_year' : 'year'] = String(year);
    const json = await get(`/search/${mediaType}`, params);
    return (json.results ?? []).map((r) => ({ ...r, mediaType }));
  }

  async function personNames(person) {
    if (/^[\p{Script=Latin}\s.'’-]+$/u.test(person.name ?? '')) return [person.name];
    if (!aliases.has(person.id)) {
      const p = await get(`/person/${person.id}`).catch(() => ({}));
      aliases.set(person.id, [person.name, person.original_name, ...(p.also_known_as ?? [])].filter(Boolean));
    }
    return aliases.get(person.id);
  }

  // One detail call serves both the directors and the alternative titles.
  function detail(id, mediaType) {
    const k = `${mediaType}/${id}`;
    if (!details.has(k)) {
      details.set(k, get(`/${mediaType}/${id}`, { append_to_response: 'credits,alternative_titles,translations' }).catch(() => ({})));
    }
    return details.get(k);
  }

  // Every director's name and aliases. TV directors are per-episode, so a
  // series is judged on its creators instead.
  async function directorNames(id, mediaType) {
    const d = await detail(id, mediaType);
    const people = mediaType === 'tv' ? d.created_by ?? [] : (d.credits?.crew ?? []).filter((c) => c.job === 'Director');
    const names = [];
    for (const p of people) names.push(...await personNames(p));
    return names;
  }

  // Alternative titles and translated titles, in every language.
  async function altTitles(id, mediaType) {
    const d = await detail(id, mediaType);
    const alt = d.alternative_titles?.titles ?? d.alternative_titles?.results ?? [];
    const tr = d.translations?.translations ?? [];
    return [...alt.map((t) => t.title), ...tr.map((t) => t.data?.title ?? t.data?.name)].filter(Boolean);
  }

  return { get, search, directorNames, altTitles };
}

/**
 * Score `cand`, fetching its directors when the review names one and its
 * alternative titles when the listed ones don't resemble the review's.
 * Mutates `cand.altTitles`.
 */
export async function scoreFully(client, ctx, cand) {
  const names = ctx.regi ? await client.directorNames(cand.id, cand.mediaType) : [];
  let s = scoreCandidate(ctx, cand, names);
  if (s.title < TITLE_OK) {
    cand.altTitles = await client.altTitles(cand.id, cand.mediaType);
    s = scoreCandidate(ctx, cand, names);
  }
  return { s, names };
}

/**
 * Search TMDB for a review and return the best acceptable candidate, with
 * its score, or null. Searches both titles, the review year, the year
 * before (festival premieres) and no year (re-releases), then checks the
 * director of the strongest few.
 */
export async function findBest(client, review) {
  const ctx = reviewContext(review);
  const mediaType = review.type === 'TVSeries' ? 'tv' : 'movie';
  const pool = new Map(), hits = new Map();
  for (const q of ctx.queries) {
    for (const year of new Set([ctx.reviewYear, ctx.reviewYear && ctx.reviewYear - 1, null])) {
      for (const c of await client.search(q, year, mediaType)) {
        if (!pool.has(c.id)) pool.set(c.id, c);
        hits.set(c.id, (hits.get(c.id) ?? 0) + 1);
      }
    }
  }
  // The shortlist takes the best few by era and the best few by title,
  // each preferring films more of the searches returned: a page of
  // same-name films crowds the reviewed one out of either list alone
  // («Peninsula» 2020 is listed as 반도, «Taxi Teheran» as تاکسی; «The Kid»
  // on re-release is from 1921).
  const all = [...pool.values()].map((c) => ({ c, s: scoreCandidate(ctx, c, []), h: hits.get(c.id) }));
  const byEra = [...all].sort((a, b) => (Number(b.s.yearClose) - Number(a.s.yearClose)) || (b.h - a.h) || (b.s.title - a.s.title) || (b.s.pop - a.s.pop));
  const byTitle = [...all].sort((a, b) => (b.s.title - a.s.title) || (b.h - a.h) || (b.s.pop - a.s.pop));
  const prelim = new Set([...byEra.slice(0, SHORTLIST), ...byTitle.slice(0, SHORTLIST)].map(({ c }) => c));
  const scored = [];
  for (const c of prelim) scored.push({ c, ...await scoreFully(client, ctx, c) });
  const best = scored.filter(({ s }) => acceptable(s)).sort((a, b) => compareScores(a.s, b.s))[0];
  return best ?? null;
}

// `queries` are the review's titles as searched; `refs` the same titles
// normalized once for every comparison.
export function reviewContext(review) {
  const queries = [...new Set([review.originalTitle, review.name].filter(Boolean).map(decodeEntities))];
  return {
    queries,
    refs: queries.map(normalize),
    reviewYear: Number(review.publishedAt?.slice(0, 4)) || null,
    regi: review.factbox?.regi ?? null,
  };
}

// NRK's API leaks HTML entities into name fields (`God&#039;s Own Country`,
// `Deadpool &amp; Wolverine`). Decode before querying TMDB — the literal
// entity string causes 27 otherwise-findable titles to register as misses.
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  if (!s) return s;
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const cp = code[1] === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}
