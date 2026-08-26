<script setup lang="ts">
import { onMounted, ref } from 'vue';
import Die from './Die.vue';
import { u } from '../../lib/url';

interface Latest {
  name: string;
  rating: number | null;
  slug: string;
  headline: string | null;
  regi: string | null;
  date: string;                 // pre-formatted Norwegian date
  dateISO: string | null;
  no: number;
}

const props = defineProps<{ review: Latest }>();

// Unlike HeroDie the pick here is fixed, so the card can SSR with its real
// content and the die with its real value. Hydration only replays the roll
// as a flourish — nothing swaps out, which means no skeleton and no layout
// shift on settle.
const rollSignal = ref(0);

onMounted(() => {
  if (props.review.rating == null) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  rollSignal.value++;
});
</script>

<template>
  <div class="latest-die">
    <div class="dice-stage">
      <Die
        :value="review.rating"
        :rollSignal="rollSignal"
        :size="220"
        variant="paper"
        :rotate="-6"
      />
    </div>

    <a :href="u(`/reviews/${review.slug}`)" class="card-summary">
      <span class="kicker">Siste anmeldelse</span>
      <h2 class="title">{{ review.name }}</h2>
      <div v-if="review.headline" class="head italic">«{{ review.headline }}»</div>
      <div class="meta t-mono">
        <span class="no">№ {{ String(review.no).padStart(4, '0') }}</span>
        <span class="dot">·</span>
        <time v-if="review.dateISO" :datetime="review.dateISO">{{ review.date }}</time>
        <template v-if="review.regi">
          <span class="dot">·</span>
          <span>{{ review.regi }}</span>
        </template>
        <template v-if="review.rating != null">
          <span class="dot">·</span>
          <span class="rating-text">terningkast {{ review.rating }}</span>
        </template>
      </div>
    </a>

    <a class="btn btn-stamp" :href="u(`/reviews/${review.slug}`)">Les anmeldelsen →</a>
  </div>
</template>

<style scoped>
/* Mirrors HeroDie's hero-side layout: die on the left spanning both rows,
   card top-right, CTA bottom-right. */
.latest-die {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: clamp(1.5rem, 4vw, 3.5rem);
  padding-block: clamp(1rem, 4vw, 2.5rem);
  position: relative;
}
.latest-die::after {
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
.no { color: var(--color-spark); letter-spacing: 0.16em; }
.dot { opacity: 0.5; }
.rating-text { color: var(--color-stamp); }

.btn {
  justify-self: start;
  grid-column: 2;
}

@media (max-width: 720px) {
  .latest-die { grid-template-columns: 1fr; gap: 1rem; }
  .dice-stage { grid-row: auto; padding: 0.5rem; }
  .btn { grid-column: auto; }
}
</style>
