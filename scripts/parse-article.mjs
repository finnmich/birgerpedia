// Pure parser. Takes raw NRK article HTML, returns a normalized record.
// Importable for unit testing on cached HTML.
//
// Anchors used (verified across pre-Astro and Astro-era articles):
//   1. <script type="application/ld+json"> — schema.org/Review
//   2. <meta property="…"> tags (og:, article:, nrk:)
//   3. <div class="review-info"> header block (modern only)
//   4. <p>Label: Value</p> factbox in body (modern only)
//   5. <div data-main-content … class="article-body lp_articlebody">
//
// Returns null when no Review JSON-LD is present (i.e. not a review article).

const LABEL_KEY_MAP = {
  tittel: 'tittel',
  originaltittel: 'originaltittel',
  regi: 'regi',
  serieskaper: 'serieskaper',
  manus: 'manus',
  skuespillere: 'skuespillere',
  stemmer: 'stemmer',
  distributør: 'distributor',
  distributor: 'distributor',
  sjanger: 'sjanger',
  lengde: 'lengde',
  spilletid: 'lengde',
  aldersgrense: 'aldersgrense',
  norgespremiere: 'norgespremiere',
  premiere: 'norgespremiere',
  kinopremiere: 'norgespremiere',
  produksjonsår: 'produksjonsAr',
  produksjonsaar: 'produksjonsAr',
  land: 'land',
  språk: 'sprak',
  sprak: 'sprak',
  produsent: 'produsent',
  foto: 'foto',
  musikk: 'musikk',
  klipp: 'klipp',
  basertpa: 'basertPa',
  'basert på': 'basertPa',
  formidlet: 'formidlet',
  format: 'format',
  plattform: 'plattform',
  utgiver: 'utgiver',
  spillselskap: 'spillselskap',
  tilgjengelig: 'tilgjengelig',
};

const NORWEGIAN_MONTHS = {
  januar: 1, februar: 2, mars: 3, april: 4, mai: 5, juni: 6,
  juli: 7, august: 8, september: 9, oktober: 10, november: 11, desember: 12,
};

export function parseArticle(html, { url, id } = {}) {
  const ld = extractReviewJsonLd(html);
  if (!ld) return null; // not a review article

  const meta = extractMetaTags(html);
  const reviewInfo = extractReviewInfo(html);
  const factbox = extractFactbox(html);
  const body = extractBody(html);

  const author = pickAuthor(ld, meta);
  const itemReviewed = ld.itemReviewed ?? {};
  const rating = pickRating(ld);

  const skuespillere = splitList(factbox.skuespillere ?? factbox.stemmer);
  // New-CMS (May 2026+) pages have no review-info block and no factbox —
  // but itemReviewed carries genre, contentRating and the premiere date.
  const sjanger = splitList(factbox.sjanger ?? reviewInfo.sjangerLine ?? itemReviewed.genre);
  const land = splitList(factbox.land);
  const lengdeMinutes = parseRuntime(factbox.lengde);
  const norgespremiere = parseDate(
    factbox.norgespremiere ?? reviewInfo.premiereLine ?? itemReviewed.datePublished,
  );

  return {
    id: id ?? meta['nrk:content_id'] ?? null,
    url: meta['og:url'] ?? url ?? null,
    canonicalUrl: ld.mainEntityOfPage?.['@id'] ?? null,
    section: meta['article:section'] ?? null,

    type: itemReviewed['@type'] ?? null,         // Movie | TVSeries | VideoGame | …
    name: stripQuotes(reviewInfo.titleLine ?? itemReviewed.name ?? ld.headline ?? null),
    originalTitle: stripQuotes(reviewInfo.originalTitleLine ?? null),
    headline: ld.headline ?? null,
    abstract: ld.abstract ?? meta['og:title'] ?? null,

    rating,                                       // 1..6 (or null)
    ratingMax: ld.reviewRating?.bestRating ? Number(ld.reviewRating.bestRating) : 6,

    publishedAt: ld.datePublished ?? meta['article:published_time'] ?? null,
    modifiedAt: ld.dateModified ?? meta['article:modified_time'] ?? null,

    author,                                       // { id, name, url, email }

    image: meta['og:image'] ?? (Array.isArray(ld.image) ? ld.image[0] : ld.image) ?? null,
    imageDescription: ld.image?.description ?? null,

    factbox: {
      tittel: stripQuotes(factbox.tittel),
      originaltittel: stripQuotes(factbox.originaltittel ?? reviewInfo.originalTitleLine ?? null),
      regi: factbox.regi ?? itemReviewed.director?.name ?? reviewInfo.regiLine ?? null,
      serieskaper: factbox.serieskaper ?? reviewInfo.serieskaperLine ?? null,
      manus: factbox.manus ?? null,
      skuespillere,
      distributor: factbox.distributor ?? null,
      sjanger,
      lengde: factbox.lengde ?? null,
      lengdeMinutes,
      aldersgrense: factbox.aldersgrense ?? reviewInfo.aldersLine ?? itemReviewed.contentRating ?? null,
      norgespremiere,
      norgespremiereRaw: factbox.norgespremiere ?? reviewInfo.premiereLine ?? itemReviewed.datePublished ?? null,
      produksjonsAr: factbox.produksjonsAr ?? null,
      land,
      sprak: factbox.sprak ?? null,
      produsent: factbox.produsent ?? null,
      foto: factbox.foto ?? null,
      musikk: factbox.musikk ?? null,
      klipp: factbox.klipp ?? null,
      basertPa: factbox.basertPa ?? null,
      utgiver: factbox.utgiver ?? null,
      spillselskap: factbox.spillselskap ?? null,
    },

    platform: reviewInfo.platformLine ?? null,    // Kino, Netflix, HBO, Viaplay, …
    reviewType: reviewInfo.reviewType ?? reviewTypeFromItemType(itemReviewed['@type']),

    bodyText: body.text,
    wordCount: body.wordCount,

    raw: {
      ld,
      meta,
      reviewInfo,
      factbox,
    },
  };
}

