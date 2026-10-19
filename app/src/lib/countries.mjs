// Display helpers for ISO 3166-1 country codes (TMDB `iso_3166_1`, carried
// through as `productionCountryCodes` by scripts/sync-data.mjs). Plain .mjs
// so the Node build script, Astro pages and Vue islands can all import it.

// Withdrawn or user-assigned codes TMDB uses (older films, Northern
// Ireland); Intl.DisplayNames doesn't know them and they have no flag emoji.
const NON_ISO = {
  SU: 'Sovjetunionen', YU: 'Jugoslavia', CS: 'Serbia og Montenegro',
  XC: 'Tsjekkoslovakia', XG: 'Øst-Tyskland', DD: 'Øst-Tyskland', XI: 'Nord-Irland',
};
// Shorter, everyday names where CLDR's official form reads awkwardly.
const OVERRIDE = { HK: 'Hongkong', PS: 'Palestina' };

let _dn = null;
/** Norwegian (bokmål) display name for an ISO code. */
export function countryName(code) {
  if (OVERRIDE[code] || NON_ISO[code]) return OVERRIDE[code] ?? NON_ISO[code];
  try {
    _dn ??= new Intl.DisplayNames(['nb', 'no'], { type: 'region' });
    return _dn.of(code) ?? code;
  } catch { return code; }
}

/** Regional-indicator flag emoji; empty for non-ISO codes. */
export function countryFlag(code) {
  if (!/^[A-Z]{2}$/.test(code) || NON_ISO[code]) return '';
  return String.fromCodePoint(...[...code].map((ch) => 0x1f1a5 + ch.charCodeAt(0)));
}
