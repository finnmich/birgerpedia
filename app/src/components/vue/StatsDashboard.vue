<script setup lang="ts">
import { computed, onMounted, ref, h, defineComponent } from 'vue';
import Die from './Die.vue';
import { u } from '../../lib/url';

// Tiny inline avatar helper to keep the template tidy (no separate file).
const PersonAvatar = defineComponent({
  props: {
    name: { type: String, required: true },
    profile: { type: String, default: null },
    size: { type: Number, default: 36 },
  },
  setup(props) {
    return () => {
      const dim = `${props.size}px`;
      const style = { width: dim, height: dim };
      if (props.profile) {
        return h('span', { class: 'pavatar', style }, [
          h('img', { src: props.profile, alt: props.name, loading: 'lazy' }),
        ]);
      }
      const mono = props.name.split(' ').map((s: string) => s[0]).slice(0, 2).join('');
      return h('span', { class: 'pavatar pavatar--mono', style }, [
        h('span', { class: 'mono' }, mono),
      ]);
    };
  },
});

function avgClass(avg: number | null) {
  if (avg == null) return '';
  if (avg >= 4.5) return 'gold';
  if (avg <= 3.5) return 'red';
  return '';
}

interface NamedRow {
  key: string;
  n: number;
  avg: number | null;
  slug?: string;
  profile?: string | null;
}
interface DirectorRow extends NamedRow { slug: string; profile?: string | null; }
interface YearFav {
  year: number; id: string; slug: string; name: string; rating: number; regi: string | null;
}

interface Stats {
  builtAt: string;
  total: number;
  rated: number;
  avg: number;
  yearMin: number; yearMax: number;
  types: { Movie: number; TVSeries: number; Game: number };
  ratingHist: number[];
  reviewsPerYear: { year: number; n: number; rated: number; avg: number | null; byRating: number[] }[];
  decades: { decade: number; n: number; avg: number | null; sixes: number; ones: number }[];
  topDirectors: DirectorRow[];
  topGenres: NamedRow[];
  scatter: { id: string; slug: string; name: string; birger: number; tmdb: number; diff: number }[];
  heatmap: { years: number[]; byRating: number[][] };
  words: { token: string; count: number; avg: number }[];
  perfect6: number;
  worst1: number;
  notRated: number;
  // Round-3 expansions
  topActors: NamedRow[];
  topCinematographers: NamedRow[];
  topComposers: NamedRow[];
  topEditors: NamedRow[];
  topDistributors: NamedRow[];
  topCountries: NamedRow[];
  topLanguages: NamedRow[];
  lovedDirectors: DirectorRow[];
  harshDirectors: DirectorRow[];
  lovedGenres: NamedRow[];
  harshGenres: NamedRow[];
  yearFavorites: YearFav[];
  // External rating scatter datasets (Birger × IMDb / RT / Metacritic)
  scatterImdb: { id: string; slug: string; name: string; birger: number; imdb: number; votes: number | null; diff: number }[];
  scatterRt:   { id: string; slug: string; name: string; birger: number; rt: number; diff: number }[];
  scatterMc:   { id: string; slug: string; name: string; birger: number; mc: number; diff: number }[];
  ratingBuckets: Record<string, { n: number; tmdb: number | null; imdb: number | null; rt: number | null; mc: number | null; tmdbN: number; imdbN: number; rtN: number; mcN: number }>;
  coverage: { imdb: number; rt: number; mc: number };
}

const stats = ref<Stats | null>(null);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    const res = await fetch(u('/data/stats.json'));
    stats.value = await res.json();
  } catch (e: any) { error.value = e.message; }
});

