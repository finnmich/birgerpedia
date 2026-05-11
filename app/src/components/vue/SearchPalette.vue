<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import MiniSearch from 'minisearch';
import Die from './Die.vue';
import { u } from '../../lib/url';

interface ReviewDoc {
  id: string;
  name: string;
  originalTitle: string | null;
  headline: string | null;
  rating: number | null;
  publishedAt: string | null;
  type: string;
  factbox: any;
  // derived
  slug: string;
  year: number;
  regi: string | null;
  hay: string;
}

interface PersonDoc {
  slug: string;
  name: string;
  profile: string | null;
  n: number;
  avg: number | null;
  role: string;
}

interface CategoryDoc {
  kind: 'genre' | 'distributor' | 'platform';
  key: string;
  label: string;
  n: number;
  avg: number | null;
  href: string;
}

const open = ref(false);
const loadingReviews = ref(false);
const reviewsLoaded = ref(false);
const peopleLoaded = ref(false);
const categoriesLoaded = ref(false);
const q = ref('');
const selectedKind = ref<'reviews' | 'people' | 'categories'>('reviews');
const selectedIdx = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
const modalRef = ref<HTMLElement | null>(null);

const reviews = ref<ReviewDoc[]>([]);
const people = ref<PersonDoc[]>([]);
const categories = ref<CategoryDoc[]>([]);

let reviewSearch: MiniSearch | null = null;
let peopleSearch: MiniSearch | null = null;
let categorySearch: MiniSearch | null = null;

// Where focus should return when the palette closes (accessibility: the
// trigger button or the last-focused element on the page).
let lastFocused: HTMLElement | null = null;

// ---- mounting / shortcuts ----

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  document.addEventListener('vmx:open-search', show as EventListener);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  document.removeEventListener('vmx:open-search', show as EventListener);
});

