// The one rule for "is this TMDB match trustworthy enough to show as fact?".
// Shared by scripts/sync-data.mjs (slim index, stats) and lib/data.ts (SSG),
// so the index filters, the stats and the review pages can't drift apart.
/**
 * @template T
 * @param {T | null | undefined} e
 * @returns {e is NonNullable<T>}
 */
export function isConfidentMatch(e) {
  const m = /** @type {any} */ (e);
  return !!m && !m.miss && (m.confidence === 'high' || m.confidence === 'medium');
}

// The TMDB id an enrichment record holds: null for a miss. Takes both
// shapes — per-review files carry `match.tmdbId`, the aggregate `tmdbId` —
// so enrich-tmdb.mjs and sync-data.mjs agree on whether a pin in
// data/tmdb-overrides.json is already satisfied.
/** @param {any} e */
export function heldTmdbId(e) {
  return e.miss ? null : e.match?.tmdbId ?? e.tmdbId ?? null;
}
