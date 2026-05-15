<script setup lang="ts">
import { computed, ref, onMounted, watch, nextTick } from 'vue';
import MiniSearch from 'minisearch';
import Die from './Die.vue';
import { u } from '../../lib/url';

interface Review {
  id: string; url: string; type: string; name: string;
  originalTitle: string | null; headline: string | null;
  rating: number | null; publishedAt: string | null;
  image: string | null; platform: string | null;
  factbox: any;
  year: number; decade: number; slug: string;
}

const reviews = ref<Review[]>([]);
const loaded = ref(false);

// ---- filter state, URL-encoded ----
const q = ref('');
const ratings = ref<Set<number>>(new Set());
const types = ref<Set<string>>(new Set());
const genres = ref<Set<string>>(new Set());
const platforms = ref<Set<string>>(new Set());
const decades = ref<Set<number>>(new Set());
const yearMin = ref<number | null>(null);
const yearMax = ref<number | null>(null);
const sort = ref<'newest' | 'oldest' | 'rating-high' | 'rating-low' | 'a-z' | 'z-a'>('newest');
const view = ref<'list' | 'grid'>('list');
const expandGenres = ref(false);
const limit = ref(60);

const searchInput = ref<HTMLInputElement | null>(null);

// Pre-built MiniSearch index
let mini: MiniSearch | null = null;

onMounted(async () => {
  const res = await fetch(u('/data/reviews.json'));
  const raw: any[] = await res.json();
  reviews.value = raw.map((r) => {
    const year = Number(r.publishedAt?.slice(0, 4)) || 0;
    return {
      ...r,
      year,
      decade: year ? Math.floor(year / 10) * 10 : 0,
      slug: r.slug ?? slugify(r.name, r.id),
    };
  });
  buildSearch();
  loaded.value = true;
  hydrateFromUrl();
  installShortcuts();
});

watch(
  [q, ratings, types, genres, platforms, decades, yearMin, yearMax, sort, view],
  () => { syncToUrl(); limit.value = 60; },
  { deep: true },
);

function slugify(name: string, id: string) {
  const tail = (id ?? '').split('.').pop() ?? '';
  const s = (name ?? '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `${s || 'review'}-${tail}`;
}

function buildSearch() {
  mini = new MiniSearch({
    fields: ['name', 'originalTitle', 'headline', 'regi', 'skuespillere', 'sjanger'],
    storeFields: ['id'],
    searchOptions: {
      combineWith: 'AND',
      fuzzy: 0.15,
      prefix: true,
      boost: { name: 3, originalTitle: 2, headline: 1.3 },
    },
    extractField: (doc, field) => {
      if (field === 'regi') return doc.factbox?.regi ?? doc.factbox?.serieskaper ?? '';
      if (field === 'skuespillere') return (doc.factbox?.skuespillere ?? []).join(' ');
      if (field === 'sjanger') return (doc.factbox?.sjanger ?? []).join(' ');
      return (doc as any)[field] ?? '';
    },
  });
  mini.addAll(reviews.value);
}

const allGenres = computed(() => {
  const m = new Map<string, number>();
  for (const r of reviews.value)
    for (const g of r.factbox?.sjanger ?? []) {
      const k = g.toLowerCase();
      m.set(k, (m.get(k) ?? 0) + 1);
    }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n }));
});

const allPlatforms = computed(() => {
  const m = new Map<string, number>();
  for (const r of reviews.value) {
    const b = bucket(r.platform);
    m.set(b, (m.get(b) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n }));
});

function bucket(p: string | null): string {
  if (!p) return 'ukjent';
  const s = p.toLowerCase();
  if (/(kino|premiere|på kino)/.test(s)) return 'kino';
  if (/netflix/.test(s)) return 'netflix';
  if (/disney/.test(s)) return 'disney+';
  if (/(hbo|max)/.test(s)) return 'hbo';
  if (/(prime|amazon)/.test(s)) return 'prime';
  if (/apple/.test(s)) return 'apple tv+';
  if (/viaplay/.test(s)) return 'viaplay';
  if (/(ukjent|ikke|uvisst|ennå|festival)/.test(s)) return 'ukjent';
  return 'distribusjon';
}

const yearBounds = computed(() => {
  const years = reviews.value.map((r) => r.year).filter(Boolean);
  return { min: Math.min(...years, 2007), max: Math.max(...years, 2026) };
});

