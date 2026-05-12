// Tiny presentation helpers. Norwegian conventions where applicable.

const NB_MONTHS = [
  'januar','februar','mars','april','mai','juni',
  'juli','august','september','oktober','november','desember',
];

export function formatNorwegianDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getDate()}. ${NB_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatYear(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 4);
}

export function formatRuntime(min: number | null | undefined): string {
  if (!min || min < 1) return '';
  const h = Math.floor(min / 60), m = min % 60;
  if (h && m) return `${h}t ${m}m`;
  if (h) return `${h}t`;
  return `${m}m`;
}

export function pad(n: number, width = 4): string {
  return String(n).padStart(width, '0');
}

export function pluralize(n: number, one: string, many: string): string {
  return `${n.toLocaleString('nb-NO')} ${n === 1 ? one : many}`;
}

export function sanitizeQuotes(s: string | null | undefined): string {
  return (s ?? '').replace(/[«»“”]/g, '').trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

/** Decode the small set of HTML entities NRK's API leaks into title fields
 *  (e.g. `God&#039;s Own Country` → `God's Own Country`). Handles named
 *  refs and decimal/hex numeric refs. Idempotent — safe to call on
 *  already-decoded strings. */
export function decodeEntities(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const cp = code[1] === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}

export function ratingLabel(r: number | null | undefined): string {
  if (r == null) return 'Uten kast';
  return ['svakt','tynt','greit','solid','sterkt','mesterverk'][r - 1] ?? '';
}

export function platformBucket(s: string | null): 'cinema' | 'streaming' | 'distributor' | 'unknown' {
  if (!s) return 'unknown';
  const t = s.toLowerCase();
  if (/(kino|premiere|på kino)/.test(t)) return 'cinema';
  if (/(netflix|hbo|disney\+|prime|apple tv|viaplay|amazon|hulu|paramount\+|max)/.test(t)) return 'streaming';
  if (/ukjent|ikke|ennå|uvisst/.test(t)) return 'unknown';
  return 'distributor';
}

export function dieDots(n: number): { x: number; y: number }[] {
  // standard dice pip layout for n=1..6 on a unit-square (0..1)
  const layouts: Record<number, [number, number][]> = {
    1: [[.5,.5]],
    2: [[.25,.25],[.75,.75]],
    3: [[.25,.25],[.5,.5],[.75,.75]],
    4: [[.25,.25],[.75,.25],[.25,.75],[.75,.75]],
    5: [[.25,.25],[.75,.25],[.5,.5],[.25,.75],[.75,.75]],
    6: [[.25,.2],[.75,.2],[.25,.5],[.75,.5],[.25,.8],[.75,.8]],
  };
  return (layouts[n] ?? []).map(([x,y]) => ({ x, y }));
}