// ---------- chart helpers ----------
const W = 720, H = 220;
function bandPath(data: { x: number; y: number }[], w = W, h = H, padX = 30, padY = 20) {
  if (!data.length) return '';
  const xs = data.map((d) => d.x), ys = data.map((d) => d.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const sx = (x: number) => padX + ((x - xMin) / Math.max(1, xMax - xMin)) * (w - padX * 2);
  const sy = (y: number) => h - padY - ((y - yMin) / Math.max(0.0001, yMax - yMin)) * (h - padY * 2);
  return data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${sx(d.x).toFixed(1)} ${sy(d.y).toFixed(1)}`).join(' ');
}

function pixelOf(year: number, points: { year: number }[]) {
  if (points.length < 2) return 0;
  const xMin = points[0].year, xMax = points.at(-1)!.year;
  return 30 + ((year - xMin) / Math.max(1, xMax - xMin)) * (W - 60);
}

const yearlyPath = computed(() =>
  stats.value ? bandPath(stats.value.reviewsPerYear.map((d) => ({ x: d.year, y: d.n }))) : ''
);
const yearlyAvgPath = computed(() =>
  stats.value ? bandPath(stats.value.reviewsPerYear.filter((d) => d.avg != null).map((d) => ({ x: d.year, y: d.avg! }))) : ''
);
const yearTicks = computed(() => {
  const a = stats.value?.reviewsPerYear ?? [];
  if (!a.length) return [];
  return a.filter((_, i) => i % 3 === 0 || i === a.length - 1);
});
const maxYearlyN = computed(() => Math.max(1, ...(stats.value?.reviewsPerYear.map((d) => d.n) ?? [1])));
const heatmapMax = computed(() => {
  if (!stats.value) return 1;
  let m = 1;
  for (const row of stats.value.heatmap.byRating) for (const v of row) if (v > m) m = v;
  return m;
});

// pip layout
function pipsFor(r: number): { x: number; y: number }[] {
  const layouts: Record<number, [number, number][]> = {
    1: [[.5,.5]], 2: [[.28,.28],[.72,.72]], 3: [[.26,.26],[.5,.5],[.74,.74]],
    4: [[.28,.28],[.72,.28],[.28,.72],[.72,.72]],
    5: [[.27,.27],[.73,.27],[.5,.5],[.27,.73],[.73,.73]],
    6: [[.27,.22],[.73,.22],[.27,.5],[.73,.5],[.27,.78],[.73,.78]],
  };
  return (layouts[r] ?? []).map(([x, y]) => ({ x, y }));
}

// Scatter
const SC_W = 720, SC_H = 380;
const SC_PADL = 36, SC_PADR = 16, SC_PADT = 16, SC_PADB = 30;
function scX(t: number) { return SC_PADL + (t / 10) * (SC_W - SC_PADL - SC_PADR); }
function scY(b: number) { return SC_H - SC_PADB - ((b - 1) / 5) * (SC_H - SC_PADT - SC_PADB); }

const scatterSummary = computed(() => {
  if (!stats.value) return null;
  const xs = stats.value.scatter;
  if (!xs.length) return null;
  const generous = [...xs].sort((a, b) => b.diff - a.diff).slice(0, 5);
  const harsh    = [...xs].sort((a, b) => a.diff - b.diff).slice(0, 5);
  return { n: xs.length, generous, harsh };
});

// Word cloud sizing
const cloudMax = computed(() => Math.max(1, ...(stats.value?.words.map((w) => w.count) ?? [1])));
function wordSize(w: { count: number; avg: number }) {
  const t = Math.sqrt(w.count / cloudMax.value);
  return 0.78 + t * 1.6;
}
function wordColor(w: { count: number; avg: number }) {
  const t = Math.max(0, Math.min(1, (w.avg - 2) / 4));
  if (t < 0.5) {
    const k = t * 2;
    return `color-mix(in srgb, #D43E2D ${(1 - k) * 80}%, #B6AC9D ${k * 80}%)`;
  }
  const k = (t - 0.5) * 2;
  return `color-mix(in srgb, #B6AC9D ${(1 - k) * 80}%, #E8B946 ${k * 90 + 10}%)`;
}

const wordsByRating = computed(() => {
  if (!stats.value) return { high: [], low: [] };
  const arr = stats.value.words;
  return {
    high: [...arr].filter((w) => w.avg >= 4.4).sort((a, b) => b.avg - a.avg).slice(0, 10),
    low:  [...arr].filter((w) => w.avg <= 3.6).sort((a, b) => a.avg - b.avg).slice(0, 10),
  };
});
</script>

<template>
  <div v-if="error" class="empty-state t-meta">Klarte ikke å laste statistikken: {{ error }}</div>
  <div v-else-if="!stats" class="empty-state t-meta">laster statistikken…</div>

  <div v-else class="grid">
    <!-- ============== Headlines ============== -->
    <section class="hero-stats">
      <div class="big">
        <span class="num">{{ stats.total.toLocaleString('nb-NO') }}</span>
        <span class="lab">anmeldelser</span>
      </div>
      <div class="big">
        <span class="num">{{ stats.avg.toFixed(2).replace('.', ',') }}</span>
        <span class="lab">snittkast (av 6)</span>
      </div>
      <div class="big">
        <span class="num">{{ stats.types.Movie }}<span class="sub"> film</span></span>
        <span class="num">{{ stats.types.TVSeries }}<span class="sub"> serier</span></span>
        <span class="num">{{ stats.types.Game }}<span class="sub"> spill</span></span>
      </div>
    </section>

    <!-- ============== Reviews per year ============== -->
    <section class="card">
      <header class="card-head">
        <div class="h-eyebrow">Volum</div>
        <h2 class="card-title">Anmeldelser per år</h2>
      </header>
      <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="chart">
        <defs>
          <linearGradient id="g-vol" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#F4EFE6" stop-opacity="0.45" />
            <stop offset="1" stop-color="#F4EFE6" stop-opacity="0.04" />
          </linearGradient>
        </defs>
        <g v-for="y in [50, 100, 150]" :key="y">
          <line :x1="30" :x2="W - 30" :y1="H - 20 - (y / 160) * (H - 40)" :y2="H - 20 - (y / 160) * (H - 40)"
                stroke="#3A3330" stroke-dasharray="2 4" />
        </g>
        <path :d="`${yearlyPath} L ${W - 30} ${H - 20} L ${30} ${H - 20} Z`" fill="url(#g-vol)" />
        <path :d="yearlyPath" stroke="#F4EFE6" stroke-width="1.6" fill="none" />
        <g v-for="d in stats.reviewsPerYear" :key="d.year">
          <circle :cx="pixelOf(d.year, stats.reviewsPerYear)"
                  :cy="H - 20 - (d.n / 160) * (H - 40)" r="3" fill="#D43E2D" />
        </g>
        <g v-for="t in yearTicks" :key="`t${t.year}`">
          <text :x="pixelOf(t.year, stats.reviewsPerYear)" :y="H - 4"
                font-family="JetBrains Mono" font-size="9"
                text-anchor="middle" fill="#7A6F62">{{ t.year }}</text>
        </g>
      </svg>
      <p class="caption italic">
        Toppåret var {{ stats.reviewsPerYear.reduce((m, d) => d.n > m.n ? d : m, { n: 0, year: 0 }).year }}
        med {{ stats.reviewsPerYear.reduce((m, d) => d.n > m.n ? d : m, { n: 0, year: 0 }).n }} anmeldelser.
      </p>
    </section>

    <!-- ============== Average rating per year ============== -->
    <section class="card">
      <header class="card-head">
        <div class="h-eyebrow">Sinn</div>
        <h2 class="card-title">Snittkast over tid</h2>
      </header>
      <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="chart">
        <g v-for="y in [3, 4, 5]" :key="y">
          <line :x1="30" :x2="W - 30"
                :y1="H - 20 - ((y - 2.5) / 3) * (H - 40)"
                :y2="H - 20 - ((y - 2.5) / 3) * (H - 40)"
                stroke="#3A3330" stroke-dasharray="2 4" />
          <text :x="W - 25" :y="H - 22 - ((y - 2.5) / 3) * (H - 40)"
                font-family="JetBrains Mono" font-size="9" fill="#7A6F62">{{ y }}</text>
        </g>
        <path :d="yearlyAvgPath" stroke="#E8B946" stroke-width="2" fill="none" />
        <g v-for="d in stats.reviewsPerYear.filter((x) => x.avg != null)" :key="`avg${d.year}`">
          <circle :cx="pixelOf(d.year, stats.reviewsPerYear)"
                  :cy="H - 20 - ((d.avg! - 2.5) / 3) * (H - 40)"
                  r="3" fill="#E8B946" />
        </g>
        <g v-for="t in yearTicks" :key="`av-t${t.year}`">
          <text :x="pixelOf(t.year, stats.reviewsPerYear)" :y="H - 4"
                font-family="JetBrains Mono" font-size="9"
                text-anchor="middle" fill="#7A6F62">{{ t.year }}</text>
        </g>
      </svg>
      <p class="caption italic">
        Birgers snitt holder seg tett opp mot fire — han er en balansert anmelder.
      </p>
    </section>

    <!-- ============== Heatmap ============== -->
    <section class="card wide">
      <header class="card-head">
        <div class="h-eyebrow">Detalj</div>
        <h2 class="card-title">Kast per år — varmematrise</h2>
      </header>
      <div class="heatmap" :style="{ '--cols': stats.heatmap.years.length }">
        <div class="hm-row hm-axis">
          <div class="hm-corner"></div>
          <div v-for="y in stats.heatmap.years" :key="`hy${y}`" class="hm-year t-mono">
            <span v-if="(y % 5 === 0)">{{ y }}</span>
          </div>
        </div>
        <div v-for="rt in [6,5,4,3,2,1]" :key="`hr${rt}`" class="hm-row">
          <div class="hm-rt">
            <svg viewBox="0 0 100 100" width="22" height="22">
              <rect x="6" y="6" width="88" height="88" rx="14" fill="#F4EFE6" stroke="#C9BFAB" stroke-width="1.2"/>
              <circle v-for="(p, j) in pipsFor(rt)" :key="j"
                :cx="p.x * 100" :cy="p.y * 100"
                :r="rt === 1 ? 9 : 7.5" fill="#1A1614" />
            </svg>
          </div>
          <a v-for="(yi, i) in stats.heatmap.years" :key="`c${yi}-${rt}`"
             :href="u(`/reviews?r=${rt}&y0=${yi}&y1=${yi}`)"
             class="hm-cell"
             :style="{
               background: `color-mix(in srgb, ${rt >= 5 ? '#E8B946' : rt <= 2 ? '#D43E2D' : '#F4EFE6'}
                            ${Math.round((stats.heatmap.byRating[i][rt - 1] / heatmapMax) * 100)}%, transparent)`
             }"
             :title="`${yi} terningkast ${rt}: ${stats.heatmap.byRating[i][rt - 1]}`"
          />
        </div>
      </div>
    </section>

    <!-- ============== Top directors ============== -->
    <section class="card wide">
      <header class="card-head">
        <div class="h-eyebrow">Skapere</div>
        <h2 class="card-title">Mest anmeldte regissører</h2>
        <p class="card-lede italic">Min. 3 anmeldelser. Gult tall = snitt-terningkast.</p>
      </header>
      <ol class="top-list">
        <li v-for="(d, i) in stats.topDirectors" :key="d.name">
          <span class="t-mono rank">{{ String(i + 1).padStart(2, '0') }}</span>
          <a class="name" :href="u(`/people/${d.slug}`)">{{ d.name }}</a>
          <span class="bar-wrap">
            <span class="bar" :style="{ width: `${(d.n / stats.topDirectors[0].n) * 100}%` }"></span>
          </span>
          <span class="t-mono n">{{ d.n }}</span>
          <span v-if="d.avg != null" class="t-mono avg">{{ d.avg.toFixed(2).replace('.', ',') }}</span>
        </li>
      </ol>
    </section>

    <!-- ============== Histogram by rating ============== -->
    <section class="card wide">
      <header class="card-head">
        <div class="h-eyebrow">Terningen</div>
        <h2 class="card-title">Hele kastfordelingen</h2>
      </header>
      <ol class="rating-bars">
        <li v-for="(n, i) in stats.ratingHist" :key="i" class="rb">
          <Die :value="i + 1" :size="32" />
          <span class="rb-bar-wrap">
            <a class="rb-bar"
               :href="u(`/reviews?r=${i + 1}`)"
               :style="{
                 width: `${(n / Math.max(...stats.ratingHist)) * 100}%`,
                 background: i + 1 === 6 ? '#E8B946' : i + 1 === 1 ? '#D43E2D' : '#F4EFE6'
               }">
              <span class="rb-n t-mono">{{ n.toLocaleString('nb-NO') }}</span>
            </a>
          </span>
          <span class="rb-pct t-mono">{{ Math.round(n / stats.rated * 1000) / 10 }} %</span>
        </li>
      </ol>
    </section>

    <!-- ============== Birger vs TMDB ============== -->
    <section v-if="stats.scatter.length" class="card wide">
      <header class="card-head">
        <div class="h-eyebrow">Verden mot Birger</div>
        <h2 class="card-title">Hva mener Birger som ingen andre mener?</h2>
        <p class="card-lede italic">
          {{ stats.scatter.length.toLocaleString('nb-NO') }} verker plottet mot TMDBs publikumssnitt.
          Diagonalen er der de er enige. Over: Birger er mildere. Under: strengere.
        </p>
      </header>
      <div class="scatter-wrap">
        <svg :viewBox="`0 0 ${SC_W} ${SC_H}`" preserveAspectRatio="none" class="scatter">
          <line :x1="scX(0)" :y1="scY(1)" :x2="scX(10)" :y2="scY(6)"
                stroke="#E8B946" stroke-width="1" stroke-dasharray="3 5" opacity=".7" />
          <g v-for="b in [1,2,3,4,5,6]" :key="`y${b}`">
            <line :x1="SC_PADL" :x2="SC_W - SC_PADR" :y1="scY(b)" :y2="scY(b)"
                  stroke="#3A3330" stroke-dasharray="2 4" opacity=".6" />
            <text :x="SC_PADL - 6" :y="scY(b) + 3" text-anchor="end"
                  font-family="JetBrains Mono" font-size="9" fill="#7A6F62">{{ b }}</text>
          </g>
          <g v-for="t in [0,2,4,6,8,10]" :key="`x${t}`">
            <line :x1="scX(t)" :x2="scX(t)" :y1="SC_PADT" :y2="SC_H - SC_PADB"
                  stroke="#3A3330" stroke-dasharray="2 4" opacity=".5" />
            <text :x="scX(t)" :y="SC_H - 8" text-anchor="middle"
                  font-family="JetBrains Mono" font-size="9" fill="#7A6F62">{{ t }}</text>
          </g>
          <text :x="scX(2)" :y="scY(5) + 4" font-family="JetBrains Mono" font-size="9"
                fill="#7A6F62" letter-spacing="2">BIRGER MILDERE</text>
          <text :x="scX(8)" :y="scY(2) + 4" text-anchor="end" font-family="JetBrains Mono" font-size="9"
                fill="#7A6F62" letter-spacing="2">BIRGER STRENGERE</text>

          <a v-for="p in stats.scatter" :key="p.id" :href="u(`/reviews/${p.slug}`)">
            <circle
              :cx="scX(p.tmdb)" :cy="scY(p.birger)"
              :r="3.5"
              :fill="p.diff > 1.5 ? '#E8B946' : p.diff < -1.5 ? '#D43E2D' : '#F4EFE6'"
              :opacity="0.55"
              class="pt"
            >
              <title>{{ p.name }} — Birger {{ p.birger }}/6, TMDB {{ p.tmdb.toFixed(1).replace('.', ',') }}</title>
            </circle>
          </a>
        </svg>
      </div>

      <div class="scatter-grid" v-if="scatterSummary">
        <div>
          <div class="h-eyebrow">Birger var mildere enn verden</div>
          <ol class="diff-list">
            <li v-for="p in scatterSummary.generous" :key="p.id">
              <a :href="u(`/reviews/${p.slug}`)">
                <span class="dl-die"><Die :value="p.birger" :size="26" :rotate="0" /></span>
                <span class="dl-name">{{ p.name }}</span>
                <span class="t-mono dl-tmdb">vs TMDB {{ p.tmdb.toFixed(1).replace('.', ',') }}</span>
              </a>
            </li>
          </ol>
        </div>
        <div>
          <div class="h-eyebrow">Birger var strengere enn verden</div>
          <ol class="diff-list">
            <li v-for="p in scatterSummary.harsh" :key="p.id">
              <a :href="u(`/reviews/${p.slug}`)">
                <span class="dl-die"><Die :value="p.birger" :size="26" :rotate="0" /></span>
                <span class="dl-name">{{ p.name }}</span>
                <span class="t-mono dl-tmdb">vs TMDB {{ p.tmdb.toFixed(1).replace('.', ',') }}</span>
              </a>
            </li>
          </ol>
        </div>
      </div>
    </section>

    <!-- ============== Headline word analysis ============== -->
    <section v-if="stats.words.length" class="card wide">
      <header class="card-head">
        <div class="h-eyebrow">Birger-isms</div>
        <h2 class="card-title">Hvilke ord lover toppkast?</h2>
        <p class="card-lede italic">
          Ord som dukker opp i ≥ 4 anmeldelser, fargelagt etter snittet i overskriftene de står i.
          Gult = nesten alltid godt. Rødt = sjelden bra. Størrelsen er hyppigheten.
        </p>
      </header>

      <div class="cloud">
        <span v-for="w in stats.words.slice(0, 80)" :key="w.token"
              class="cw"
              :style="{ fontSize: wordSize(w) + 'rem', color: wordColor(w) }"
              :title="`${w.token} — i ${w.count} overskrifter, snitt ${w.avg.toFixed(2).replace('.', ',')}/6`"
        >{{ w.token }}</span>
      </div>

      <div class="cloud-grid">
        <div>
          <div class="h-eyebrow">Lover godt</div>
          <ol class="cl-list">
            <li v-for="w in wordsByRating.high" :key="w.token">
              <span class="cl-word">{{ w.token }}</span>
              <span class="cl-bar" :style="{ '--w': `${(w.avg / 6) * 100}%`, '--c': '#E8B946' }"></span>
              <span class="t-mono cl-num">{{ w.avg.toFixed(2).replace('.', ',') }}</span>
              <span class="t-mono cl-n">{{ w.count }}</span>
            </li>
          </ol>
        </div>
        <div>
          <div class="h-eyebrow">Lover svakt</div>
          <ol class="cl-list">
            <li v-for="w in wordsByRating.low" :key="w.token">
              <span class="cl-word">{{ w.token }}</span>
              <span class="cl-bar" :style="{ '--w': `${(w.avg / 6) * 100}%`, '--c': '#D43E2D' }"></span>
              <span class="t-mono cl-num">{{ w.avg.toFixed(2).replace('.', ',') }}</span>
              <span class="t-mono cl-n">{{ w.count }}</span>
            </li>
          </ol>
        </div>
      </div>
    </section>

    <!-- ============== Decade ledger ============== -->
    <section class="card wide">
      <header class="card-head">
        <div class="h-eyebrow">Tiårsbok</div>
        <h2 class="card-title">Hvert tiår, oppsummert</h2>
      </header>
      <div class="decades">
        <article v-for="d in stats.decades" :key="d.decade" class="dec">
          <div class="dec-num">{{ d.decade }}<span class="apos">'</span><span class="apos-s">s</span></div>
          <div class="dec-stats">
            <div><span class="t-mono dn">{{ d.n.toLocaleString('nb-NO') }}</span><span class="dl">verker</span></div>
            <div><span class="t-mono dn">{{ d.avg ? d.avg.toFixed(2).replace('.', ',') : '—' }}</span><span class="dl">snitt</span></div>
            <div><span class="t-mono dn">{{ d.sixes }}</span><span class="dl">mesterverk</span></div>
            <div><span class="t-mono dn">{{ d.ones }}</span><span class="dl">ettere</span></div>
          </div>
          <a class="dec-link" :href="u(`/reviews?d=${d.decade}`)">Se alle →</a>
        </article>
      </div>
    </section>

    <!-- ============== Loved / Harsh directors ============== -->
    <section v-if="stats.lovedDirectors.length" class="card">
      <header class="card-head">
        <div class="h-eyebrow">Birgers ynglinger</div>
        <h2 class="card-title">Regissører han elsker</h2>
        <p class="card-lede italic">Min. 3 anmeldelser, sortert etter snitt-terningkast.</p>
      </header>
      <ol class="rank-list">
        <li v-for="(p, i) in stats.lovedDirectors.slice(0, 8)" :key="p.key">
          <span class="t-mono rank">{{ String(i + 1).padStart(2, '0') }}</span>
          <PersonAvatar :name="p.key" :profile="p.profile" />
          <a class="rank-name" :href="u(`/people/${p.slug}`)">{{ p.key }}</a>
          <span class="rank-bar"><span :style="{ width: `${((p.avg ?? 0) / 6) * 100}%`, background: 'linear-gradient(90deg, var(--color-paper), var(--color-spark))' }"></span></span>
          <span class="t-mono badge gold">{{ (p.avg ?? 0).toFixed(2).replace('.', ',') }}</span>
          <span class="t-mono n">{{ p.n }}</span>
        </li>
      </ol>
    </section>

    <section v-if="stats.harshDirectors.length" class="card">
      <header class="card-head">
        <div class="h-eyebrow">Birgers strengeste</div>
        <h2 class="card-title">… og hvem han er hardest mot</h2>
        <p class="card-lede italic">Samme regel — min. 3 anmeldelser. Vekt: lavest snitt først.</p>
      </header>
      <ol class="rank-list">
        <li v-for="(p, i) in stats.harshDirectors.slice(0, 8)" :key="p.key">
          <span class="t-mono rank">{{ String(i + 1).padStart(2, '0') }}</span>
          <PersonAvatar :name="p.key" :profile="p.profile" />
          <a class="rank-name" :href="u(`/people/${p.slug}`)">{{ p.key }}</a>
          <span class="rank-bar"><span :style="{ width: `${((p.avg ?? 0) / 6) * 100}%`, background: 'linear-gradient(90deg, var(--color-stamp), color-mix(in srgb, var(--color-stamp) 50%, var(--color-mute)))' }"></span></span>
          <span class="t-mono badge red">{{ (p.avg ?? 0).toFixed(2).replace('.', ',') }}</span>
          <span class="t-mono n">{{ p.n }}</span>
        </li>
      </ol>
    </section>

    <!-- ============== Top actors ============== -->
    <section v-if="stats.topActors.length" class="card wide">
      <header class="card-head">
        <div class="h-eyebrow">På lerretet</div>
        <h2 class="card-title">Mest tilbakevendende skuespillere</h2>
        <p class="card-lede italic">NRKs faktabokser kombinert med TMDBs cast — derfor bredere enn man skulle tro. Min. 4 opptredener.</p>
      </header>
      <ul class="actor-grid">
        <li v-for="p in stats.topActors" :key="p.key">
          <a v-if="p.slug" :href="u(`/people/${p.slug}`)" class="actor-card">
            <PersonAvatar :name="p.key" :profile="p.profile" :size="56" />
            <span class="ac-text">
              <span class="ac-name">{{ p.key }}</span>
              <span class="t-meta">
                {{ p.n }}<span class="muted"> opptr.</span>
                <span v-if="p.avg != null" class="muted"> · </span>
                <span v-if="p.avg != null" class="ac-avg">{{ p.avg.toFixed(2).replace('.', ',') }}</span>
              </span>
            </span>
          </a>
          <div v-else class="actor-card">
            <PersonAvatar :name="p.key" :profile="p.profile" :size="56" />
            <span class="ac-text">
              <span class="ac-name">{{ p.key }}</span>
              <span class="t-meta">
                {{ p.n }}<span class="muted"> opptr.</span>
              </span>
            </span>
          </div>
        </li>
      </ul>
    </section>

    <!-- ============== Crew leaderboards ============== -->
    <section v-if="stats.topCinematographers.length || stats.topComposers.length || stats.topEditors.length" class="card wide">
      <header class="card-head">
        <div class="h-eyebrow">Mannskap</div>
        <h2 class="card-title">Hvem står bak?</h2>
        <p class="card-lede italic">Foto, musikk og klipp — sett fra både NRKs faktaboks og TMDBs hovedmannskap.</p>
      </header>

      <div class="crew-grid">
        <div v-if="stats.topCinematographers.length" class="crew-col">
          <h3 class="h-eyebrow">Foto</h3>
          <ol class="rank-list mini">
            <li v-for="p in stats.topCinematographers.slice(0, 8)" :key="p.key">
              <a :href="u(`/people/${p.slug}`)" v-if="p.slug" class="rank-name">{{ p.key }}</a>
              <span v-else class="rank-name">{{ p.key }}</span>
              <span class="rank-bar"><span :style="{ width: `${((p.avg ?? 0) / 6) * 100}%` }"></span></span>
              <span class="t-mono badge" :class="avgClass(p.avg)">{{ p.avg != null ? p.avg.toFixed(2).replace('.', ',') : '—' }}</span>
              <span class="t-mono n">{{ p.n }}</span>
            </li>
          </ol>
        </div>

        <div v-if="stats.topComposers.length" class="crew-col">
          <h3 class="h-eyebrow">Musikk</h3>
          <ol class="rank-list mini">
            <li v-for="p in stats.topComposers.slice(0, 8)" :key="p.key">
              <a :href="u(`/people/${p.slug}`)" v-if="p.slug" class="rank-name">{{ p.key }}</a>
              <span v-else class="rank-name">{{ p.key }}</span>
              <span class="rank-bar"><span :style="{ width: `${((p.avg ?? 0) / 6) * 100}%` }"></span></span>
              <span class="t-mono badge" :class="avgClass(p.avg)">{{ p.avg != null ? p.avg.toFixed(2).replace('.', ',') : '—' }}</span>
              <span class="t-mono n">{{ p.n }}</span>
            </li>
          </ol>
        </div>

        <div v-if="stats.topEditors.length" class="crew-col">
          <h3 class="h-eyebrow">Klipp</h3>
          <ol class="rank-list mini">
            <li v-for="p in stats.topEditors.slice(0, 8)" :key="p.key">
              <a :href="u(`/people/${p.slug}`)" v-if="p.slug" class="rank-name">{{ p.key }}</a>
              <span v-else class="rank-name">{{ p.key }}</span>
              <span class="rank-bar"><span :style="{ width: `${((p.avg ?? 0) / 6) * 100}%` }"></span></span>
              <span class="t-mono badge" :class="avgClass(p.avg)">{{ p.avg != null ? p.avg.toFixed(2).replace('.', ',') : '—' }}</span>
              <span class="t-mono n">{{ p.n }}</span>
            </li>
          </ol>
        </div>
      </div>
    </section>

    <!-- ============== Genre love/harsh ============== -->
    <section v-if="stats.lovedGenres.length || stats.harshGenres.length" class="card wide">
      <header class="card-head">
        <div class="h-eyebrow">Sjangerprofil</div>
        <h2 class="card-title">Hva slags film liker Birger best?</h2>
        <p class="card-lede italic">Hver sjanger med min. 10 anmeldelser, rangert etter snittkast.</p>
      </header>
      <div class="genre-pair">
        <div>
          <h3 class="h-eyebrow gold">Lover godt</h3>
          <ol class="rank-list mini">
            <li v-for="g in stats.lovedGenres" :key="g.key">
              <a class="rank-name" :href="u(`/reviews?g=${encodeURIComponent(g.key)}`)">{{ g.key }}</a>
              <span class="rank-bar"><span :style="{ width: `${((g.avg ?? 0) / 6) * 100}%`, background: 'linear-gradient(90deg, var(--color-paper), var(--color-spark))' }"></span></span>
              <span class="t-mono badge gold">{{ (g.avg ?? 0).toFixed(2).replace('.', ',') }}</span>
              <span class="t-mono n">{{ g.n }}</span>
            </li>
          </ol>
        </div>
        <div>
          <h3 class="h-eyebrow red">Lover svakt</h3>
          <ol class="rank-list mini">
            <li v-for="g in stats.harshGenres" :key="g.key">
              <a class="rank-name" :href="u(`/reviews?g=${encodeURIComponent(g.key)}`)">{{ g.key }}</a>
              <span class="rank-bar"><span :style="{ width: `${((g.avg ?? 0) / 6) * 100}%`, background: 'linear-gradient(90deg, var(--color-stamp), color-mix(in srgb, var(--color-stamp) 50%, var(--color-mute)))' }"></span></span>
              <span class="t-mono badge red">{{ (g.avg ?? 0).toFixed(2).replace('.', ',') }}</span>
              <span class="t-mono n">{{ g.n }}</span>
            </li>
          </ol>
        </div>
      </div>
    </section>

    <!-- ============== Distributors / Countries / Languages ============== -->
    <section v-if="stats.topDistributors.length || stats.topCountries.length || stats.topLanguages.length" class="card wide">
      <header class="card-head">
        <div class="h-eyebrow">Strømmer & kilder</div>
        <h2 class="card-title">Hvor kommer filmene fra?</h2>
      </header>
      <div class="crew-grid">
        <div v-if="stats.topDistributors.length" class="crew-col">
          <h3 class="h-eyebrow">Distributører</h3>
          <ol class="rank-list mini">
            <li v-for="d in stats.topDistributors.slice(0, 8)" :key="d.key">
              <span class="rank-name">{{ d.key }}</span>
              <span class="rank-bar"><span :style="{ width: `${((d.avg ?? 0) / 6) * 100}%` }"></span></span>
              <span class="t-mono badge" :class="avgClass(d.avg)">{{ d.avg != null ? d.avg.toFixed(2).replace('.', ',') : '—' }}</span>
              <span class="t-mono n">{{ d.n }}</span>
            </li>
          </ol>
        </div>
        <div v-if="stats.topCountries.length" class="crew-col">
          <h3 class="h-eyebrow">Land</h3>
          <ol class="rank-list mini">
            <li v-for="c in stats.topCountries.slice(0, 8)" :key="c.key">
              <span class="rank-name">{{ c.key }}</span>
              <span class="rank-bar"><span :style="{ width: `${((c.avg ?? 0) / 6) * 100}%` }"></span></span>
              <span class="t-mono badge" :class="avgClass(c.avg)">{{ c.avg != null ? c.avg.toFixed(2).replace('.', ',') : '—' }}</span>
              <span class="t-mono n">{{ c.n }}</span>
            </li>
          </ol>
        </div>
        <div v-if="stats.topLanguages.length" class="crew-col">
          <h3 class="h-eyebrow">Språk</h3>
          <ol class="rank-list mini">
            <li v-for="l in stats.topLanguages.slice(0, 8)" :key="l.key">
              <span class="rank-name">{{ l.key }}</span>
              <span class="rank-bar"><span :style="{ width: `${((l.avg ?? 0) / 6) * 100}%` }"></span></span>
              <span class="t-mono badge" :class="avgClass(l.avg)">{{ l.avg != null ? l.avg.toFixed(2).replace('.', ',') : '—' }}</span>
              <span class="t-mono n">{{ l.n }}</span>
            </li>
          </ol>
        </div>
      </div>
    </section>

    <!-- ============== Birger vs the world — cross-source bucket comparison ============== -->
    <section v-if="stats.coverage.imdb || stats.coverage.rt || stats.coverage.mc" class="card wide">
      <header class="card-head">
        <div class="h-eyebrow">På tvers av karakterskalaer</div>
        <h2 class="card-title">Hva sier verden om hvert kast?</h2>
        <p class="card-lede italic">
          For hver terningkast Birger har gitt: hva er gjennomsnittet hos TMDB, IMDb, Rotten Tomatoes og Metacritic?
          <template v-if="stats.coverage.rt === 0 && stats.coverage.mc === 0">
            (RT og Metacritic kommer når OMDb-nøkkelen er på plass.)
          </template>
        </p>
      </header>

      <table class="bucket-table t-mono">
        <thead>
          <tr>
            <th class="b-die">Birger</th>
            <th class="b-n">n</th>
            <th>TMDB <span class="muted">/10</span></th>
            <th>IMDb <span class="muted">/10</span></th>
            <th>RT <span class="muted">%</span></th>
            <th>Metacritic <span class="muted">/100</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="rt in [6,5,4,3,2,1]" :key="rt">
            <td class="b-die">
              <Die :value="rt" :size="36" />
            </td>
            <td class="b-n">{{ stats.ratingBuckets[rt]?.n.toLocaleString('nb-NO') ?? '—' }}</td>
            <td>
              <span v-if="stats.ratingBuckets[rt]?.tmdb != null">
                <span class="b-val">{{ stats.ratingBuckets[rt].tmdb.toFixed(2).replace('.', ',') }}</span>
                <span class="muted t-mono"> ({{ stats.ratingBuckets[rt].tmdbN }})</span>
              </span>
              <span v-else class="muted">—</span>
            </td>
            <td>
              <span v-if="stats.ratingBuckets[rt]?.imdb != null">
                <span class="b-val">{{ stats.ratingBuckets[rt].imdb.toFixed(2).replace('.', ',') }}</span>
                <span class="muted t-mono"> ({{ stats.ratingBuckets[rt].imdbN }})</span>
              </span>
              <span v-else class="muted">—</span>
            </td>
            <td>
              <span v-if="stats.ratingBuckets[rt]?.rt != null">
                <span class="b-val">{{ stats.ratingBuckets[rt].rt }}</span>
                <span class="muted t-mono"> ({{ stats.ratingBuckets[rt].rtN }})</span>
              </span>
              <span v-else class="muted">—</span>
            </td>
            <td>
              <span v-if="stats.ratingBuckets[rt]?.mc != null">
                <span class="b-val">{{ stats.ratingBuckets[rt].mc }}</span>
                <span class="muted t-mono"> ({{ stats.ratingBuckets[rt].mcN }})</span>
              </span>
              <span v-else class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- ============== Birger × IMDb scatter ============== -->
    <section v-if="stats.scatterImdb?.length" class="card wide">
      <header class="card-head">
        <div class="h-eyebrow">IMDb-snittet</div>
        <h2 class="card-title">Birger versus 250 000 IMDb-stemmer</h2>
        <p class="card-lede italic">
          {{ stats.scatterImdb.length.toLocaleString('nb-NO') }} verker krysset med IMDbs publikumssnitt.
          Diagonal = enighet. Gult = Birger er mildere, rødt = strengere.
        </p>
      </header>
      <div class="scatter-wrap">
        <svg :viewBox="`0 0 ${SC_W} ${SC_H}`" preserveAspectRatio="none" class="scatter">
          <line :x1="scX(0)" :y1="scY(1)" :x2="scX(10)" :y2="scY(6)"
                stroke="#E8B946" stroke-width="1" stroke-dasharray="3 5" opacity=".7" />
          <g v-for="b in [1,2,3,4,5,6]" :key="`yi${b}`">
            <line :x1="SC_PADL" :x2="SC_W - SC_PADR" :y1="scY(b)" :y2="scY(b)"
                  stroke="#3A3330" stroke-dasharray="2 4" opacity=".6" />
            <text :x="SC_PADL - 6" :y="scY(b) + 3" text-anchor="end"
                  font-family="JetBrains Mono" font-size="9" fill="#7A6F62">{{ b }}</text>
          </g>
          <g v-for="t in [0,2,4,6,8,10]" :key="`xi${t}`">
            <line :x1="scX(t)" :x2="scX(t)" :y1="SC_PADT" :y2="SC_H - SC_PADB"
                  stroke="#3A3330" stroke-dasharray="2 4" opacity=".5" />
            <text :x="scX(t)" :y="SC_H - 8" text-anchor="middle"
                  font-family="JetBrains Mono" font-size="9" fill="#7A6F62">{{ t }}</text>
          </g>
          <a v-for="p in stats.scatterImdb" :key="p.id" :href="u(`/reviews/${p.slug}`)">
            <circle
              :cx="scX(p.imdb)" :cy="scY(p.birger)"
              :r="3.5"
              :fill="p.diff > 1.5 ? '#E8B946' : p.diff < -1.5 ? '#D43E2D' : '#F4EFE6'"
              :opacity="0.55"
              class="pt"
            >
              <title>{{ p.name }} — Birger {{ p.birger }}/6, IMDb {{ p.imdb.toFixed(1).replace('.', ',') }}</title>
            </circle>
          </a>
        </svg>
      </div>
    </section>

    <!-- ============== Birger × Rotten Tomatoes scatter (only when populated) ============== -->
    <section v-if="stats.scatterRt?.length" class="card wide">
      <header class="card-head">
        <div class="h-eyebrow">Tomatometer</div>
        <h2 class="card-title">Birger versus Rotten Tomatoes</h2>
        <p class="card-lede italic">
          {{ stats.scatterRt.length.toLocaleString('nb-NO') }} verker krysset med RT-tomatometer (kritiker-konsensus).
        </p>
      </header>
      <div class="scatter-wrap">
        <svg :viewBox="`0 0 ${SC_W} ${SC_H}`" preserveAspectRatio="none" class="scatter">
          <line :x1="scX(0)" :y1="scY(1)" :x2="scX(10)" :y2="scY(6)"
                stroke="#E8B946" stroke-width="1" stroke-dasharray="3 5" opacity=".7" />
          <g v-for="b in [1,2,3,4,5,6]" :key="`yr${b}`">
            <line :x1="SC_PADL" :x2="SC_W - SC_PADR" :y1="scY(b)" :y2="scY(b)"
                  stroke="#3A3330" stroke-dasharray="2 4" opacity=".6" />
            <text :x="SC_PADL - 6" :y="scY(b) + 3" text-anchor="end"
                  font-family="JetBrains Mono" font-size="9" fill="#7A6F62">{{ b }}</text>
          </g>
          <g v-for="t in [0,20,40,60,80,100]" :key="`xr${t}`">
            <line :x1="scX(t/10)" :x2="scX(t/10)" :y1="SC_PADT" :y2="SC_H - SC_PADB"
                  stroke="#3A3330" stroke-dasharray="2 4" opacity=".5" />
            <text :x="scX(t/10)" :y="SC_H - 8" text-anchor="middle"
                  font-family="JetBrains Mono" font-size="9" fill="#7A6F62">{{ t }}%</text>
          </g>
          <a v-for="p in stats.scatterRt" :key="p.id" :href="u(`/reviews/${p.slug}`)">
            <circle
              :cx="scX(p.rt/10)" :cy="scY(p.birger)"
              :r="3.5"
              :fill="p.diff > 15 ? '#E8B946' : p.diff < -15 ? '#D43E2D' : '#F4EFE6'"
              :opacity="0.55"
              class="pt"
            >
              <title>{{ p.name }} — Birger {{ p.birger }}/6, RT {{ p.rt }}%</title>
            </circle>
          </a>
        </svg>
      </div>
    </section>

    <!-- ============== Year favourites ============== -->
    <section v-if="stats.yearFavorites.length" class="card wide">
      <header class="card-head">
        <div class="h-eyebrow">Toppen av hvert år</div>
        <h2 class="card-title">Birgers favoritt — år for år</h2>
        <p class="card-lede italic">Den høyest-rangerte anmeldelsen i hvert kalenderår. Klikk for å lese.</p>
      </header>
      <ol class="year-fav-grid">
        <li v-for="y in stats.yearFavorites" :key="y.year">
          <a :href="u(`/reviews/${y.slug}`)" class="yf-card">
            <span class="yf-year h-display">{{ y.year }}</span>
            <Die :value="y.rating" :size="32" :rotate="-3" />
            <span class="yf-text">
              <span class="yf-title">{{ y.name }}</span>
              <span v-if="y.regi" class="t-meta">{{ y.regi }}</span>
            </span>
          </a>
        </li>
      </ol>
    </section>

  </div>
