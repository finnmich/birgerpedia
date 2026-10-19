/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

declare module '*.json' {
  const value: any;
  export default value;
}

// Content hash of public/data/*.json, injected by astro.config.mjs.
declare const __DATA_VERSION__: string;
