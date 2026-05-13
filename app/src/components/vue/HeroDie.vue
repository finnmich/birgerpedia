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
}
const props = withDefaults(defineProps<Props>(), { initialIdx: 0 });

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

    <Transition name="fade">
      <a v-if="showDetail && current()" :href="u(`/reviews/${current().slug}`)" class="card-summary anim-fade-in">
        <span class="kicker">Et tilfeldig kast</span>
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