</template>

<style scoped>
/* `.muted` is a colour modifier applied to inline spans throughout the
   dashboard ("opptr.", " · ", "/10", etc.). Keep it inline-only.
   The full-bleed empty-state placeholder gets its own class. */
.muted { color: var(--fg-mute); }
.empty-state { color: var(--fg-mute); padding: 4rem 0; text-align: center; display: block; }

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: clamp(1rem, 2vw, 2rem);
  margin-block: 2rem 6rem;
}
.wide { grid-column: 1 / -1; }

.hero-stats {
  grid-column: 1 / -1;
  display: flex;
  align-items: end;
  gap: clamp(1rem, 4vw, 4rem);
  padding-block: 1.5rem;
  border-block: 1px solid var(--color-line-dark);
  flex-wrap: wrap;
}
.big { display: flex; align-items: baseline; gap: 0.4rem; }
.big .num {
  font-family: var(--font-display);
  font-variation-settings: "opsz" 144, "SOFT" 30, "WONK" 1;
  font-weight: 800;
  font-size: clamp(2rem, 4vw, 3rem);
  letter-spacing: -0.03em;
  line-height: 1;
  color: var(--color-paper);
  font-variant-numeric: tabular-nums;
}
.big .num .sub {
  font-family: var(--font-body);
  font-style: italic;
  font-size: 0.6em;
  color: var(--fg-mute);
  font-weight: 400;
  letter-spacing: 0;
  margin-left: 0.2em;
}
.big .lab {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--fg-mute);
}