// ---------- helpers ----------

function extractReviewJsonLd(html) {
  // Pull every <script type="application/ld+json">…</script> blob, find the Review.
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = m[1].trim();
    if (!text) continue;
    let json;
    try { json = JSON.parse(text); } catch { continue; }
    const arr = Array.isArray(json) ? json : [json];
    for (const node of arr) {
      const t = node?.['@type'];
      if (t === 'Review' || (Array.isArray(t) && t.includes('Review'))) {
        return node;
      }
    }
  }
  return null;
}

function extractMetaTags(html) {
  const out = {};
  const re = /<meta\s+(?:[^>]*?)\s*(?:property|name)=["']([^"']+)["']\s+(?:[^>]*?)content=["']([^"']*)["'][^>]*>/gi;
  // Also handle attribute order: content first, then property/name
  const re2 = /<meta\s+(?:[^>]*?)\s*content=["']([^"']*)["']\s+(?:[^>]*?)(?:property|name)=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) out[m[1]] = decodeEntities(m[2]);
  while ((m = re2.exec(html))) {
    if (out[m[2]] === undefined) out[m[2]] = decodeEntities(m[1]);
  }
  return out;
}

function extractReviewInfo(html) {
  // Common shape across CMS eras:
  //   <div class="review-info">
  //     <h3>«Norwegian Title»</h3>
  //     [<p class="secondary">[«]Original Title[»]</p>]?      ← outside the inner divs
  //     <div> [<p>Regi/Serieskaper: …</p>] </div>
  //     <div>
  //       <p>Genre1, Genre2, …</p>
  //       [<p>Aldersgrense: …</p>]?
  //       [<p>Sesong N</p>]?
  //       [<p class="secondary">DATE</p>]?     DD. mnd YYYY  | DD.MM.YYYY
  //       [<p class="secondary">Platform/Distributor</p>]?
  //     </div>
  //   </div>
  const out = {
    titleLine: null, originalTitleLine: null,
    sjangerLine: null, regiLine: null, serieskaperLine: null,
    aldersLine: null, sesongLine: null,
    premiereLine: null, platformLine: null,
    reviewType: null,
  };
  const rt = /<span\s+class="review-type">\s*([^<]+?)\s*<\/span>/i.exec(html);
  if (rt) out.reviewType = rt[1].trim();

  const block = grabReviewInfoBlock(html);
  if (!block) return out;

  const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(block);
  if (h3) out.titleLine = stripTags(h3[1]).trim();

  // The position of the first inner <div> is the boundary between header
  // (h3, optional original-title secondary p) and body (credits + meta).
  const firstDiv = block.search(/<div\b/i);

  // Walk every <p> inside the review-info block, in document order, with
  // a flag marking whether it's in the header section.
  for (const { cls, txt, pos } of pTagsWithPos(block)) {
    if (!txt) continue;
    const secondary = cls.includes('secondary');
    const inHeader = firstDiv < 0 ? true : pos < firstDiv;

    if (inHeader && secondary && !out.originalTitleLine) {
      out.originalTitleLine = txt;
      continue;
    }

    if (/^Regi\s*:/i.test(txt))               out.regiLine        ??= txt.replace(/^Regi\s*:\s*/i, '');
    else if (/^Serieskaper\s*:/i.test(txt))   out.serieskaperLine ??= txt.replace(/^Serieskaper\s*:\s*/i, '');
    else if (/^Aldersgrense\s*:/i.test(txt))  out.aldersLine      ??= txt.replace(/^Aldersgrense\s*:\s*/i, '');
    else if (/^Sesong\s+\d+/i.test(txt))      out.sesongLine      ??= txt;
    else if (secondary && isDateLike(txt))    out.premiereLine    ??= txt;
    else if (secondary && !isQuoted(txt))     out.platformLine    ??= txt;
    else if (!secondary && !out.sjangerLine && !/:/.test(txt) && !isQuoted(txt)) {
      // Genre line: comma list, or single capitalized word like "Drama".
      if (/,/.test(txt) || /^[A-ZÆØÅ][a-zæøåA-ZÆØÅ\s-]+$/.test(txt)) {
        out.sjangerLine = txt;
      }
    }
  }
  return out;
}

