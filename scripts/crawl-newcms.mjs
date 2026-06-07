#!/usr/bin/env node
// Discover new-CMS Filmpolitiet articles and merge Birger's into the
// listing index.
//
// Background: NRK migrated Filmpolitiet to a new CMS in May 2026. The
// legacy author-articles API that crawl-listing.mjs walks is frozen
// (newest item 2026-05-22). New articles publish under
// nrk.no/artikkel/<slug>-NNN and never enter that API. The only places
// that carry the new links are the Filmpolitiet front page and
// https://www.nrk.no/filmpolitiet/toppsaker.rss — neither is filtered
// by author, so we must fetch each candidate article and check the
// schema.org JSON-LD byline ourselves.
//
// What this script does:
//   1. Fetches toppsaker.rss + the front page, collects every
//      /artikkel/ URL (plus legacy-shaped RSS items, in case NRK keeps
//      publishing those without updating the frozen author API).
//   2. Skips URLs already in data/raw/listing/index.json or already
//      checked and found non-Birger (data/raw/listing/newcms-seen.json).
//   3. Fetches the rest. Birger's → raw HTML saved to
//      data/raw/articles/<id>.html and a plug appended to index.json,
//      so crawl-articles.mjs / build-dataset.mjs work unchanged.
//      Everyone else's → recorded in newcms-seen.json, never refetched.
//
// IDs: new-CMS pages expose no 1.NNNNNNNN content id anywhere (the RSS
// guid has one, but the front page doesn't, and the article HTML
// doesn't either). We use the URL slug ("leker-med-sjangerklisjeene-287")
// — deterministic regardless of which source found the article first.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RateLimiter,
  politeFetch,
  atomicWrite,
  atomicWriteJson,
  readJsonIfExists,
  ensureDir,
  idFromUrl,
} from './util.mjs';
import { parseArticle } from './parse-article.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LISTING_DIR = resolve(ROOT, 'data/raw/listing');
const ARTICLES_DIR = resolve(ROOT, 'data/raw/articles');
const INDEX_PATH = resolve(LISTING_DIR, 'index.json');
const SEEN_PATH = resolve(LISTING_DIR, 'newcms-seen.json');

const RSS_URL = 'https://www.nrk.no/filmpolitiet/toppsaker.rss';
const FRONT_URL = 'https://www.nrk.no/filmpolitiet/';
const BIRGER_ID = '18.264';