const allDecades = computed(() => {
  const m = new Map<number, number>();
  for (const r of reviews.value) if (r.decade) m.set(r.decade, (m.get(r.decade) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => ({ k, n }));
});

// ---- Filter pipeline ----
const matchedIds = computed<Set<string> | null>(() => {
  if (!loaded.value || !q.value.trim() || !mini) return null;
  return new Set(mini.search(q.value).map((h) => h.id));
});

const filtered = computed<Review[]>(() => {
  if (!loaded.value) return [];
  let pool = reviews.value;

  if (matchedIds.value) {
    const m = matchedIds.value;
    pool = pool.filter((r) => m.has(r.id));
  }

  if (ratings.value.size) pool = pool.filter((r) => r.rating != null && ratings.value.has(r.rating));
  if (types.value.size)   pool = pool.filter((r) => types.value.has(r.type));
  if (genres.value.size)  pool = pool.filter((r) => (r.factbox?.sjanger ?? []).some((g: string) => genres.value.has(g.toLowerCase())));
  if (platforms.value.size) pool = pool.filter((r) => platforms.value.has(bucket(r.platform)));
  if (decades.value.size) pool = pool.filter((r) => decades.value.has(r.decade));
  if (yearMin.value != null) pool = pool.filter((r) => r.year >= yearMin.value!);
  if (yearMax.value != null) pool = pool.filter((r) => r.year <= yearMax.value!);

  switch (sort.value) {
    case 'newest':       pool = [...pool].sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')); break;
    case 'oldest':       pool = [...pool].sort((a, b) => (a.publishedAt ?? '').localeCompare(b.publishedAt ?? '')); break;
    case 'rating-high':  pool = [...pool].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')); break;
    case 'rating-low':   pool = [...pool].sort((a, b) => (a.rating ?? 99) - (b.rating ?? 99) || (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')); break;
    case 'a-z':          pool = [...pool].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'nb-NO')); break;
    case 'z-a':          pool = [...pool].sort((a, b) => (b.name ?? '').localeCompare(a.name ?? '', 'nb-NO')); break;
  }

  return pool;
});

const visible = computed(() => filtered.value.slice(0, limit.value));

const activeCount = computed(() =>
  ratings.value.size +
  types.value.size +
  genres.value.size +
  platforms.value.size +
  decades.value.size +
  (q.value.trim() ? 1 : 0) +
  (yearMin.value != null ? 1 : 0) +
  (yearMax.value != null ? 1 : 0)
);

// ---- Filter mutations (separate handlers — refs auto-unwrap in templates,
// so a single generic toggle(refObject, ...) doesn't work) ----
function toggleSet<T>(s: Set<T>, v: T): Set<T> {
  const out = new Set(s);
  if (out.has(v)) out.delete(v); else out.add(v);
  return out;
}
function toggleRating(n: number) { ratings.value = toggleSet(ratings.value, n); }
function toggleType(t: string)   { types.value   = toggleSet(types.value, t); }
function toggleGenre(g: string)  { genres.value  = toggleSet(genres.value, g); }
function togglePlatform(p: string) { platforms.value = toggleSet(platforms.value, p); }
function toggleDecade(d: number) { decades.value = toggleSet(decades.value, d); }

function clearAll() {
  q.value = '';
  ratings.value = new Set();
  types.value = new Set();
  genres.value = new Set();
  platforms.value = new Set();
  decades.value = new Set();
  yearMin.value = null;
  yearMax.value = null;
  sort.value = 'newest';
}

// ---- Result highlighting ----
const queryTokens = computed(() => {
  if (!q.value.trim()) return [];
  return [...new Set(
    q.value
      .toLowerCase()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .split(/[\s,]+/)
      .filter((t) => t.length >= 2)
  )];
});

function highlight(text: string | null | undefined): string {
  if (!text) return '';
  const t = String(text);
  if (!queryTokens.value.length) return escapeHtml(t);
  const escaped = escapeHtml(t);
  const re = new RegExp(`(${queryTokens.value.map(reEscape).join('|')})`, 'giu');
  return escaped.replace(re, '<mark>$1</mark>');
}

function reEscape(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---- Keyboard shortcuts ----
function installShortcuts() {
  if (typeof window === 'undefined') return;
  window.addEventListener('keydown', (e) => {
    // Ignore if typing in a field
    const target = e.target as HTMLElement;
    if (target?.matches?.('input, textarea, select') && e.key !== 'Escape') return;

    if (e.key === '/' || e.key === 's') {
      e.preventDefault();
      searchInput.value?.focus();
      searchInput.value?.select();
    } else if (e.key === 'Escape' && target === searchInput.value) {
      q.value = '';
      target.blur();
    } else if (e.key === 'r' && !e.ctrlKey && !e.metaKey) {
      // Random review
      const visibleResults = filtered.value;
      if (visibleResults.length) {
        const pick = visibleResults[Math.floor(Math.random() * visibleResults.length)];
        location.href = u(`/reviews/${pick.slug}`);
      }
    } else if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
      // Allow normal copy
      return;
    } else if (e.key === 'Escape') {
      clearAll();
    }
  });
}

// ---- URL ↔ state ----
function syncToUrl() {
  if (!loaded.value) return;
  const p = new URLSearchParams();
  if (q.value)            p.set('q', q.value);
  if (ratings.value.size) p.set('r', [...ratings.value].sort().join(','));
  if (types.value.size)   p.set('t', [...types.value].join(','));
  if (genres.value.size)  p.set('g', [...genres.value].join(','));
  if (platforms.value.size) p.set('p', [...platforms.value].join(','));
  if (decades.value.size) p.set('d', [...decades.value].sort().join(','));
  if (yearMin.value != null) p.set('y0', String(yearMin.value));
  if (yearMax.value != null) p.set('y1', String(yearMax.value));
  if (sort.value !== 'newest') p.set('s', sort.value);
  if (view.value !== 'list') p.set('v', view.value);
  const qs = p.toString();
  const url = qs ? `${location.pathname}?${qs}` : location.pathname;
  history.replaceState(null, '', url);
}

function hydrateFromUrl() {
  const p = new URLSearchParams(location.search);
  q.value = p.get('q') ?? '';
  ratings.value = new Set((p.get('r') ?? '').split(',').filter(Boolean).map(Number));
  types.value   = new Set((p.get('t') ?? '').split(',').filter(Boolean));
  genres.value  = new Set((p.get('g') ?? '').split(',').filter(Boolean));
  platforms.value = new Set((p.get('p') ?? '').split(',').filter(Boolean));
  decades.value = new Set((p.get('d') ?? '').split(',').filter(Boolean).map(Number));
  const y0 = p.get('y0'); const y1 = p.get('y1');
  yearMin.value = y0 ? Number(y0) : null;
  yearMax.value = y1 ? Number(y1) : null;
  sort.value = (p.get('s') as any) ?? 'newest';

  // View-mode persistence: URL wins if set, else last-seen localStorage
  // value, else 'list'. This way switching to grid sticks across pages.
  const urlV = p.get('v') as 'list' | 'grid' | null;
  const lsV = (typeof localStorage !== 'undefined' ? localStorage.getItem('vmx.view') : null) as 'list' | 'grid' | null;
  view.value = urlV ?? lsV ?? 'list';
  watch(view, (v) => { try { localStorage.setItem('vmx.view', v); } catch {} });
}

// ---- Active filter chips: a flat list of {label, kind, value} for
// rendering removable pills above the result list.
interface ActiveChip { kind: string; label: string; remove: () => void; }
const activeChips = computed<ActiveChip[]>(() => {
  const out: ActiveChip[] = [];
  if (q.value) out.push({ kind: 'q', label: `«${q.value}»`, remove: () => { q.value = ''; } });
  for (const n of ratings.value) out.push({ kind: 'rating', label: `terningkast ${n}`, remove: () => toggleRating(n) });
  for (const t of types.value) out.push({ kind: 'type', label: t === 'Movie' ? 'film' : t === 'TVSeries' ? 'serie' : 'spill', remove: () => toggleType(t) });
  for (const d of decades.value) out.push({ kind: 'decade', label: `${d}-tallet`, remove: () => toggleDecade(d) });
  for (const g of genres.value) out.push({ kind: 'genre', label: g, remove: () => toggleGenre(g) });
  for (const p of platforms.value) out.push({ kind: 'platform', label: p, remove: () => togglePlatform(p) });
  if (yearMin.value != null) out.push({ kind: 'year', label: `≥ ${yearMin.value}`, remove: () => { yearMin.value = null; } });
  if (yearMax.value != null) out.push({ kind: 'year', label: `≤ ${yearMax.value}`, remove: () => { yearMax.value = null; } });
  return out;
});

// ---- Mobile filter drawer ----
const showFilters = ref(false);
function toggleFilters() { showFilters.value = !showFilters.value; }
</script>

<template>
  <div class="layout" :class="{ 'filters-open': showFilters }">
    <!-- mobile filter toggle -->
    <button class="mobile-filter-btn" type="button" @click="toggleFilters" :aria-expanded="showFilters">
      <span>Filtre</span>
      <span v-if="activeCount" class="mfb-count">{{ activeCount }}</span>
      <span class="mfb-icon" aria-hidden="true">{{ showFilters ? '×' : '☰' }}</span>
    </button>

    <!-- ============= sidebar / filters ============= -->
    <aside class="filters">
      <div class="search">
        <label class="h-eyebrow row-between" for="q">
          <span>Søk</span>
          <kbd class="kbd">/</kbd>
        </label>
        <div class="search-box">
          <input
            id="q"
            ref="searchInput"
            v-model="q"
            class="field"
            type="search"
            placeholder="tittel, regissør, skuespiller, sjanger…"
            autocomplete="off"
            spellcheck="false"
          />
          <button v-if="q" class="clear" type="button" @click="q = ''" aria-label="Tøm søk">×</button>
        </div>
      </div>

      <section>
        <div class="h-eyebrow">Terningkast</div>
        <div class="dice-row">
          <button v-for="n in 6" :key="n" type="button"
            class="die-pill" :aria-pressed="ratings.has(n)"
            @click="toggleRating(n)">
            <Die :value="n" :size="34" :rotate="0" variant="paper" />
            <span class="t-meta">{{ reviews.filter(r => r.rating === n).length.toLocaleString('nb-NO') }}</span>
          </button>
        </div>
      </section>

      <section>
        <div class="h-eyebrow">Type</div>
        <div class="chip-row">
          <button v-for="t in [['Movie','filmer'],['TVSeries','serier'],['Game','spill']]" :key="t[0]"
            type="button" class="chip" :aria-pressed="types.has(t[0])"
            @click="toggleType(t[0])">{{ t[1] }}</button>
        </div>
      </section>

      <section>
        <div class="h-eyebrow">Tiår</div>
        <div class="chip-row">
          <button v-for="d in allDecades" :key="d.k" type="button"
            class="chip chip-decade" :aria-pressed="decades.has(d.k)"
            @click="toggleDecade(d.k)">
            <span class="dec-num">{{ d.k }}–</span>
            <span class="n">{{ d.n }}</span>
          </button>
        </div>
      </section>

      <section>
        <div class="h-eyebrow">År</div>
        <div class="year-range">
          <input
            type="range" :min="yearBounds.min" :max="yearBounds.max"
            :value="yearMin ?? yearBounds.min"
            @input="(e: any) => yearMin = +e.target.value === yearBounds.min ? null : +e.target.value"
            aria-label="Fra år"
          />
          <input
            type="range" :min="yearBounds.min" :max="yearBounds.max"
            :value="yearMax ?? yearBounds.max"
            @input="(e: any) => yearMax = +e.target.value === yearBounds.max ? null : +e.target.value"
            aria-label="Til år"
          />
          <div class="year-labels t-mono">
            <span>{{ yearMin ?? yearBounds.min }}</span>
            <span>–</span>
            <span>{{ yearMax ?? yearBounds.max }}</span>
          </div>
        </div>
      </section>

      <section>
        <div class="row-between">
          <div class="h-eyebrow">Sjanger</div>
          <button v-if="allGenres.length > 14" type="button" class="lite-btn" @click="expandGenres = !expandGenres">
            {{ expandGenres ? 'Færre' : `+${allGenres.length - 14}` }}
          </button>
        </div>
        <div class="chip-row chip-grid">
          <button
            v-for="g in (expandGenres ? allGenres : allGenres.slice(0, 14))"
            :key="g.k"
            type="button"
            class="chip"
            :aria-pressed="genres.has(g.k)"
            @click="toggleGenre(g.k)"
          >
            {{ g.k }} <span class="n">{{ g.n }}</span>
          </button>
        </div>
      </section>

      <section>
        <div class="h-eyebrow">Format</div>
        <div class="chip-row">
          <button v-for="p in allPlatforms" :key="p.k" type="button"
            class="chip" :aria-pressed="platforms.has(p.k)" @click="togglePlatform(p.k)">
            {{ p.k }} <span class="n">{{ p.n }}</span>
          </button>
        </div>
      </section>

      <button v-if="activeCount" class="btn btn-stamp clear-all" type="button" @click="clearAll">
        Nullstill {{ activeCount }} {{ activeCount === 1 ? 'filter' : 'filtre' }}
      </button>
      <button v-else class="btn" type="button" disabled>Ingen filtre aktive</button>

      <details class="kbd-help">
        <summary class="h-eyebrow">Hurtigtaster</summary>
        <ul class="kbd-list t-mono">
          <li><kbd class="kbd">/</kbd> <span>fokus søk</span></li>
          <li><kbd class="kbd">r</kbd> <span>tilfeldig fra treffene</span></li>
          <li><kbd class="kbd">esc</kbd> <span>tøm filtre</span></li>
        </ul>
      </details>
    </aside>

    <!-- ============= main grid ============= -->
    <section class="main">
      <!-- Active filter chips (visible only when filters are active) -->
      <Transition name="chips">
        <div v-if="activeChips.length" class="active-chips">
          <span class="ac-label h-eyebrow">Aktive filtre</span>
          <button
            v-for="(c, i) in activeChips"
            :key="i + c.kind + c.label"
            class="ac-chip"
            type="button"
            :data-kind="c.kind"
            @click="c.remove"
            :aria-label="`Fjern filter: ${c.label}`"
          >
            {{ c.label }} <span class="ac-x" aria-hidden="true">×</span>
          </button>
          <button class="ac-clear" type="button" @click="clearAll">Tøm alle</button>
        </div>
      </Transition>

      <header class="top">
        <div class="counts">
          <div class="cnum t-mono">
            <span class="num">{{ filtered.length.toLocaleString('nb-NO') }}</span>
            <span class="cdesc">av {{ reviews.length.toLocaleString('nb-NO') }}</span>
          </div>
          <p v-if="filtered.length" class="cs-summary t-meta">
            <template v-if="q">«{{ q }}» —</template>
            snitt {{ (filtered.filter(r => r.rating).reduce((s,r) => s + (r.rating ?? 0), 0) / Math.max(1, filtered.filter(r => r.rating).length)).toFixed(2).replace('.', ',') }} terninger
            <template v-if="filtered.filter(r => r.rating === 6).length">
              · {{ filtered.filter(r => r.rating === 6).length }} mesterverk
            </template>
            <template v-if="filtered.filter(r => r.rating === 1).length">
              · {{ filtered.filter(r => r.rating === 1).length }} ettere
            </template>
          </p>
        </div>

        <div class="top-controls">
          <div class="view-toggle" role="tablist" aria-label="Visning">
            <button :aria-pressed="view === 'list'" class="vt" @click="view = 'list'" type="button" title="Liste">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <line x1="2" y1="4" x2="14" y2="4" stroke="currentColor" stroke-width="1.5"/>
                <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" stroke-width="1.5"/>
                <line x1="2" y1="12" x2="14" y2="12" stroke="currentColor" stroke-width="1.5"/>
              </svg>
            </button>
            <button :aria-pressed="view === 'grid'" class="vt" @click="view = 'grid'" type="button" title="Rutenett">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="2" y="2" width="5" height="5" fill="none" stroke="currentColor" stroke-width="1.5"/>
                <rect x="9" y="2" width="5" height="5" fill="none" stroke="currentColor" stroke-width="1.5"/>
                <rect x="2" y="9" width="5" height="5" fill="none" stroke="currentColor" stroke-width="1.5"/>
                <rect x="9" y="9" width="5" height="5" fill="none" stroke="currentColor" stroke-width="1.5"/>
              </svg>
            </button>
          </div>

          <label class="sort">
            <span class="h-eyebrow">Sorter</span>
            <select v-model="sort" class="sort-select t-mono">
              <option value="newest">Nyeste først</option>
              <option value="oldest">Eldste først</option>
              <option value="rating-high">Beste først</option>
              <option value="rating-low">Verste først</option>
              <option value="a-z">A til Å</option>
              <option value="z-a">Å til A</option>
            </select>
          </label>
        </div>
      </header>

      <ol v-if="loaded && visible.length" :class="['list', `list--${view}`]">
        <li v-for="r in visible" :key="r.id" class="item">
          <a :href="u(`/reviews/${r.slug}`)" class="row">
            <span class="idx t-mono">№ {{ String(filtered.indexOf(r) + 1).padStart(4, '0') }}</span>
            <span class="title">
              <span class="title-text" v-html="highlight(r.name)"></span>
              <span v-if="r.originalTitle && r.originalTitle !== r.name" class="orig italic">«<span v-html="highlight(r.originalTitle)"></span>»</span>
            </span>
            <span class="kicker italic" v-if="r.headline">«<span v-html="highlight(r.headline)"></span>»</span>
            <span class="meta t-mono">
              <span>{{ r.year }}</span>
              <span v-if="r.factbox?.regi || r.factbox?.serieskaper" class="sep">·</span>
              <span v-if="r.factbox?.regi || r.factbox?.serieskaper" v-html="highlight(r.factbox.regi ?? r.factbox.serieskaper)"></span>
              <span v-if="r.type !== 'Movie'" class="sep">·</span>
              <span v-if="r.type !== 'Movie'" class="tag">{{ r.type === 'TVSeries' ? 'serie' : r.type === 'Game' ? 'spill' : r.type }}</span>
            </span>
            <Die :value="r.rating" :size="36" :rotate="-2" />
          </a>
        </li>
      </ol>

      <div v-else-if="!loaded" class="empty">
        <span class="t-meta">laster anmeldelser…</span>
      </div>

      <div v-else class="empty empty-card">
        <div class="h-headline">Tomt arkiv.</div>
        <p>Filtrene gir ingen treff. Prøv å fjerne noen.</p>
        <button class="btn" @click="clearAll" type="button">Nullstill alle filtre</button>
      </div>

      <div v-if="loaded && filtered.length > visible.length" class="more">
        <button class="btn" type="button" @click="limit += 60">
          Vis {{ Math.min(60, filtered.length - visible.length) }} til
          ({{ (filtered.length - visible.length).toLocaleString('nb-NO') }} igjen)
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: clamp(1.5rem, 3vw, 3rem);
  align-items: start;
  margin-block: 2rem 6rem;
}

