// URL slug helpers.
//
// Reviews live at /reviews/<slug>-<idTail>; the trailing NRK content-id
// guarantees uniqueness even if two films share a title. People live at
// /people/<slug> — uniqueness for non-Latin names is preserved by hashing
// the original name when slugify produces an empty Latin form (otherwise
// every CJK / Thai / Hebrew name would collapse onto a single URL).

export function slugify(input: string): string {
  const ascii = (input ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (ascii) return ascii;
  // Non-Latin name: derive a stable short hash so each gets a unique page.
  const h = stableHash(String(input ?? ''));
  return `n-${h.toString(36).padStart(7, '0').slice(-7)}`;
}

export function reviewSlug(name: string, id: string): string {
  const tail = id.split('.').at(-1) ?? id;
  return `${slugify(name) || 'review'}-${tail}`;
}

export function idFromSlug(slug: string): string | null {
  const m = /-([0-9]+)$/.exec(slug);
  return m ? `1.${m[1]}` : null;
}

// Tiny FNV-1a 32-bit. Deterministic across builds for the same input.
function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