function onKeydown(e: KeyboardEvent) {
  // Cmd-K / Ctrl-K — open globally
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    show();
    return;
  }
  // "/" — open if not already in an input
  if (e.key === '/' && !open.value) {
    const t = e.target as HTMLElement | null;
    if (t?.matches?.('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    show();
  }
}

function show() {
  if (!open.value) lastFocused = document.activeElement as HTMLElement | null;
  open.value = true;
  // Critical path: only reviews on first open. People + categories load in
  // the background via requestIdleCallback so the palette is searchable
  // (against 1,910 reviews) within ~50 ms of the open instead of waiting
  // for the full 2.1 MB to land.
  if (!reviewsLoaded.value && !loadingReviews.value) loadReviews();
  if (!peopleLoaded.value) scheduleIdle(loadPeople);
  if (!categoriesLoaded.value) scheduleIdle(loadCategories);
  nextTick(() => {
    inputRef.value?.focus();
    inputRef.value?.select();
  });
  document.documentElement.style.overflow = 'hidden';
}

function close() {
  open.value = false;
  document.documentElement.style.overflow = '';
  // Accessibility: send focus back where it was (Cmd-K trigger button,
  // header link, wherever) so keyboard users don't lose their place.
  if (lastFocused?.focus) {
    try { lastFocused.focus(); } catch { /* element gone, ignore */ }
  }
  lastFocused = null;
}

function scheduleIdle(fn: () => Promise<void> | void) {
  if (typeof window === 'undefined') return;
  const ric = (window as any).requestIdleCallback;
  if (ric) ric(() => { void fn(); }, { timeout: 1500 });
  else setTimeout(() => { void fn(); }, 80);
}

// ---- data load (split into three phases) ----

async function loadReviews() {
  loadingReviews.value = true;
  try {
    const rRes = await fetch(u('/data/reviews.json'));
    const rRaw: any[] = await rRes.json();
    reviews.value = rRaw.map((r) => {
      const year = Number(r.publishedAt?.slice(0, 4)) || 0;
      const regi = r.factbox?.regi ?? r.factbox?.serieskaper ?? null;
      return {
        ...r,
        year,
        regi,
        slug: reviewSlug(r.name, r.id),
        hay: [r.name, r.originalTitle, r.headline, regi, ...(r.factbox?.skuespillere ?? []), ...(r.factbox?.sjanger ?? [])]
          .filter(Boolean).join(' ').toLowerCase(),
      } as ReviewDoc;
    });
    reviewSearch = new MiniSearch({
      fields: ['name', 'originalTitle', 'headline', 'regi', 'skuespillere', 'sjanger'],
      storeFields: ['id'],
      searchOptions: {
        combineWith: 'AND',
        fuzzy: 0.18, prefix: true,
        boost: { name: 4, originalTitle: 3, headline: 1.5 },
      },
      extractField: (doc, field) => {
        if (field === 'regi') return (doc as any).regi ?? '';
        if (field === 'skuespillere') return ((doc as any).factbox?.skuespillere ?? []).join(' ');
        if (field === 'sjanger') return ((doc as any).factbox?.sjanger ?? []).join(' ');
        return (doc as any)[field] ?? '';
      },
    });
    reviewSearch.addAll(reviews.value);
    reviewsLoaded.value = true;
  } finally {
    loadingReviews.value = false;
  }
}

async function loadPeople() {
  if (peopleLoaded.value) return;
  try {
    const pRes = await fetch(u('/data/people.json'));
    const pRaw = await pRes.json();
    people.value = pRaw as PersonDoc[];
    peopleSearch = new MiniSearch({
      fields: ['name'],
      storeFields: ['slug'],
      searchOptions: { combineWith: 'AND', fuzzy: 0.2, prefix: true },
      idField: 'slug',
    });
    peopleSearch.addAll(people.value);
    peopleLoaded.value = true;
  } catch { /* offline / fetch error — palette still works on reviews */ }
}

async function loadCategories() {
  if (categoriesLoaded.value) return;
  try {
    const sRes = await fetch(u('/data/stats.json'));
    const sRaw = await sRes.json();
    const cats: CategoryDoc[] = [];
    for (const g of sRaw.topGenres ?? []) {
      cats.push({
        kind: 'genre', key: g.key, label: g.key, n: g.n, avg: g.avg ?? null,
        href: u(`/reviews?g=${encodeURIComponent(g.key)}`),
      });
    }
    for (const d of sRaw.topDistributors ?? []) {
      cats.push({
        kind: 'distributor', key: d.key, label: d.key, n: d.n, avg: d.avg ?? null,
        href: u(`/reviews?q=${encodeURIComponent(d.key)}`),
      });
    }
    categories.value = cats;
    categorySearch = new MiniSearch({
      fields: ['label'],
      storeFields: ['kind', 'key'],
      searchOptions: { combineWith: 'AND', fuzzy: 0.2, prefix: true },
      idField: 'key',
    });
    categorySearch.addAll(categories.value);
    categoriesLoaded.value = true;
  } catch { /* see loadPeople — non-critical */ }
}

// Back-compat aliases so the template doesn't have to know about the split.
const loaded = computed(() => reviewsLoaded.value);
const loading = computed(() => loadingReviews.value && !reviewsLoaded.value);

// Trap Tab/Shift-Tab inside the modal so focus doesn't leak to the page
// behind the overlay. Cycles between the first and last focusable nodes.
function onTabTrap(e: KeyboardEvent) {
  if (e.key !== 'Tab' || !modalRef.value) return;
  const focusable = modalRef.value.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function reviewSlug(name: string, id: string) {
  const tail = (id ?? '').split('.').pop() ?? '';
  const base = (name ?? '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'review';
  return `${base}-${tail}`;
}

// ---- searching ----

const reviewHits = computed<ReviewDoc[]>(() => {
  if (!loaded.value || !q.value.trim() || !reviewSearch) return [];
  return reviewSearch.search(q.value).slice(0, 8)
    .map((h) => reviews.value.find((r) => r.id === h.id))
    .filter((r): r is ReviewDoc => !!r);
});

const peopleHits = computed<PersonDoc[]>(() => {
  if (!loaded.value || !q.value.trim() || !peopleSearch) return [];
  const ids = peopleSearch.search(q.value).slice(0, 8).map((h) => h.id as string);
  return ids.map((slug) => people.value.find((p) => p.slug === slug)).filter((p): p is PersonDoc => !!p);
});

const categoryHits = computed<CategoryDoc[]>(() => {
  if (!loaded.value || !q.value.trim() || !categorySearch) return [];
  const ids = categorySearch.search(q.value).slice(0, 4).map((h) => h.id);
  return ids.map((key) => categories.value.find((c) => c.key === key)).filter((c): c is CategoryDoc => !!c);
});

const totalHits = computed(() => reviewHits.value.length + peopleHits.value.length + categoryHits.value.length);

// ---- keyboard nav ----

watch([reviewHits, peopleHits, categoryHits], () => {
  // Reset selection when results change
  if (reviewHits.value.length) { selectedKind.value = 'reviews'; selectedIdx.value = 0; }
  else if (peopleHits.value.length) { selectedKind.value = 'people'; selectedIdx.value = 0; }
  else if (categoryHits.value.length) { selectedKind.value = 'categories'; selectedIdx.value = 0; }
});

function isSelected(kind: 'reviews' | 'people' | 'categories', i: number): boolean {
  return selectedKind.value === kind && selectedIdx.value === i;
}

function moveSelection(d: number) {
  // flatten kinds into a sequence and step through
  const order: Array<{ kind: 'reviews' | 'people' | 'categories'; len: number }> = [
    { kind: 'reviews', len: reviewHits.value.length },
    { kind: 'people', len: peopleHits.value.length },
    { kind: 'categories', len: categoryHits.value.length },
  ];
  const flat: Array<{ kind: 'reviews' | 'people' | 'categories'; idx: number }> = [];
  for (const g of order) for (let i = 0; i < g.len; i++) flat.push({ kind: g.kind, idx: i });
  if (!flat.length) return;
  const cur = flat.findIndex((f) => f.kind === selectedKind.value && f.idx === selectedIdx.value);
  const next = (cur + d + flat.length) % flat.length;
  selectedKind.value = flat[next].kind;
  selectedIdx.value = flat[next].idx;
  nextTick(() => {
    document.querySelector('.vmx-search-modal .sel')?.scrollIntoView({ block: 'nearest' });
  });
}

function goToSelected() {
  if (selectedKind.value === 'reviews' && reviewHits.value[selectedIdx.value]) {
    location.href = u(`/reviews/${reviewHits.value[selectedIdx.value].slug}`);
  } else if (selectedKind.value === 'people' && peopleHits.value[selectedIdx.value]) {
    location.href = u(`/people/${peopleHits.value[selectedIdx.value].slug}`);
  } else if (selectedKind.value === 'categories' && categoryHits.value[selectedIdx.value]) {
    location.href = categoryHits.value[selectedIdx.value].href;
  }
}

const ROLE_LABEL: Record<string, string> = {
  director: 'regissør',
  creator: 'serieskaper',
  writer: 'manus',
  actor: 'skuespiller',
};

const KIND_LABEL: Record<string, string> = {
  genre: 'sjanger',
  distributor: 'distributør',
  platform: 'format',
};
</script>

<template>
  <Teleport to="body">
    <Transition name="vmx-fade">
      <div v-if="open" class="vmx-search-overlay" @mousedown.self="close" role="dialog" aria-modal="true" aria-label="Søk i Birgerpedia">
        <div ref="modalRef" class="vmx-search-modal" @mousedown.stop @keydown="onTabTrap">
          <header class="vmx-search-head">
            <svg class="ico" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" stroke-width="2"/>
              <line x1="13.5" y1="13.5" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
            <input
              ref="inputRef"
              v-model="q"
              class="vmx-search-input"
              type="search"
              placeholder="Søk i alt — titler, regissører, skuespillere, sjangere…"
              autocomplete="off"
              spellcheck="false"
              @keydown.down.prevent="moveSelection(1)"
              @keydown.up.prevent="moveSelection(-1)"
              @keydown.enter.prevent="goToSelected"
              @keydown.esc.prevent="close"
            />
            <button class="kbd-hint" @click="close" aria-label="Lukk">esc</button>
          </header>

          <div class="vmx-search-body">
            <p v-if="loading && !loaded" class="vmx-empty">laster indeks…</p>

            <p v-else-if="!q" class="vmx-empty">
              Begynn å skrive. <kbd>↑</kbd><kbd>↓</kbd> for å navigere, <kbd>↵</kbd> for å åpne.
              <span v-if="loaded" class="dim">— {{ reviews.length.toLocaleString('nb-NO') }} anmeldelser, {{ people.length.toLocaleString('nb-NO') }} personer.</span>
            </p>

            <p v-else-if="loaded && !totalHits" class="vmx-empty">Ingen treff på «{{ q }}».</p>

            <template v-else-if="loaded">
              <section v-if="reviewHits.length" class="vmx-section">
                <h3 class="h-eyebrow">Anmeldelser</h3>
                <ol>
                  <li v-for="(r, i) in reviewHits" :key="r.id" :class="{ sel: isSelected('reviews', i) }">
                    <a :href="u(`/reviews/${r.slug}`)" @mouseenter="selectedKind = 'reviews'; selectedIdx = i">
                      <Die :value="r.rating" :size="28" :rotate="-2" />
                      <span class="title">{{ r.name }}</span>
                      <span v-if="r.headline" class="head italic">«{{ r.headline }}»</span>
                      <span class="meta t-mono">
                        {{ r.year }}<template v-if="r.regi"> · {{ r.regi }}</template>
                      </span>
                    </a>
                  </li>
                </ol>
              </section>

              <section v-if="peopleHits.length" class="vmx-section">
                <h3 class="h-eyebrow">Personer</h3>
                <ol>
                  <li v-for="(p, i) in peopleHits" :key="p.slug" :class="{ sel: isSelected('people', i) }">
                    <a :href="u(`/people/${p.slug}`)" @mouseenter="selectedKind = 'people'; selectedIdx = i">
                      <span class="avatar">
                        <img v-if="p.profile" :src="p.profile" :alt="p.name" loading="lazy" />
                        <span v-else class="mono">{{ p.name.split(' ').map((s: string) => s[0]).slice(0, 2).join('') }}</span>
                      </span>
                      <span class="title">{{ p.name }}</span>
                      <span class="head italic">{{ ROLE_LABEL[p.role] ?? p.role }}</span>
                      <span class="meta t-mono">
                        {{ p.n }} {{ p.n === 1 ? 'verk' : 'verker' }}<template v-if="p.avg != null"> · snitt {{ p.avg.toFixed(2).replace('.', ',') }}</template>
                      </span>
                    </a>
                  </li>
                </ol>
              </section>

              <section v-if="categoryHits.length" class="vmx-section">
                <h3 class="h-eyebrow">Kategorier</h3>
                <ol>
                  <li v-for="(c, i) in categoryHits" :key="c.key" :class="{ sel: isSelected('categories', i) }">
                    <a :href="c.href" @mouseenter="selectedKind = 'categories'; selectedIdx = i">
                      <span class="cat-tag">{{ KIND_LABEL[c.kind] }}</span>
                      <span class="title">{{ c.label }}</span>
                      <span class="meta t-mono">
                        {{ c.n }} {{ c.n === 1 ? 'verk' : 'verker' }}<template v-if="c.avg != null"> · snitt {{ c.avg.toFixed(2).replace('.', ',') }}</template>
                      </span>
                    </a>
                  </li>
                </ol>
              </section>
            </template>
          </div>

          <footer class="vmx-search-foot t-mono">
            <span><kbd>↑</kbd><kbd>↓</kbd> nav</span>
            <span><kbd>↵</kbd> åpne</span>
            <span><kbd>esc</kbd> lukk</span>
            <span class="spacer"></span>
            <span><kbd>⌘K</kbd>·<kbd>/</kbd> hvor som helst</span>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.vmx-search-overlay {
  position: fixed;
  inset: 0;
  z-index: 999;
  background: color-mix(in oklab, var(--color-leader) 85%, transparent);
  backdrop-filter: blur(8px) saturate(110%);
  display: grid;
  place-items: start center;
  padding-top: clamp(3rem, 12vh, 8rem);
}

.vmx-search-modal {
  width: min(720px, 92vw);
  max-height: 70vh;
  background: var(--color-leader-2);
  border: 1px solid var(--color-line-dark);
  box-shadow: 0 30px 80px -20px rgba(0,0,0,0.7);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: var(--font-body);
}

.vmx-search-head {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.95rem 1.1rem 0.95rem 1.4rem;
  border-bottom: 1px solid var(--color-line-dark);
  background: var(--color-leader);
}
.vmx-search-head .ico { color: var(--color-stamp); flex-shrink: 0; }

.vmx-search-input {
  flex: 1;
  background: transparent;
  border: 0;
  font-family: var(--font-display);
  font-variation-settings: "opsz" 96, "SOFT" 30, "WONK" 1;
  font-size: 1.4rem;
  letter-spacing: -0.018em;
  color: var(--color-paper);
  outline: none;
  min-width: 0;
}
.vmx-search-input::placeholder {
  color: var(--fg-mute);
  font-weight: 400;
}

.kbd-hint {
  background: var(--color-leader-2);
  border: 1px solid var(--color-line-dark);
  color: var(--fg-mute);
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  padding: 0.35rem 0.6rem;
  cursor: pointer;
}
.kbd-hint:hover { color: var(--color-paper); border-color: var(--color-paper); }

.vmx-search-body {
  flex: 1;
  overflow-y: auto;
  padding: 0.6rem 0.4rem 0.8rem;
}
.vmx-search-body::-webkit-scrollbar { width: 4px; }
.vmx-search-body::-webkit-scrollbar-thumb { background: var(--color-line-dark); }

.vmx-empty {
  padding: 2rem 1.6rem;
  color: var(--fg-mute);
  font-style: italic;
  font-size: 0.92rem;
  text-align: center;
}
.vmx-empty .dim { color: var(--color-line-dark); display: block; margin-top: 0.6rem; font-style: normal; font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.06em; }

.vmx-empty kbd, .vmx-search-foot kbd {
  display: inline-grid; place-items: center;
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 600;
  padding: 0.18rem 0.4rem;
  border: 1px solid var(--color-line-dark);
  background: var(--color-leader);
  color: var(--fg-mute);
  border-radius: 3px;
  letter-spacing: 0.06em;
  margin: 0 0.05em;
}

.vmx-section {
  padding: 0.4rem 0.6rem 0.6rem;
}
.vmx-section h3 {
  margin: 0.5rem 0.6rem 0.4rem;
  color: var(--fg-mute);
}
.vmx-section ol {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.vmx-section li a {
  display: grid;
  grid-template-columns: auto minmax(0, 1.4fr) minmax(0, 1.6fr) auto;
  gap: 0.7rem 0.9rem;
  align-items: center;
  padding: 0.55rem 0.75rem;
  text-decoration: none;
  color: var(--color-paper);
  border: 1px solid transparent;
  border-radius: 6px;
}
.vmx-section li.sel a {
  background: color-mix(in srgb, var(--color-stamp) 12%, transparent);
  border-color: color-mix(in srgb, var(--color-stamp) 40%, transparent);
}
.vmx-section li.sel .title { color: var(--color-spark); }

.vmx-section .title {
  font-family: var(--font-display);
  font-variation-settings: "opsz" 96, "SOFT" 30, "WONK" 1;
  font-weight: 600;
  font-size: 1rem;
  line-height: 1.05;
  letter-spacing: -0.012em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.vmx-section .head {
  font-family: var(--font-body);
  font-style: italic;
  font-size: 0.82rem;
  color: var(--color-paper-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.vmx-section .meta {
  font-size: 0.7rem;
  color: var(--fg-mute);
  white-space: nowrap;
  text-align: right;
}

.avatar {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--color-leader-3);
  border: 1px solid var(--color-line-dark);
}
.avatar img { width: 100%; height: 100%; object-fit: cover; filter: grayscale(.15) contrast(1.05); }
.avatar .mono {
  font-family: var(--font-display);
  font-variation-settings: "opsz" 96, "SOFT" 30, "WONK" 1;
  font-weight: 700;
  color: var(--fg-mute);
  font-size: 0.78rem;
}

.cat-tag {
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  background: var(--color-stamp);
  color: var(--color-paper);
  font-family: var(--font-mono);
  font-size: 0.55rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  border-radius: 999px;
  text-align: center;
  line-height: 1;
}

.vmx-search-foot {
  padding: 0.6rem 1rem;
  border-top: 1px solid var(--color-line-dark);
  background: var(--color-leader);
  display: flex;
  align-items: center;
  gap: 0.9rem;
  font-size: 0.7rem;
  color: var(--fg-mute);
  letter-spacing: 0.04em;
}
.vmx-search-foot .spacer { margin-left: auto; }

.vmx-fade-enter-active, .vmx-fade-leave-active {
  transition: opacity .2s ease;
}
.vmx-fade-enter-active .vmx-search-modal, .vmx-fade-leave-active .vmx-search-modal {
  transition: transform .25s var(--ease-paper), opacity .2s ease;
}
.vmx-fade-enter-from, .vmx-fade-leave-to { opacity: 0; }
.vmx-fade-enter-from .vmx-search-modal, .vmx-fade-leave-to .vmx-search-modal {
  transform: translateY(-12px) scale(0.97);
  opacity: 0;
}

@media (max-width: 600px) {
  .vmx-search-overlay { padding-top: 1rem; }
  .vmx-search-modal { max-height: 88vh; }
  .vmx-section li a { grid-template-columns: auto 1fr auto; gap: 0.5rem 0.6rem; }
  .vmx-section .head { display: none; }
  .vmx-section .title { white-space: normal; font-size: 0.95rem; }
}
</style>