function grabReviewInfoBlock(html) {
  const start = html.search(/<div\s+class="review-info">/i);
  if (start < 0) return null;
  const after = html.indexOf('>', start) + 1;
  let depth = 1;
  const re = /<\/?div\b[^>]*>/gi;
  re.lastIndex = after;
  let m;
  while ((m = re.exec(html))) {
    depth += /^<\//.test(m[0]) ? -1 : 1;
    if (depth === 0) return html.slice(after, m.index);
  }
  return null;
}

function pTagsWithPos(html) {
  return [...html.matchAll(/<p(?:\s+class="([^"]*)")?[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => ({ cls: m[1] ?? '', txt: stripTags(m[2]).trim(), pos: m.index }));
}

function isDateLike(s) {
  // The string IS a date, OR it contains one with a premiere-style prefix
  // ("PÅ KINO 30. april 2025", "Kinopremiere 26. april 2024", "Norgespremiere 6. juni 2025").
  if (/^\d{1,2}\.\s*[a-zæøå]+\s+\d{4}$/i.test(s)) return true;   // 8. mai 2026
  if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(s)) return true;          // 08.04.2011
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return true;                // 2026-05-08
  // Contains a date with a premiere/release prefix.
  if (/(?:PÅ KINO|kinopremiere|norgespremiere|premiere|relansering)/i.test(s) &&
      /\d{1,2}[.\s]+(?:[a-zæøå]+\s+\d{4}|\d{1,2}\.\d{4})/i.test(s)) return true;
  return false;
}
function isQuoted(s) {
  return /^[«"][\s\S]*[»"]$/.test(s);
}

function extractFactbox(html) {
  // <p>Label: Value</p> pairs anywhere in the document. Only keep keys we know.
  const out = {};
  const re = /<p[^>]*>\s*([^<:]{1,40})\s*:\s*([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html))) {
    const rawKey = m[1].trim().toLowerCase().replace(/\s+/g, '');
    const key = LABEL_KEY_MAP[rawKey];
    if (!key) continue;
    if (out[key] !== undefined) continue;       // first occurrence wins
    out[key] = decodeEntities(stripTags(m[2]).trim());
  }
  return out;
}

