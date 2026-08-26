<script setup lang="ts">
import { onMounted, ref } from 'vue';
import Die from './Die.vue';
import { u } from '../../lib/url';

interface Plug {
  id: string; name: string; rating: number | null; year: number;
  slug: string; headline: string | null; image: string | null;
  regi: string | null;
}

interface Props {
  reviews: Plug[];
  initialIdx?: number;        // server-picked, so SSR shows something
  /** Label above the title. Pass `null` where an enclosing section header
   *  already says the same thing. */
  kicker?: string | null;
}
const props = withDefaults(defineProps<Props>(), {
  initialIdx: 0,
  kicker: 'Et tilfeldig kast',
});

// Start with no fixed pick — the die rolls on hydration and the card
// fades in only when it lands on a review. SSR renders the rolling die
// (no review text), so the first paint never shows a stale value that
// immediately gets replaced.
const idx = ref<number>(props.initialIdx ?? 0);
const value = ref<number | null>(null);
const cycling = ref(true);
const showDetail = ref(false);
// Bumped on every pickRandom — Die.vue uses this so the roll animation
// fires even when two picks in a row share the same rating.
const rollSignal = ref(0);

const current = () => props.reviews[idx.value];

onMounted(() => {
  if (!props.reviews.length) return;
  // Respect reduced-motion: just settle on a random review without animation.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    idx.value = (Math.random() * props.reviews.length) | 0;
    value.value = current()?.rating ?? null;
    cycling.value = false;
    showDetail.value = true;
    return;
  }
  pickRandom();
});

function pickRandom() {
  if (!props.reviews.length) return;
  cycling.value = true;
  showDetail.value = false;
  // Avoid landing on the same review twice in a row
  let next = idx.value;
  while (props.reviews.length > 1 && next === idx.value) {
    next = (Math.random() * props.reviews.length) | 0;
  }
  idx.value = next;
  value.value = current()?.rating ?? null;
  rollSignal.value++;       // always animate, even if rating == previous
  setTimeout(() => {
    cycling.value = false;
    showDetail.value = true;
  }, 700);
}
</script>

<template>
  <div class="hero-die">
    <div class="dice-stage">
      <Die :value="value" :rolling="cycling" :rollSignal="rollSignal" :size="220" variant="paper" :rotate="-6" />
    </div>

    <Transition name="fade" mode="out-in">
      <a v-if="showDetail && current()" key="card" :href="u(`/reviews/${current().slug}`)" class="card-summary anim-fade-in">
        <span v-if="kicker" class="kicker">{{ kicker }}</span>
        <h2 class="title">{{ current().name }}</h2>
        <div v-if="current().headline" class="head italic">«{{ current().headline }}»</div>
        <div class="meta t-mono">
          <span>{{ current().year }}</span>
          <span v-if="current().regi" class="dot">·</span>
          <span v-if="current().regi">{{ current().regi }}</span>
          <span class="dot">·</span>
          <span class="rating-text">terningkast {{ value }}</span>
        </div>
      </a>
      <div v-else key="skel" class="card-summary card-summary--skel" aria-hidden="true">
        <span v-if="kicker" class="kicker">{{ kicker }}</span>
        <span class="skel-group skel-title">
          <span class="skel skel-line-full"></span>
          <span class="skel skel-line-short"></span>
        </span>
        <span class="skel-group skel-head">
          <span class="skel skel-line-full"></span>
          <span class="skel skel-line-short"></span>
        </span>
        <span class="skel skel-meta"></span>
      </div>
    </Transition>

    <button type="button" class="btn btn-stamp" @click="pickRandom">Slå igjen</button>
  </div>
</template>

<style scoped>
.hero-die {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: clamp(1.5rem, 4vw, 3.5rem);
  padding-block: clamp(1rem, 4vw, 2.5rem);
  position: relative;
}
.hero-die::after {
  position: absolute;
  inset: 0 -2rem;
  content: "";
  background: radial-gradient(60% 40% at 30% 50%, rgba(212,62,45,.08), transparent 70%);
  pointer-events: none;
  z-index: -1;
}