.card {
  display: flex; flex-direction: column; gap: 0.8rem;
  padding: 1.4rem 1.5rem 1.6rem;
  border: 1px solid var(--color-line-dark);
  background: var(--color-leader-2);
}
.card-head { display: flex; flex-direction: column; gap: 0.4rem; }
.card-title {
  font-family: var(--font-display);
  font-variation-settings: "opsz" 96, "SOFT" 40, "WONK" 1;
  font-weight: 700;
  font-size: 1.45rem;
  line-height: 1.05;
  letter-spacing: -0.02em;
  margin: 0;
  color: var(--color-paper);
}
.card-lede {
  font-family: var(--font-body);
  font-size: 0.88rem;
  color: var(--fg-mute);
  margin: 0;
}
.caption {
  font-family: var(--font-body);
  font-size: 0.85rem;
  color: var(--fg-mute);
  margin-top: 0.4rem;
}
.chart { width: 100%; height: 220px; display: block; }

/* Heatmap */
.heatmap {
  display: grid;
  grid-template-rows: auto repeat(6, 22px);
  gap: 2px;
}
.hm-row {
  display: grid;
  grid-template-columns: 30px repeat(var(--cols), 1fr);
  gap: 2px;
  align-items: stretch;
}
.hm-axis { height: 18px; }
.hm-corner { width: 30px; }
.hm-year {
  display: flex; align-items: end; justify-content: center;
  font-size: 0.62rem; letter-spacing: 0.04em;
  color: var(--fg-mute); height: 18px;
}
.hm-rt { display: grid; place-items: center; }
.hm-cell {
  height: 22px;
  border: 1px solid rgba(255,255,255,.04);
  transition: outline .1s ease, transform .1s ease;
  display: block;
}
.hm-cell:hover { outline: 1.5px solid var(--color-paper); transform: scale(1.1); z-index: 1; }

