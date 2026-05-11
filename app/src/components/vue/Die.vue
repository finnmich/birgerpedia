<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

interface Props {
  value?: number | null;
  size?: number;
  variant?: 'paper' | 'ink' | 'stamp';
  rolling?: boolean;
  /** Increments every time the parent wants a roll animation, even when the
   * resting value would be the same as before (otherwise watching `value`
   * alone misses two-in-a-row matching ratings). */
  rollSignal?: number;
  rotate?: number;
}
const props = withDefaults(defineProps<Props>(), {
  size: 64, variant: 'paper', rolling: false, rollSignal: 0, rotate: -3,
});

const palettes = {
  paper: { face: '#F4EFE6', pip: '#1A1614', edge: '#C9BFAB' },
  ink:   { face: '#0E0B0A', pip: '#F4EFE6', edge: '#3A3330' },
  stamp: { face: '#D43E2D', pip: '#F4EFE6', edge: '#7A1F18' },
};
const p = computed(() => palettes[props.variant]);

const layouts: Record<number, [number, number][]> = {
  1: [[.5, .5]],
  2: [[.28, .28], [.72, .72]],
  3: [[.26, .26], [.5, .5], [.74, .74]],
  4: [[.28, .28], [.72, .28], [.28, .72], [.72, .72]],
  5: [[.27, .27], [.73, .27], [.5, .5], [.27, .73], [.73, .73]],
  6: [[.27, .22], [.73, .22], [.27, .5], [.73, .5], [.27, .78], [.73, .78]],
};

const shownValue = ref<number | null>(props.value ?? null);
const animating = ref(false);
let intervalId: ReturnType<typeof setInterval> | null = null;

function stopRoll() {
  if (intervalId != null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  animating.value = false;
}

function roll(restValue: number | null) {
  stopRoll();
  if (restValue == null) {
    shownValue.value = null;
    return;
  }
  animating.value = true;
  let i = 0;
  intervalId = setInterval(() => {
    shownValue.value = ((Math.random() * 6) | 0) + 1;
    i++;
    if (i > 6) {
      stopRoll();
      shownValue.value = restValue;
    }
  }, 80);
}

// Whenever the parent bumps rollSignal, animate to the current value —
// regardless of whether `value` itself actually changed. (Same rating
// twice in a row should still feel rolly.)
watch(
  () => props.rollSignal,
  () => roll(props.value ?? null),
);

// If `value` changes outside an active roll, mirror it directly.
watch(
  () => props.value,
  (v) => {
    if (animating.value) return;     // mid-roll: let the interval finish
    shownValue.value = v ?? null;
  },
);

// Legacy: parents that only flip `rolling` (without a rollSignal) still
// trigger an animation on the false→true transition.
watch(
  () => props.rolling,
  (now, prev) => {
    if (now && !prev && props.rollSignal === 0) roll(props.value ?? null);
  },
);

onBeforeUnmount(stopRoll);

const dots = computed(() => (shownValue.value ? layouts[shownValue.value] : []));
const tilt = computed(() =>
  `rotate(${props.rotate}deg)${animating.value ? ' rotateZ(360deg)' : ''}`,
);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 100 100"
    role="img"
    :aria-label="shownValue ? `Terningkast ${shownValue}` : 'Uten terningkast'"
    :style="{ transform: tilt, transition: 'transform .35s cubic-bezier(.2,.9,.25,1.4)' }"
  >
    <defs>
      <linearGradient :id="`die-grad-${size}`" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" :stop-color="p.face" stop-opacity="1" />
        <stop offset="1" :stop-color="p.face" stop-opacity=".82" />
      </linearGradient>
    </defs>
    <rect x="6" y="6" width="88" height="88" rx="14" :fill="`url(#die-grad-${size})`"
          :stroke="p.edge" stroke-width="1.5" />
    <text v-if="shownValue == null" x="50" y="64" text-anchor="middle"
          font-family="JetBrains Mono, monospace" font-size="32"
          :fill="p.pip" opacity=".55">?</text>
    <circle
      v-for="([x, y], i) in dots"
      :key="i"
      :cx="x * 100"
      :cy="y * 100"
      :r="shownValue === 1 ? 9 : shownValue === 6 ? 7 : 7.5"
      :fill="p.pip"
    />
  </svg>
</template>
