// Pure parser for NRK's 2000–2006 article template, as archived by the
// Wayback Machine. Importable for testing on cached HTML — no I/O here.
//
// The template is table-layout HTML with a handful of stable class hooks
// that survived every redesign in the period:
//
//   class="oart"   headline; the P3 section appended the rating: "Title (4)"
//   class="in"     ingress (may wrap a lead image)
//   class="brt"    body — byline, factbox and rating strip all live in here
//   class="ad"     "Publisert 30.01.2003 14:00. Oppdatert …"
// The element carrying each class changed (p/span in 2001–02, h1/div
// after), so everything below keys on the class alone.
//
// The terningkast was never text. It's a strip image whose id encodes the
// score, in three flavours (all still served by img.nrk.no):
//   meter   504xx.jpeg  (123×11)  six boxes, P3 2001–2003
//   stars   3710x.gif   (160×26)  animated, one frame per star, 2002–2005
//   popcorn 4097xx.gif  (180×30)  P3 2004–2006, alongside a "(N)" title
// Only the raw strip ids are read here. resolveRating() turns them into a
// score using maps that build-legacy.mjs verifies against the corpus.
//
// Pages are ISO-8859-1.

// 37109.gif = 0 stars … 37115.gif = 6 (frame count − 1).
export const STARS = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((n) => [String(37109 + n), n]));
// Filled boxes, read off the images themselves. The ids aren't contiguous:
// 50447 and 50449–50455 are unrelated photos.
export const METER = { 50442: 0, 50443: 1, 50444: 2, 50445: 3, 50446: 4, 50448: 5, 50456: 6 };

const FACT_LABELS = {
  regi: 'regi', regissør: 'regi',
  med: 'skuespillere', skuespillere: 'skuespillere', 'i rollene': 'skuespillere',
  manus: 'manus',
  originaltittel: 'originaltittel', 'original tittel': 'originaltittel',
  'orginalens tittel': 'originaltittel', 'originalens tittel': 'originaltittel',
  nasjonalitet: 'land', land: 'land',
  sjanger: 'sjanger', genre: 'sjanger',
  lengde: 'lengde', spilletid: 'lengde',
  aldersgrense: 'aldersgrense', sensur: 'aldersgrense',
  premiere: 'norgespremiere', norgespremiere: 'norgespremiere',
  distributør: 'distributor', distribusjon: 'distributor',
  musikk: 'musikk', foto: 'foto', produsent: 'produsent',
};

export function decodeLegacy(buf) {
  // A few late-2006 captures are UTF-8; everything else is Latin-1, where
  // a fatal UTF-8 decode fails on the first æ/ø/å.
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1252').decode(buf); }
}