/* mobile filter toggle — only visible on small screens */
.mobile-filter-btn {
  display: none;
  position: sticky;
  top: 64px;
  z-index: 30;
  align-self: stretch;
  align-items: center;
  gap: 0.6rem;
  padding: 0.7rem 1rem;
  background: var(--color-leader-2);
  border: 1px solid var(--color-line-dark);
  color: var(--color-paper);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  cursor: pointer;
}
.mfb-count {
  display: grid;
  place-items: center;
  background: var(--color-stamp);
  color: var(--color-paper);
  border-radius: 999px;
  width: 1.4em;
  height: 1.4em;
  font-size: 0.7em;
}
.mfb-icon { margin-left: auto; font-size: 1.1em; line-height: 1; }

/* Active filter chips */
.active-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  padding-block: 0.5rem 1rem;
  margin-bottom: 0.8rem;
  border-bottom: 1px dashed var(--color-line-dark);
}
.ac-label { color: var(--fg-mute); margin-right: 0.5rem; }
.ac-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.32rem 0.6rem 0.32rem 0.7rem;
  border: 1px solid var(--color-stamp);
  background: color-mix(in srgb, var(--color-stamp) 12%, transparent);
  color: var(--color-paper);
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.08em;
  text-transform: lowercase;
  border-radius: 999px;
  cursor: pointer;
  transition: background .15s ease, border-color .15s ease;
}
.ac-chip:hover { background: var(--color-stamp); color: var(--color-paper); }
.ac-x { color: var(--color-stamp); font-size: 1em; line-height: 0.8; }
.ac-chip:hover .ac-x { color: var(--color-paper); }
.ac-chip[data-kind="q"] { border-color: var(--color-spark); background: color-mix(in srgb, var(--color-spark) 12%, transparent); }
.ac-chip[data-kind="q"] .ac-x { color: var(--color-spark); }
.ac-chip[data-kind="q"]:hover { background: var(--color-spark); color: var(--color-leader); }