/* Top list */
.top-list { list-style: none; margin: 0; padding: 0; }
.top-list li {
  display: grid;
  grid-template-columns: 32px minmax(140px, 1fr) minmax(0, 2fr) auto auto;
  gap: 0.75rem;
  align-items: center;
  padding-block: 0.4rem;
  border-bottom: 1px dashed var(--color-line-dark);
}
.top-list li:last-child { border-bottom: 0; }
.top-list .rank { color: var(--color-stamp); font-size: 0.7rem; }
.top-list .name {
  text-decoration: none;
  color: var(--color-paper);
  border-bottom: 1px dotted transparent;
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 1rem;
  font-variation-settings: "opsz" 96, "SOFT" 30, "WONK" 1;
}
.top-list .name:hover { color: var(--color-spark); border-bottom-color: var(--color-spark); }
.top-list .bar-wrap { height: 6px; background: var(--color-leader-3); position: relative; overflow: hidden; }
.top-list .bar {
  position: absolute; inset: 0 auto 0 0;
  background: linear-gradient(90deg, var(--color-paper), var(--color-spark));
}
.top-list .n { color: var(--fg-mute); font-size: 0.78rem; min-width: 24px; text-align: right; }
.top-list .avg {
  background: color-mix(in srgb, var(--color-spark) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-spark) 50%, transparent);
  padding: 0.2rem 0.45rem;
  font-size: 0.72rem;
  color: var(--color-spark);
}