export function parseLegacy(html) {
  const titleRaw = text(/class="oart"[^>]*>([^<]{1,200})/i.exec(html)?.[1]);
  const published = parseStamp(/Publisert\s+(\d{2})\.(\d{2})\.(\d{4})(?:[ ,]+(?:kl\.?\s*)?(\d{2})[:.](\d{2}))?/i.exec(html));
  if (!titleRaw || !published) return null;        // section front, frameset, 404 stub …

  const body = bodyHtml(html);
  const suffix = /\(([0-6])\)\s*$/.exec(titleRaw)?.[1];
  const strips = {
    title: suffix != null ? Number(suffix) : null,
    star: /\/img\/(3711[0-5]|37109)\.gif/i.exec(body ?? html)?.[1] ?? null,
    popcorn: /\/img\/(\d{6})\.gif"[^>]*width="?180"?[^>]*height="?30/i.exec(body ?? html)?.[1] ?? null,
    // Usually the body's first image, but a still sometimes precedes it.
    meter: [...(body ?? '').matchAll(/<img[^>]+src="[^"]*\/img2?\/(\d+)\.jpe?g"/gi)].map((m) => m[1]).find((id) => id in METER) ?? null,
  };

  const ingress = text(stripTables(/<(div|span) class="in">([\s\S]*?)<\/\1>/i.exec(html)?.[2] ?? ''));
  const byline = extractByline(body ?? '', ingress);
  const title = titleRaw.replace(/\s*\([0-6]\)\s*$/, '').trim();
  const bodyText = text(stripTables(body ?? '')).replace(/\s+/g, ' ').trim();

  return {
    title,
    ingress: ingress || null,
    publishedAt: published,
    modifiedAt: parseStamp(/Oppdatert\s+(\d{2})\.(\d{2})\.(\d{4})(?:[ ,]+(?:kl\.?\s*)?(\d{2})[:.](\d{2}))?/i.exec(html)),
    strips,
    byline,                                          // { names, birger, from } | null
    factbox: extractFacts(body ?? ''),
    quoted: quotedTitles(`${ingress} ${bodyText.slice(0, 1500)}`),
    ingressQuoted: quotedTitles(ingress),
    prose: `${ingress} ${bodyText}`,
    images: [...(body ?? '').matchAll(/<img[^>]+src="[^"]*\/img2?\/(\d+)\.jpe?g"[^>]*?width="?(\d+)/gi)]
      .map((m) => ({ id: m[1], width: Number(m[2]) })),
    wordCount: bodyText ? bodyText.split(' ').length : 0,
    links: [...html.matchAll(/href="([^"#]+\/\d+\.html)"/gi)].map((m) => m[1]),
  };
}

// Every source that is present must agree; a disagreement is reported
// rather than resolved, so a bad map can't silently mis-rate a review.
export function resolveRating(strips, { popcorn = {} } = {}) {
  const found = {
    title: strips.title,
    star: strips.star != null ? STARS[strips.star] ?? null : null,
    popcorn: strips.popcorn != null ? popcorn[strips.popcorn] ?? null : null,
    meter: strips.meter != null ? METER[strips.meter] : null,
  };
  const seen = [...new Set(Object.values(found).filter((v) => v != null))];
  return {
    // 0 is a real score on the strips but the dex's scale is 1–6, so it
    // surfaces as unrated; `found` keeps the raw value for the audit.
    rating: seen.length === 1 && seen[0] >= 1 ? seen[0] : null,
    conflict: seen.length > 1,
    found,
  };
}

// ---------- helpers ----------

function bodyHtml(html) {
  const start = /<(?:div|span) class="brt">/i.exec(html);
  if (!start) return null;
  const rest = html.slice(start.index + start[0].length);
  // The body has no reliable closing tag (it nests image tables), but the
  // dateline, the "tips andre" toolbar or a "SE OGSÅ" box always follows.
  const end = /<(?:span|div|p) class="ad">|redskap\/tipsandre|<\/span>\s*<br clear|<strong>SE OGS/i.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

// Three generations of crediting, tried in order of how explicit they are:
//   "Av <a href=mailto:…>Birger Vestmo</a> og Lars Andersen, NRK P3"
//        top of the body (film section) or its last line (P3 section);
//        the "På nett av …" line under it credits the web editor
//   "Pål Bang-Hansen"   a bare signature closing the text (2001)
//   "…, mener Birger Vestmo."   NRK's own attribution in the ingress
const NAME = /^[A-ZÆØÅ][\p{L}.'-]+(?: [A-ZÆØÅ][\p{L}.'-]+){1,3}$/u;

function extractByline(body, ingress) {
  const lines = body.split(/<br\s*\/?>/i).map((l) => text(stripTables(l)).trim()).filter(Boolean);
  const credit = (names, from) => ({ names, birger: names.includes('Birger Vestmo'), from });

  for (const line of lines) {
    const m = /^Av:?\s+(.{3,120})$/i.exec(line);
    if (!m) continue;
    const names = m[1]
      .replace(/,\s*(NRK\b.*|Filmpoliti\w*.*|P3\b.*|Petre.*|Upunkt.*)$/i, '')
      .split(/\s+og\s+|\s*,\s*|\s*\/\s*/)
      .map((n) => n.trim())
      .filter((n) => NAME.test(n));
    if (names.length) return credit(names, 'av');
  }
  // Signature: the text closes on a name, optionally trailed by a DVD
  // spec sheet ("Orginalens tittel: …"), so look at line starts.
  for (const line of lines.slice(-8)) {
    const m = /^([A-ZÆØÅ][\p{L}.'-]+(?: [A-ZÆØÅ][\p{L}.'-]+){1,2})(?:,? (?:Filmpolitiet|NRK P3|Petre))?(?:\s+Orgi?nalens tittel.*)?$/u.exec(line);
    if (m && NAME.test(m[1])) return credit([m[1]], 'signature');
  }
  const m = /\b(?:mener|synes|skriver|konkluderer|ifølge)\s+(?:filmpoliti(?:ets?)?\s+|vår anmelder\s+)?([A-ZÆØÅ][\p{L}-]+ [A-ZÆØÅ][\p{L}-]+(?:-[A-ZÆØÅ][\p{L}]+)?)/u.exec(ingress ?? '');
  if (m) return credit([m[1]], 'ingress');
  return null;
}

// "Regi: Michael Moore <BR>Med: Michael Moore, Charlton Heston" — only the
// opening lines of the body; a "Regi:" further down is prose.
function extractFacts(body) {
  const out = {};
  const lines = body.split(/<br\s*\/?>/i).slice(0, 14).map((l) => text(stripTables(l)).trim());
  for (const line of lines) {
    // The colon was optional in 2001: "Regi Antoine Fuqua".
    const m = /^([\p{L} ]{3,18}):\s*(.{2,300})$/u.exec(line) ?? /^(Regi)\s+(\p{Lu}.{2,80})$/u.exec(line);
    const key = m && FACT_LABELS[m[1].toLowerCase().trim()];
    if (key && out[key] == null) out[key] = m[2].trim();
  }
  return out;
}

function quotedTitles(s) {
  return [...new Set([...s.matchAll(/["«“”]([^"«»“”]{2,70})["»”]/g)].map((m) => m[1].trim()))].slice(0, 6);
}

function stripTables(h) {
  return h.replace(/<table[\s\S]*?<\/table>/gi, ' ').replace(/<h2[\s\S]*?<\/h2>/gi, ' ');
}

function text(h) {
  if (h == null) return '';
  return decodeEntities(String(h).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  const named = { amp: '&', quot: '"', lt: '<', gt: '>', nbsp: ' ', aring: 'å', Aring: 'Å', oslash: 'ø', Oslash: 'Ø', aelig: 'æ', AElig: 'Æ', eacute: 'é', laquo: '«', raquo: '»', ndash: '–', mdash: '—' };
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => named[n] ?? m);
}

// NRK printed Oslo wall-clock time. Convert to an ISO instant with the
// right offset so legacy records sort correctly against modern ones.
function parseStamp(m) {
  if (!m) return null;
  const [, d, mo, y, h = '12', mi = '00'] = m;
  const offset = isOsloDst(Number(y), Number(mo), Number(d)) ? '+02:00' : '+01:00';
  return `${y}-${mo}-${d}T${h}:${mi}:00${offset}`;
}

// EU rule since 1996: last Sunday of March → last Sunday of October.
function isOsloDst(y, m, d) {
  if (m < 3 || m > 10) return false;
  if (m > 3 && m < 10) return true;
  const lastSunday = 31 - new Date(Date.UTC(y, m - 1, 31)).getUTCDay();
  return m === 3 ? d >= lastSunday : d < lastSunday;
}
