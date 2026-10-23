// Renders public/og/home.png, the 1200×630 share image used by every page
// that has no image of its own. One-off: rerun after a design change and
// commit the PNG. Uses system serif/mono fonts, as sharp can't load
// the site's woff2 files.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const W = 1200, H = 630;
const pip = (cx, cy, fill = '#1A1614') => `<circle cx="${cx}" cy="${cy}" r="22" fill="${fill}"/>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#0E0B0A"/>
  <g transform="translate(860 175) rotate(-8 140 140)">
    <rect width="280" height="280" rx="44" fill="#F4EFE6"/>
    ${pip(70, 70, '#D43E2D')}${pip(210, 70)}${pip(70, 140)}${pip(210, 140)}${pip(70, 210)}${pip(210, 210)}
  </g>
  <text x="80" y="150" fill="#D43E2D" font-family="Menlo, monospace" font-size="26" letter-spacing="6">NRK FILMPOLITIET · BIRGER VESTMO</text>
  <text x="76" y="330" fill="#F4EFE6" font-family="Georgia, serif" font-style="italic" font-size="132">Birgerpedia</text>
  <text x="80" y="420" fill="#D9D0BE" font-family="Georgia, serif" font-size="40">Alle anmeldelsene, samlet og søkbare.</text>
</svg>`;

mkdirSync(new URL('../public/og/', import.meta.url), { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(new URL('../public/og/home.png', import.meta.url).pathname);
console.log('wrote public/og/home.png');