/* Rating bars */
.rating-bars { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.7rem; }
.rb { display: grid; grid-template-columns: 40px 1fr 60px; gap: 0.8rem; align-items: center; }
.rb-bar-wrap {
  background: var(--color-leader-3);
  height: 28px;
  position: relative;
  overflow: hidden;
}
.rb-bar {
  display: flex; align-items: center; justify-content: flex-end;
  padding-right: 0.7rem;
  height: 100%;
  background: var(--color-paper);
  color: var(--color-leader);
  text-decoration: none;
  transition: width 1s var(--ease-paper), filter .15s ease;
}
.rb-bar:hover { filter: brightness(1.08); }
.rb-n { font-size: 0.78rem; letter-spacing: 0.06em; font-weight: 600; }
.rb-pct { color: var(--fg-mute); font-size: 0.78rem; text-align: right; }

/* Scatter */
.scatter-wrap { position: relative; }
.scatter { width: 100%; height: 380px; display: block; }
.scatter .pt { cursor: pointer; transition: r .15s ease, opacity .15s ease; }
.scatter a:hover .pt { r: 6; opacity: 1; }

.scatter-grid {
  margin-top: 1.4rem;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2rem;
  border-top: 1px solid var(--color-line-dark);
  padding-top: 1.2rem;
}
.diff-list { list-style: none; margin: 0.6rem 0 0; padding: 0; display: flex; flex-direction: column; }
.diff-list li { border-bottom: 1px dashed var(--color-line-dark); }
.diff-list li:last-child { border-bottom: 0; }
.diff-list a {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 0.7rem;
  align-items: center;
  padding-block: 0.45rem;
  text-decoration: none;
  color: inherit;
  transition: color .2s ease;
}
.diff-list a:hover { color: var(--color-spark); }
.dl-die { display: grid; place-items: center; }
.dl-name {
  font-family: var(--font-display);
  font-variation-settings: "opsz" 96, "SOFT" 30, "WONK" 1;
  font-weight: 600;
  font-size: 0.95rem;
  line-height: 1.1;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dl-tmdb { color: var(--fg-mute); font-size: 0.7rem; }

/* Word cloud */
.cloud {
  display: flex; flex-wrap: wrap; gap: 0.4rem 0.7rem;
  align-items: baseline; justify-content: center;
  padding: 1.4rem 0.4rem;
  line-height: 1.1;
}
.cw {
  font-family: var(--font-display);
  font-variation-settings: "opsz" 96, "SOFT" 60, "WONK" 1;
  font-weight: 600;
  font-style: italic;
  letter-spacing: -0.01em;
  cursor: default;
  transition: transform .25s ease;
}
.cw:hover { transform: translateY(-1px) scale(1.04); }

.cloud-grid {
  margin-top: 1.4rem;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2rem;
  border-top: 1px solid var(--color-line-dark);
  padding-top: 1.2rem;
}
.cl-list { list-style: none; margin: 0.6rem 0 0; padding: 0; }
.cl-list li {
  display: grid;
  grid-template-columns: minmax(110px, 1.2fr) minmax(0, 2fr) auto auto;
  gap: 0.7rem;
  align-items: center;
  padding-block: 0.4rem;
  border-bottom: 1px dashed var(--color-line-dark);
}
.cl-list li:last-child { border-bottom: 0; }
.cl-word {
  font-family: var(--font-display);
  font-variation-settings: "opsz" 96, "SOFT" 30, "WONK" 1;
  font-style: italic;
  font-weight: 600;
  font-size: 1rem;
  letter-spacing: -0.01em;
}
.cl-bar {
  display: block;
  height: 5px;
  background: linear-gradient(to right, var(--c) calc(var(--w)), var(--color-leader-3) calc(var(--w)));
}
.cl-num {
  font-size: 0.72rem;
  background: color-mix(in srgb, var(--color-paper) 5%, transparent);
  border: 1px solid var(--color-line-dark);
  padding: 0.16rem 0.4rem;
  text-align: center;
  min-width: 38px;
}
.cl-n { color: var(--fg-mute); font-size: 0.7rem; min-width: 24px; text-align: right; }

/* Decades */
.decades {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 1rem;
}
.dec {
  display: flex; flex-direction: column; gap: 0.8rem;
  padding: 1rem 1.1rem;
  border: 1px solid var(--color-line-dark);
  background: var(--color-leader-3);
}
.dec-num {
  font-family: var(--font-display);
  font-variation-settings: "opsz" 144, "SOFT" 30, "WONK" 1;
  font-weight: 800;
  font-size: 2.4rem;
  letter-spacing: -0.04em;
  line-height: 0.9;
  color: var(--color-paper);
}
.dec-num .apos { color: var(--color-stamp); font-style: italic; }
.dec-num .apos-s { font-size: 0.6em; font-style: italic; color: var(--fg-mute); }
.dec-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem 0.8rem; }
.dec-stats > div { display: flex; flex-direction: column; gap: 0.05rem; }
.dec-stats .dn { font-size: 1.05rem; color: var(--color-paper); font-variant-numeric: tabular-nums; }
.dec-stats .dl {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fg-mute);
}
.dec-link {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--fg-mute);
  text-decoration: none;
  align-self: flex-start;
}
.dec-link:hover { color: var(--color-stamp); }