.ac-clear {
  background: transparent;
  border: 0;
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--fg-mute);
  cursor: pointer;
  margin-left: auto;
  padding: 0.32rem 0.6rem;
}
.ac-clear:hover { color: var(--color-stamp); }

.chips-enter-active, .chips-leave-active {
  transition: opacity .25s ease, transform .25s ease;
}
.chips-enter-from, .chips-leave-to { opacity: 0; transform: translateY(-4px); }

/* ------ filters ------ */
.filters {
  position: sticky;
  top: 84px;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  max-height: calc(100dvh - 100px);
  overflow-y: auto;
  padding-right: 0.75rem;
  padding-bottom: 1rem;
}
.filters::-webkit-scrollbar { width: 4px; }
.filters::-webkit-scrollbar-thumb { background: var(--color-line-dark); }

.row-between { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }

.search { display: flex; flex-direction: column; gap: 0.6rem; }
.search-box { position: relative; }
.clear {
  position: absolute; right: 0; top: 50%; transform: translateY(-40%);
  background: transparent; border: 0; color: var(--fg-mute);
  font-size: 1.4rem; cursor: pointer;
}
.kbd {
  display: inline-grid; place-items: center;
  font-family: var(--font-mono);
  font-size: 0.62rem;
  font-weight: 600;
  padding: 0.18rem 0.36rem;
  border: 1px solid var(--color-line-dark);
  background: var(--color-leader-2);
  color: var(--fg-mute);
  border-radius: 3px;
  letter-spacing: 0.06em;
}

