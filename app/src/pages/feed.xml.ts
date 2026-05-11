// RSS feed of the 50 most recent reviews.
import type { APIRoute } from 'astro';
import { reviewIndex } from '../lib/data';
import { sanitizeQuotes } from '../lib/format';

const SITE = 'https://birgerpedia.local';

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const GET: APIRoute = () => {
  const items = reviewIndex.slice(0, 50);
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Birgerpedia — siste anmeldelser</title>
    <link>${SITE}/</link>
    <atom:link href="${SITE}/feed.xml" rel="self" type="application/rss+xml" />
    <description>De ferskeste terningkastene fra Birger Vestmo, indeksert.</description>
    <language>nb-NO</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${items.map((r) => `
    <item>
      <title>${escape(sanitizeQuotes(r.name))} — terningkast ${r.rating ?? '—'}</title>
      <link>${SITE}/reviews/${r.slug}</link>
      <guid isPermaLink="true">${SITE}/reviews/${r.slug}</guid>
      <pubDate>${r.publishedAt ? new Date(r.publishedAt).toUTCString() : ''}</pubDate>
      <dc:creator>Birger Vestmo</dc:creator>
      ${r.headline ? `<description>«${escape(sanitizeQuotes(r.headline))}»${r.factbox?.regi ? ` — av ${escape(r.factbox.regi)}` : ''}</description>` : ''}
    </item>`).join('')}
  </channel>
</rss>`;
  return new Response(rss, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
