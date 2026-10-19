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