function extractBody(html) {
  // Find <div … class="article-body lp_articlebody …">…</div>. The closing is
  // the matching </div> of the *opening* div — we approximate by capturing up
  // to a sentinel further down in the page.
  const m = /<div[^>]*class="[^"]*\barticle-body\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<(?:footer|aside|div[^>]*class="[^"]*article-footer)/i.exec(html);
  let inner = m ? m[1] : '';
  if (!inner) {
    const m2 = /<div[^>]*class="[^"]*\blp_articlebody\b[^"]*"[^>]*>([\s\S]*)/i.exec(html);
    inner = m2 ? m2[1] : '';
  }
  if (!inner) {
    // New-CMS (May 2026+): article-body div with utility classes, no
    // lp_articlebody, no footer/aside sentinel — capture to </article>.
    const m3 = /<div[^>]*class="article-body[^"]*"[^>]*>([\s\S]*?)<\/article>/i.exec(html);
    inner = m3 ? m3[1] : '';
  }
  // Strip NRK serum include comments and embedded relation widgets.
  inner = inner
    .replace(/<!--\s*include:[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<figure[\s\S]*?<\/figure>/gi, ' ');
  const ps = [...inner.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(([, t]) => decodeEntities(stripTags(t)).trim())
    .filter((t) => t.length > 0 && !/^\s*\w{1,30}\s*:\s/.test(t));
  const text = ps.join('\n\n');
  const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
  return { text, wordCount };
}

// "Film" | "Serie" | "Spill" fallback for new-CMS pages, which lack the
// review-type span. Values mirror what the legacy span carried.
function reviewTypeFromItemType(t) {
  const type = Array.isArray(t) ? t[0] : t;
  return { Movie: 'Film', TVSeries: 'Serie', Game: 'Spill', VideoGame: 'Spill' }[type] ?? null;
}

function pickAuthor(ld, meta) {
  const ldAuthor = Array.isArray(ld.author) ? ld.author[0] : ld.author;
  if (ldAuthor && (ldAuthor.identifier || ldAuthor.name)) {
    // New-CMS JSON-LD authors carry no `identifier`, but the author url
    // still ends in the legacy id ("…/forfatter/birger-vestmo-18.264").
    const fromUrl = /-(\d+\.\d+)$/.exec(ldAuthor.url ?? '')?.[1] ?? null;
    return {
      id: ldAuthor.identifier ?? fromUrl,
      name: ldAuthor.name ?? null,
      url: ldAuthor.url ?? null,
      email: ldAuthor.email ?? null,
    };
  }
  const ma = meta['article:author'];
  if (ma) return { id: null, name: ma.split('/')[0].trim(), url: null, email: null };
  return null;
}

function pickRating(ld) {
  const rv = ld?.reviewRating?.ratingValue;
  if (rv == null) return null;
  const n = Number(rv);
  return Number.isFinite(n) ? n : null;
}

function splitList(s) {
  if (!s) return null;
  const cleaned = String(s)
    .replace(/\s+og\s+/g, ', ')
    .split(/,\s*/)
    .map((x) => x.trim().replace(/[.;,\s]+$/, ''))
    .filter(Boolean);
  return cleaned.length ? cleaned : null;
}

function parseRuntime(s) {
  if (!s) return null;
  // "1 time og 56 minutter", "100 minutter", "2 timer", "1 t 30 min"
  const t = String(s).toLowerCase();
  let h = 0, mi = 0;
  let m = /(\d+)\s*(?:time|t\b|timer)/.exec(t);
  if (m) h = Number(m[1]);
  m = /(\d+)\s*(?:minutt|min\b|minutter)/.exec(t);
  if (m) mi = Number(m[1]);
  const total = h * 60 + mi;
  return total > 0 ? total : null;
}

function parseDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  // "8. mai 2026" (anywhere in the string, so prefixes like "PÅ KINO 30. april 2025" still parse)
  let m = /(\d{1,2})\.\s*([A-Za-zæøåÆØÅ]+)\s+(\d{4})/.exec(t);
  if (m) {
    const month = NORWEGIAN_MONTHS[m[2].toLowerCase()];
    if (month) {
      return `${m[3]}-${String(month).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    }
  }
  // "08.04.2011" — DD.MM.YYYY
  m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(t);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  // Already-ISO
  m = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return m[0];
  return null;
}

function stripTags(s) { return String(s).replace(/<[^>]+>/g, ''); }

function stripQuotes(s) {
  if (!s) return s ?? null;
  return String(s).replace(/^[«"'\s]+|[»"'\s]+$/g, '').trim() || null;
}

function decodeEntities(s) {
  if (!s) return s ?? '';
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