.dice-stage {
  grid-row: span 2;
  display: grid;
  place-items: center;
  perspective: 800px;
  position: relative;
  padding: 1rem;
}
.dice-stage::before {
  content: "";
  position: absolute;
  inset: auto 0 8px 0;
  margin-inline: auto;
  width: 70%;
  height: 14px;
  background: radial-gradient(ellipse at center, rgba(0,0,0,.4), transparent 70%);
  filter: blur(6px);
  z-index: 0;
}

.card-summary {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  padding: 0.5rem 0;
  text-decoration: none;
  color: inherit;
  /* Pin to the grid column's full width (capped at 60ch) so the box
     occupies the same horizontal space whether the contents are skeleton
     bars or a short title — otherwise the box auto-sizes to content and
     causes a visible width shift on settle. */
  width: 100%;
  max-width: 60ch;
}
.card-summary:hover { color: inherit; }
.card-summary:hover .title { color: var(--color-spark); }

.kicker {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--color-stamp);
}
.title {
  font-family: var(--font-display);
  font-variation-settings: "opsz" 144, "SOFT" 50, "WONK" 1;
  font-weight: 800;
  font-size: clamp(2rem, 4.6vw, 3.6rem);
  line-height: 0.95;
  letter-spacing: -0.04em;
  margin: 0;
  transition: color .25s ease;
}
.head {
  font-family: var(--font-body);
  font-style: italic;
  font-size: clamp(1.15rem, 1.8vw, 1.45rem);
  color: var(--color-paper-2);
  line-height: 1.3;
  margin: 0;
}
.meta {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.55rem;
  color: var(--fg-mute);
  font-size: 0.78rem;
  letter-spacing: 0.05em;
}
.dot { opacity: 0.5; }
.rating-text { color: var(--color-stamp); }

/* Skeleton placeholder — reserves the card's vertical space while the
   die rolls so the page below doesn't shift when the real card lands.
   Each group renders two bars sized to the real line-height so long
   titles + long headlines (the common case) don't blow past the
   reserved height. */
.card-summary--skel { pointer-events: none; }
.card-summary--skel .skel {
  display: block;
  background: color-mix(in srgb, var(--color-paper) 8%, transparent);
  border-radius: 4px;
  animation: skel-pulse 1.6s ease-in-out infinite;
}
.card-summary--skel .skel-group {
  display: flex;
  flex-direction: column;
  gap: 0.25em;
}
.card-summary--skel .skel-title { font-size: clamp(2rem, 4.6vw, 3.6rem); }
.card-summary--skel .skel-title .skel { height: 0.95em; }       /* line-height 0.95 */
.card-summary--skel .skel-head  { font-size: clamp(1.15rem, 1.8vw, 1.45rem); }
.card-summary--skel .skel-head  .skel { height: 1.3em; }        /* line-height 1.3 */
.card-summary--skel .skel-line-full  { width: 100%; }
.card-summary--skel .skel-line-short { width: 55%; }
.card-summary--skel .skel-meta {
  height: 0.78rem;
  width: 40%;
}
@keyframes skel-pulse {
  0%, 100% { opacity: 0.55; }
  50%      { opacity: 0.9; }
}
@media (prefers-reduced-motion: reduce) {
  .card-summary--skel .skel { animation: none; }
}

.btn {
  justify-self: start;
  grid-column: 2;
}

.fade-enter-active, .fade-leave-active {
  transition: opacity 350ms ease, transform 350ms var(--ease-paper);
}
.fade-enter-from, .fade-leave-to { opacity: 0; transform: translateY(8px); }

@media (max-width: 720px) {
  .hero-die { grid-template-columns: 1fr; gap: 1rem; }
  .dice-stage { grid-row: auto; padding: 0.5rem; }
  .btn { grid-column: auto; }
}
</style>