section { display: flex; flex-direction: column; gap: 0.7rem; }

.dice-row {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 0.3rem;
}
.die-pill {
  display: flex; flex-direction: column; align-items: center; gap: 0.2rem;
  padding: 0.35rem 0.15rem;
  min-width: 0;
  background: transparent; border: 1px solid transparent; border-radius: 6px;
  cursor: pointer; color: inherit; font: inherit;
  transition: background .2s ease, border-color .2s ease, transform .15s ease;
}
.die-pill:hover { background: var(--color-leader-2); transform: translateY(-1px); }
.die-pill[aria-pressed="true"] {
  border-color: var(--color-stamp);
  background: color-mix(in srgb, var(--color-stamp) 8%, transparent);
}
.die-pill :deep(svg) {
  width: 100%;
  height: auto;
  max-width: 34px;
}
.die-pill .t-meta { font-size: 0.6rem; }

.chip-row { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.chip-grid { gap: 0.35rem 0.4rem; }
.chip .n { color: var(--fg-mute); font-size: 0.6rem; margin-left: 0.4rem; opacity: 0.7; }
.chip[aria-pressed="true"] .n { color: inherit; opacity: .8; }

.chip-decade {
  font-variant-numeric: tabular-nums;
}
.chip-decade .dec-num {
  font-family: var(--font-mono);
  font-weight: 700;
  letter-spacing: 0.04em;
}

.year-range { display: grid; gap: 0.35rem; }
.year-range input[type=range] { width: 100%; accent-color: var(--color-stamp); background: transparent; }
.year-labels { display: flex; justify-content: space-between; font-size: 0.78rem; color: var(--fg-mute); }

.lite-btn {
  background: transparent; border: 0;
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-stamp);
  cursor: pointer;
  padding: 0;
}
.lite-btn:hover { color: var(--color-spark); }

