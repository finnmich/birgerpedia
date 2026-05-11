#!/usr/bin/env node
// Smoke test for scripts/parse-article.mjs against the live corpus.
//
// Picks a stratified sample of articles (newest, middle, oldest, plus a
// known TV-series and game if present), re-parses their cached HTML, and
// checks that the resulting record has the fields a downstream page would
// expect. Exits non-zero on any failure so it can gate CI.
//
//   npm run smoke                      # default 5-record sample
//   npm run smoke -- --all             # parse every cached HTML, report bad ones
//   npm run smoke -- --id 1.17873593   # parse just one id

import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArticle } from './parse-article.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARTICLES_DIR = resolve(ROOT, 'data/raw/articles');

const argv = parseArgs(process.argv.slice(2));

const REQUIRED = ['id', 'name', 'type', 'rating', 'publishedAt'];

async function main() {
  const files = (await readdir(ARTICLES_DIR))
    .filter((f) => f.endsWith('.html'))
    .sort();

  if (!files.length) {
    console.error('No cached HTML in data/raw/articles/. Run `npm run crawl:articles` first.');
    process.exit(2);
  }

  // Choose what to parse
  let targets;
  if (argv.id) {
    targets = files.filter((f) => f.startsWith(argv.id + '.'));
    if (!targets.length) { console.error(`no cached HTML for id=${argv.id}`); process.exit(2); }
  } else if (argv.all) {
    targets = files;
  } else {
    // Stratified: newest 1, oldest 1, three at evenly-spaced indices
    const idx = (n) => Math.max(0, Math.min(files.length - 1, Math.round(n)));
    const picks = new Set([
      idx(0),
      idx(files.length * 0.25),
      idx(files.length * 0.5),
      idx(files.length * 0.75),
      idx(files.length - 1),
    ]);
    targets = [...picks].map((i) => files[i]);
  }

  let ok = 0, bad = 0;
  const issues = [];

  for (const f of targets) {
    const id = f.replace(/\.html$/, '');
    const html = await readFile(resolve(ARTICLES_DIR, f), 'utf8');
    const url = `https://www.nrk.no/__cached__/${id}`;
    const r = parseArticle(html, { url, id });
    const missing = r ? REQUIRED.filter((k) => r[k] == null) : REQUIRED;

    if (!r) {
      bad++;
      issues.push({ id, missing: ['(parser returned null — no Review JSON-LD)'] });
      console.log(`  ✗ ${id}  parser returned null`);
      continue;
    }
    if (missing.length) {
      bad++;
      issues.push({ id, missing });
      console.log(`  ✗ ${id}  missing: ${missing.join(', ')}`);
      continue;
    }
    ok++;
    if (!argv.all) {
      const dir = r.factbox?.regi ?? r.factbox?.serieskaper ?? '?';
      console.log(`  ✓ ${id}  "${r.name}" (${r.type}, rating ${r.rating}, ${dir})`);
    }
  }

  console.log('');
  console.log(`[smoke] parsed ${targets.length} HTML files: ${ok} OK, ${bad} bad.`);
  if (bad > 0) {
    if (argv.all) {
      console.log('First 10 issues:');
      for (const i of issues.slice(0, 10)) console.log(`  ${i.id}: ${i.missing.join(', ')}`);
    }
    process.exit(1);
  }
}

function parseArgs(args) {
  const out = { all: false, id: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--all') out.all = true;
    else if (a === '--id') out.id = args[++i];
  }
  return out;
}

main().catch((e) => { console.error(e); process.exit(1); });
