import { mkdir, writeFile, rename, readFile, access, readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tiny .env loader — only handles `KEY=value` lines, no quoting magic.
// Variables already in process.env win.
function loadDotEnv() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = resolve(here, '..', '.env');
    const text = readFileSync(path, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch { /* no .env, fine */ }
}
loadDotEnv();

export const USER_AGENT =
  'birgerpedia-research/0.1 (homage fan project; +mailto:finnmich@gmail.com)';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RateLimiter {
  constructor({ minIntervalMs = 1000 } = {}) {
    this.min = minIntervalMs;
    this.next = 0;
  }
  async wait() {
    const now = Date.now();
    const wait = Math.max(0, this.next - now);
    this.next = Math.max(now, this.next) + this.min;
    if (wait > 0) await sleep(wait);
  }
}

/**
 * Polite, retrying fetch.
 *
 * `redact` is a string (or array of strings) to scrub from every log message
 * before it's emitted. Use this for API keys that we have to embed in the
 * URL (looking at you, OMDb) — without it, a 429 in CI dumps the key into
 * public Actions logs. Each redacted string is replaced with `***`.
 */
export async function politeFetch(url, { limiter, retries = 4, headers = {}, redact, ...rest } = {}) {
  if (limiter) await limiter.wait();

  const redactList = redact == null ? [] : (Array.isArray(redact) ? redact : [redact]).filter(Boolean);
  const scrub = (s) => {
    let out = String(s);
    for (const secret of redactList) {
      if (secret) out = out.split(secret).join('***');
    }
    return out;
  };

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...rest,
        headers: { 'User-Agent': USER_AGENT, ...headers },
      });
      if (res.status === 429 || res.status >= 500) {
        const backoff = Math.min(60_000, 2_000 * 2 ** attempt);
        console.warn(`  [${res.status}] ${scrub(url)} — backing off ${backoff}ms (attempt ${attempt + 1}/${retries + 1})`);
        await sleep(backoff);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${scrub(url)}`);
      return res;
    } catch (err) {
      lastErr = err;
      const backoff = Math.min(60_000, 2_000 * 2 ** attempt);
      console.warn(`  [err] ${scrub(url)}: ${scrub(err.message)} — backing off ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr ?? new Error(`giving up on ${scrub(url)}`);
}

export async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

export async function atomicWrite(path, contents) {
  await ensureDir(dirname(path));
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await fsp.writeFile(tmp, contents);
  await fsp.rename(tmp, path);
}

export async function atomicWriteJson(path, obj) {
  await atomicWrite(path, JSON.stringify(obj, null, 2));
}

export async function readJsonIfExists(path) {
  try {
    const buf = await fsp.readFile(path, 'utf8');
    return JSON.parse(buf);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function fileExists(path) {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

// 1.17873593  ←  …/anmeldelse_-_…-1.17873593
export function idFromUrl(url) {
  const m = /-(\d+\.\d+)(?:[.?#]|$)/.exec(url);
  return m ? m[1] : null;
}