.clear-all { align-self: stretch; }

.kbd-help summary {
  cursor: pointer;
  list-style: none;
  user-select: none;
}
.kbd-help summary::-webkit-details-marker { display: none; }
.kbd-list {
  list-style: none; margin: 0.6rem 0 0; padding: 0;
  display: flex; flex-direction: column; gap: 0.4rem;
  font-size: 0.72rem;
  color: var(--fg-mute);
}
.kbd-list li { display: flex; align-items: center; gap: 0.6rem; }

/* ------ main / list ------ */
.main { min-width: 0; }
.top {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 1rem;
  padding-bottom: 1rem;
  margin-bottom: 1.4rem;
  border-bottom: 1px solid var(--color-line-dark);
  flex-wrap: wrap;
}
.counts { display: flex; flex-direction: column; gap: 0.4rem; min-width: 0; }
.cnum { display: flex; align-items: baseline; gap: 0.7rem; }
.cnum .num {
  font-family: var(--font-display);
  font-variation-settings: "opsz" 144, "SOFT" 30, "WONK" 1;
  font-weight: 800;
  font-size: 2rem; line-height: 1;
  color: var(--color-paper);
  font-variant-numeric: tabular-nums;
}
.cdesc { color: var(--fg-mute); font-size: 0.78rem; letter-spacing: 0.06em; }
.cs-summary {
  color: var(--fg-mute);
  font-size: 0.74rem;
  letter-spacing: 0.04em;
  margin: 0;
}