/* ----- Bucket comparison table ----- */
.bucket-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.bucket-table th, .bucket-table td {
  text-align: left;
  padding: 0.6rem 0.7rem;
  border-bottom: 1px dashed var(--color-line-dark);
}
.bucket-table thead th {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--fg-mute);
  border-bottom: 1px solid var(--color-line-dark);
}
.bucket-table .b-die { width: 56px; padding-block: 0.3rem; }
.bucket-table .b-n {
  width: 50px;
  color: var(--fg-mute);
  font-variant-numeric: tabular-nums;
}
.bucket-table .b-val {
  color: var(--color-paper);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.bucket-table .muted { color: var(--fg-mute); }
.bucket-table th .muted { font-weight: 400; letter-spacing: 0.04em; text-transform: none; font-size: 0.6rem; }
.bucket-table tbody tr:hover {
  background: color-mix(in srgb, var(--color-paper) 3%, transparent);
}

@media (max-width: 700px) {
  .bucket-table { font-size: 0.78rem; }
  .bucket-table th, .bucket-table td { padding: 0.4rem 0.4rem; }
  .bucket-table .b-die { width: 40px; }
}

/* ----- Person avatar ----- */
.pavatar {
  display: grid;
  place-items: center;
  border-radius: 999px;
  overflow: hidden;
  background: var(--color-leader-3);
  border: 1px solid var(--color-line-dark);
  flex-shrink: 0;
}
.pavatar img {
  width: 100%; height: 100%; object-fit: cover;
  filter: grayscale(.15) contrast(1.05);
  transition: filter .25s ease;
}
.pavatar:hover img { filter: grayscale(0) contrast(1.1); }
.pavatar--mono .mono {
  font-family: var(--font-display);
  font-variation-settings: "opsz" 96, "SOFT" 30, "WONK" 1;
  font-weight: 700;
  font-size: 0.78rem;
  color: var(--fg-mute);
}

/* ----- Generic rank lists (loved/harsh, crew, distributors, etc.) ----- */
.rank-list { list-style: none; margin: 0.6rem 0 0; padding: 0; }
.rank-list li {
  display: grid;
  grid-template-columns: 28px auto minmax(120px, 1fr) minmax(60px, 1.4fr) auto auto;
  gap: 0.7rem;
  align-items: center;
  padding-block: 0.5rem;
  border-bottom: 1px dashed var(--color-line-dark);
}
.rank-list li:last-child { border-bottom: 0; }
.rank-list.mini li {
  grid-template-columns: minmax(100px, 1fr) minmax(60px, 1.5fr) auto auto;
  padding-block: 0.42rem;
}
.rank-list .rank { color: var(--color-stamp); font-size: 0.7rem; }
.rank-list .rank-name {
  font-family: var(--font-display);
  font-variation-settings: "opsz" 96, "SOFT" 30, "WONK" 1;
  font-weight: 600;
  font-size: 0.95rem;
  letter-spacing: -0.012em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-decoration: none;
  color: var(--color-paper);
  border-bottom: 1px dotted transparent;
  transition: color .2s ease, border-color .2s ease;
}
a.rank-name:hover { color: var(--color-spark); border-bottom-color: var(--color-spark); }
.rank-list .rank-bar {
  display: block;
  height: 5px;
  background: var(--color-leader-3);
  position: relative;
  overflow: hidden;
}
.rank-list .rank-bar > span {
  position: absolute; inset: 0 auto 0 0;
  background: linear-gradient(90deg, var(--color-paper), var(--color-paper-3));
}
.rank-list .badge {
  font-size: 0.72rem;
  padding: 0.18rem 0.42rem;
  text-align: center;
  min-width: 40px;
  border: 1px solid var(--color-line-dark);
}
.rank-list .badge.gold {
  background: color-mix(in srgb, var(--color-spark) 15%, transparent);
  border-color: color-mix(in srgb, var(--color-spark) 50%, transparent);
  color: var(--color-spark);
}
.rank-list .badge.red {
  background: color-mix(in srgb, var(--color-stamp) 12%, transparent);
  border-color: color-mix(in srgb, var(--color-stamp) 50%, transparent);
  color: var(--color-stamp);
}
.rank-list .n { color: var(--fg-mute); font-size: 0.72rem; min-width: 24px; text-align: right; }

.h-eyebrow.gold { color: var(--color-spark); }
.h-eyebrow.red { color: var(--color-stamp); }

/* ----- Actor grid ----- */
.actor-grid {
  list-style: none; margin: 0.7rem 0 0; padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0.6rem;
}
.actor-card {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.55rem 0.7rem;
  background: var(--color-leader-3);
  border: 1px solid var(--color-line-dark);
  text-decoration: none;
  color: inherit;
  transition: border-color .2s ease, transform .25s var(--ease-paper);
  min-width: 0;
}
a.actor-card:hover { border-color: var(--color-paper); transform: translateY(-2px); }
a.actor-card:hover .ac-name { color: var(--color-spark); }
.ac-text { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.ac-name {
  font-family: var(--font-display);
  font-variation-settings: "opsz" 96, "SOFT" 30, "WONK" 1;
  font-weight: 600;
  font-size: 0.95rem;
  letter-spacing: -0.01em;
  line-height: 1.05;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--color-paper);
  transition: color .2s ease;
}
.ac-text .t-meta {
  font-size: 0.7rem;
  color: var(--color-paper-2);
}
.ac-text .muted { color: var(--fg-mute); }
.ac-avg { color: var(--color-spark); font-weight: 600; }

/* ----- Crew grid (foto / musikk / klipp), distributors / countries / languages ----- */
.crew-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: clamp(1rem, 2vw, 2rem);
}
.crew-col h3 { margin: 0 0 0.4rem; }