async function main() {
  await ensureDir(ARTICLES_DIR);
  const limiter = new RateLimiter({ minIntervalMs: 1000 });

  const index = JSON.parse(await readFile(INDEX_PATH, 'utf8'));
  const knownIds = new Set((index.plugs ?? []).map((p) => p.id));
  const knownUrls = new Set((index.plugs ?? []).map((p) => normalizeUrl(p.url)));
  const seen = (await readJsonIfExists(SEEN_PATH)) ?? { urls: {} };

  // ---- gather candidates ----
  console.log(`[newcms] fetching ${RSS_URL}`);
  const rss = await (await politeFetch(RSS_URL, { limiter })).text();
  console.log(`[newcms] fetching ${FRONT_URL}`);
  const front = await (await politeFetch(FRONT_URL, { limiter })).text();

  const candidates = new Map(); // url → { fromRss: item | null }
  for (const item of parseRssItems(rss)) {
    const url = normalizeUrl(item.link);
    if (!url) continue;
    candidates.set(url, { fromRss: item });
  }
  for (const url of front.matchAll(/https:\/\/www\.nrk\.no\/artikkel\/[a-z0-9-]+/g)) {
    const u = normalizeUrl(url[0]);
    if (!candidates.has(u)) candidates.set(u, { fromRss: null });
  }
  console.log(`[newcms] ${candidates.size} candidate URLs from RSS + front page`);

  let added = 0, alreadyKnown = 0, skippedSeen = 0, skippedCreator = 0, notBirger = 0, notFetched = 0;
  const newPlugs = [];

  for (const [url, { fromRss }] of candidates) {
    const id = idForUrl(url);
    if (!id) { notFetched++; continue; }
    if (knownIds.has(id) || knownUrls.has(url)) { alreadyKnown++; continue; }
    if (seen.urls[url]) { skippedSeen++; continue; }
    // RSS sometimes carries an explicit byline (legacy-shaped items do;
    // new-CMS items don't). A non-Birger byline saves us the fetch.
    if (fromRss?.creator && !/birger\s+vestmo/i.test(fromRss.creator)) {
      seen.urls[url] = { at: new Date().toISOString(), author: fromRss.creator, via: 'rss-creator' };
      skippedCreator++;
      continue;
    }

    console.log(`[newcms] fetching candidate ${url}`);
    let html;
    try {
      html = await (await politeFetch(url, { limiter })).text();
    } catch (e) {
      console.warn(`  [err] ${e.message} — will retry next run`);
      notFetched++;
      continue;
    }

    let record = null;
    try { record = parseArticle(html, { url, id }); } catch { /* treated as non-review below */ }
    const author = record?.author ?? authorFromAnyJsonLd(html);
    const isBirger =
      author?.id === BIRGER_ID ||
      /-18\.264$/.test(author?.url ?? '') ||
      /^birger\s+vestmo$/i.test(author?.name ?? '');

    if (!isBirger) {
      seen.urls[url] = { at: new Date().toISOString(), author: author?.name ?? null, via: 'html' };
      notBirger++;
      continue;
    }

    await atomicWrite(resolve(ARTICLES_DIR, `${id}.html`), html);
    newPlugs.push({
      id,
      title: fromRss?.title ?? record?.headline ?? null,
      description: fromRss?.description ?? record?.abstract ?? null,
      url,
      image: null,
      published: record?.publishedAt ?? fromRss?.date ?? null,
      source: 'newcms',
    });
    added++;
    console.log(`  + ${id} (${record ? `review, rating ${record.rating}` : 'article'})`);
  }

  if (newPlugs.length) {
    const plugs = [...newPlugs, ...(index.plugs ?? [])].sort((a, b) =>
      (b.published ?? '').localeCompare(a.published ?? ''),
    );
    await atomicWriteJson(INDEX_PATH, {
      ...index,
      fetchedAt: new Date().toISOString(),
      pluggCount: plugs.length,
      plugs,
    });
  }
  await atomicWriteJson(SEEN_PATH, seen);

  console.log(
    `\n[newcms] done: +${added} Birger article(s), ${alreadyKnown} already known, ` +
    `${skippedSeen}+${skippedCreator} skipped as previously-seen/non-Birger byline, ` +
    `${notBirger} fetched but not Birger, ${notFetched} errors.`,
  );
}

// /artikkel/<slug> → slug; legacy URLs → 1.NNNNNNNN
function idForUrl(url) {
  const m = /\/artikkel\/([a-z0-9-]+)/.exec(url);
  if (m) return m[1];
  return idFromUrl(url);
}

function normalizeUrl(url) {
  if (!url) return null;
  return url.split(/[?#]/)[0].replace(/\/$/, '');
}

function parseRssItems(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = (tag) => {
      const mm = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
      return mm ? decodeXml(mm[1].trim()) : null;
    };
    items.push({
      title: pick('title'),
      link: pick('link'),
      description: pick('description'),
      guid: pick('guid'),
      creator: pick('dc:creator'),
      date: pick('dc:date') ?? pick('pubDate'),
    });
  }
  return items;
}

// Last-resort byline extraction for pages parseArticle rejects (non-review
// articles still carry NewsArticle/Article JSON-LD with an author).
function authorFromAnyJsonLd(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let json;
    try { json = JSON.parse(m[1].trim()); } catch { continue; }
    for (const node of Array.isArray(json) ? json : [json]) {
      const a = Array.isArray(node?.author) ? node.author[0] : node?.author;
      if (a?.name || a?.url) return { id: a.identifier ?? null, name: a.name ?? null, url: a.url ?? null };
    }
  }
  return null;
}

function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