.top-controls { display: flex; align-items: end; gap: 1rem; }

.view-toggle {
  display: flex;
  border: 1px solid var(--color-line-dark);
  background: var(--color-leader-2);
}
.vt {
  padding: 0.45rem 0.6rem;
  background: transparent; border: 0;
  color: var(--fg-mute);
  cursor: pointer;
  display: grid; place-items: center;
  transition: background .15s ease, color .15s ease;
}
.vt:hover { color: var(--color-paper); }
.vt[aria-pressed="true"] { background: var(--color-paper); color: var(--color-leader); }

.sort { display: flex; flex-direction: column; align-items: flex-start; gap: 0.2rem; }
.sort-select {
  background: transparent; border: 0;
  border-bottom: 1px solid var(--color-line-dark);
  color: var(--fg);
  font-size: 0.85rem; letter-spacing: 0.04em;
  padding: 0.2rem 0; cursor: pointer;
  font-family: var(--font-mono);
}
.sort-select:focus { outline: none; border-bottom-color: var(--color-stamp); }

/* List view */
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.list--list .item { border-top: 1px solid var(--color-line-dark); }
.list--list .item:last-child { border-bottom: 1px solid var(--color-line-dark); }
.list--list .row {
  display: grid;
  grid-template-columns: 70px minmax(0, 2.4fr) minmax(0, 1.7fr) minmax(0, 1.1fr) auto;
  gap: 1rem; align-items: center;
  padding: 0.95rem 0;
  text-decoration: none; color: inherit;
  transition: background .2s ease;
}
.list--list .row:hover { background: color-mix(in srgb, var(--color-paper) 4%, transparent); color: inherit; }
.list--list .row:hover .title-text { color: var(--color-spark); }