/* ----- Genre pair ----- */
.genre-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2rem;
}

/* ----- Year favourites ----- */
.year-fav-grid {
  list-style: none; margin: 0.5rem 0 0; padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0.6rem;
}
.yf-card {
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: 0.6rem 0.7rem;
  align-items: center;
  padding: 0.7rem 0.85rem;
  text-decoration: none;
  color: inherit;
  background: var(--color-leader-3);
  border: 1px solid var(--color-line-dark);
  transition: border-color .2s ease, transform .25s var(--ease-paper);
  min-width: 0;
}
a.yf-card:hover { border-color: var(--color-paper); transform: translateY(-2px); }
a.yf-card:hover .yf-title { color: var(--color-spark); }
.yf-year {
  font-size: 1.5rem;
  letter-spacing: -0.04em;
  line-height: 1;
  color: var(--color-stamp);
  font-variation-settings: "opsz" 144, "SOFT" 30, "WONK" 1;
  font-weight: 800;
  margin: 0;
}
.yf-text { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
.yf-title {
  font-family: var(--font-display);
  font-variation-settings: "opsz" 96, "SOFT" 40, "WONK" 1;
  font-weight: 700;
  font-size: 1rem;
  line-height: 1.05;
  letter-spacing: -0.014em;
  color: var(--color-paper);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color .2s ease;
}
.yf-text .t-meta {
  font-size: 0.7rem;
  color: var(--fg-mute);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (max-width: 880px) {
  .grid { grid-template-columns: 1fr; }
  .top-list li { grid-template-columns: 28px minmax(100px, 1fr) auto auto auto; }
  .top-list .bar-wrap { display: none; }
  .scatter-grid, .cloud-grid { grid-template-columns: 1fr; gap: 1rem; }
  .rank-list li { grid-template-columns: 22px auto minmax(0, 1fr) minmax(40px, .8fr) auto auto; gap: 0.5rem; }
  .crew-grid { grid-template-columns: 1fr; gap: 1.5rem; }
  .genre-pair { grid-template-columns: 1fr; gap: 1.5rem; }
}
</style>
