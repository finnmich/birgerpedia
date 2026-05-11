<script setup lang="ts">
import { computed } from 'vue';

interface Props {
  bins: number[];       // length 6, indexed 0..5 = ratings 1..6
  height?: number;
  /** Where each bar links. `null` makes the bars non-interactive (display
   * only). The default sends visitors to /reviews filtered by that
   * rating, matching the lede on the homepage. */
  hrefBuilder?: (rating: number) => string | null;
}

const props = withDefaults(defineProps<Props>(), {
  height: 220,
  hrefBuilder: (r: number) => `/reviews?r=${r}`,
});

const max = computed(() => Math.max(1, ...props.bins));
const total = computed(() => props.bins.reduce((s, n) => s + n, 0));

function pct(n: number) {
  return total.value ? Math.round((n / total.value) * 1000) / 10 : 0;
}

function pipsFor(r: number): { x: number; y: number }[] {
  const layouts: Record<number, [number, number][]> = {
    1: [[.5,.5]], 2: [[.28,.28],[.72,.72]], 3: [[.26,.26],[.5,.5],[.74,.74]],
    4: [[.28,.28],[.72,.28],[.28,.72],[.72,.72]],
    5: [[.27,.27],[.73,.27],[.5,.5],[.27,.73],[.73,.73]],
    6: [[.27,.22],[.73,.22],[.27,.5],[.73,.5],[.27,.78],[.73,.78]],
  };
  return (layouts[r] ?? []).map(([x,y]) => ({ x, y }));
}
</script>

<template>
  <div class="hist" :style="{ '--h': `${height}px` }">
    <div class="bars">
      <component
        :is="hrefBuilder(i + 1) ? 'a' : 'div'"
        v-for="(n, i) in bins"
        :key="i"
        :href="hrefBuilder(i + 1) ?? undefined"
        class="col"
        :class="{ 'is-clickable': !!hrefBuilder(i + 1) }"
        :style="{ '--ratio': max ? n / max : 0 }"
        :aria-label="`Terningkast ${i + 1}: ${n.toLocaleString('nb-NO')} anmeldelser, ${pct(n)} prosent` + (hrefBuilder(i + 1) ? ' — klikk for å filtrere' : '')"
      >
        <span class="count t-mono">{{ n.toLocaleString('nb-NO') }}</span>
        <span class="bar"></span>
        <span class="die-face">
          <svg viewBox="0 0 100 100" width="32" height="32" aria-hidden="true">
            <rect x="6" y="6" width="88" height="88" rx="14"
                  fill="#F4EFE6" stroke="#C9BFAB" stroke-width="1.4" />
            <circle v-for="(p, j) in pipsFor(i + 1)" :key="j"
              :cx="p.x * 100" :cy="p.y * 100"
              :r="i + 1 === 1 ? 9 : 7.5"
              fill="#1A1614" />
          </svg>
        </span>
        <span class="label">terningkast {{ i + 1 }}</span>
      </component>
    </div>
  </div>
</template>

<style scoped>
.hist { width: 100%; }
.bars {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: clamp(0.4rem, 1vw, 0.85rem);
  align-items: end;
  height: var(--h);
}
.col {
  position: relative;
  display: grid;
  grid-template-rows: auto 1fr auto auto;
  gap: 0.35rem;
  background: transparent;
  border: 0;
  text-align: center;
  font: inherit;
  color: inherit;
  text-decoration: none;
  padding: 0;
  transition: transform .25s var(--ease-paper);
}
.col.is-clickable { cursor: pointer; }
.col.is-clickable:hover { transform: translateY(-3px); }
.col.is-clickable:hover .bar { background: var(--color-spark); }
.col.is-clickable:hover .label { color: var(--color-paper); }
.col.is-clickable:focus-visible {
  outline: 2px solid var(--color-stamp);
  outline-offset: 4px;
}

.count {
  font-size: 0.7rem;
  letter-spacing: 0.06em;
  color: var(--fg-mute);
}

.bar {
  display: block;
  width: 100%;
  background: var(--color-paper);
  height: calc(var(--ratio) * (var(--h) - 70px));
  min-height: 4px;
  align-self: end;
  border-top: 2px solid var(--color-leader);
  transition: background .2s ease;
}

.die-face {
  display: grid; place-items: center;
  margin-top: 0.4rem;
}

.label {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--fg-mute);
  transition: color .2s ease;
}
</style>