/* Grid view — masonry-like cards */
.list--grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}
.list--grid .item { border: none; }
.list--grid .row {
  display: grid;
  grid-template-rows: auto 1fr auto;
  gap: 0.5rem;
  padding: 1rem 1.1rem;
  text-decoration: none; color: inherit;
  background: var(--color-leader-2);
  border: 1px solid var(--color-line-dark);
  height: 100%;
  position: relative;
  transition: transform .35s var(--ease-paper), border-color .25s ease, background .25s ease;
}
.list--grid .row:hover {
  transform: translateY(-3px);
  border-color: var(--color-paper);
  background: var(--color-leader-3);
  color: inherit;
}
.list--grid .row:hover .title-text { color: var(--color-spark); }
.list--grid .idx { color: var(--color-spark); font-size: 0.7rem; letter-spacing: 0.14em; }
.list--grid .title-text {
  font-size: 1.32rem;
  white-space: normal;
  display: block;
}
.list--grid .kicker {
  font-size: 0.85rem;
  white-space: normal;
  display: block;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  display: -webkit-box;
  overflow: hidden;
  line-height: 1.3;
}
.list--grid .meta { font-size: 0.7rem; }
.list--grid svg[aria-label^="Terningkast"], .list--grid svg[aria-label^="Uten"] {
  position: absolute;
  top: 0.85rem;
  right: 0.95rem;
}

.idx { color: var(--color-spark); letter-spacing: 0.14em; font-size: 0.72rem; }
.title { display: flex; flex-direction: column; min-width: 0; }
.title-text {
  font-family: var(--font-display);
  font-variation-settings: "opsz" 96, "SOFT" 40, "WONK" 1;
  font-weight: 700;
  font-size: 1.18rem; line-height: 1.05;
  letter-spacing: -0.018em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: color .2s ease;
}
.orig {
  font-style: italic; font-size: 0.78rem; color: var(--fg-mute);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.kicker {
  font-family: var(--font-body); font-style: italic; font-size: 0.92rem;
  color: var(--color-paper-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.meta {
  font-size: 0.75rem; color: var(--fg-mute);
  display: inline-flex; gap: 0.4rem; align-items: baseline; flex-wrap: wrap;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sep { opacity: 0.4; }
.tag { color: var(--color-stamp); }

/* Search highlight */
:deep(mark) {
  background: color-mix(in srgb, var(--color-spark) 35%, transparent);
  color: inherit;
  padding: 0 0.05em;
  border-radius: 1px;
  font-weight: inherit;
}

.empty { padding: 4rem 0; text-align: center; }
.empty-card {
  display: flex; flex-direction: column; align-items: center; gap: 1rem;
  padding: 5rem 2rem;
  border: 1px dashed var(--color-line-dark);
}
.empty-card .h-headline { font-size: clamp(1.5rem, 3vw, 2.4rem); margin: 0; }
.empty-card p { color: var(--fg-mute); margin: 0; }

.more { padding: 2.5rem 0; text-align: center; }

@media (max-width: 980px) {
  .layout { grid-template-columns: 1fr; }
  .mobile-filter-btn { display: flex; }
  .filters {
    position: fixed;
    inset: 0 0 0 0;
    z-index: 25;
    background: var(--color-leader);
    padding: 5rem 1.4rem 2rem;
    max-height: none;
    overflow-y: auto;
    transform: translateY(-100%);
    transition: transform .3s var(--ease-paper);
    border-bottom: 0;
  }
  .layout.filters-open .filters { transform: translateY(0); }
  .list--list .row { grid-template-columns: 50px minmax(0, 2fr) minmax(0, 1.4fr) auto; }
  .list--list .kicker { display: none; }
}
@media (max-width: 600px) {
  .list--list .row { grid-template-columns: 40px minmax(0, 2fr) auto; }
  .list--list .meta { display: none; }
  .list--list .title-text { white-space: normal; font-size: 1.05rem; }
  .active-chips { padding-block: 0.4rem 0.6rem; margin-bottom: 0.5rem; }
}
</style>
