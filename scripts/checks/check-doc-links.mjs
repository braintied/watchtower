#!/usr/bin/env node
// Harness standard: docs are CI-checked like code.
// Validates relative markdown links in docs/ + README.md + CLAUDE.md +
// AGENTS.md against the filesystem, with a RATCHET baseline
// (.doc-links-baseline at repo root): the broken-link count may only
// decrease. Covers inline links (incl. balanced-paren and <angle-bracket>
// targets) AND reference-style definitions ([x]: path).
//
// Usage: node scripts/checks/check-doc-links.mjs [repoRoot] [--update-baseline|--rebaseline]
//   default:            read-only gate — fails on regression, never writes
//                       (exception: writes the FIRST baseline if none exists,
//                       so init→verify works out of the box)
//   --update-baseline:  tighten the ratchet after improvements
//   --rebaseline:       recompute + overwrite the baseline explicitly (accepts
//                       an INCREASE — the deliberate escape hatch when links
//                       were knowingly restructured; exits 0)
// Skips: http(s)/mailto/tel links, pure anchors (#…), code fences.

import { readFileSync, readdirSync, lstatSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

function collectMarkdown(dir, out) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) {
      try {
        stats = statSync(path);
      } catch {
        // Dangling symlink to a .md file — report it as a broken "link".
        if (entry.endsWith('.md')) out.push({ path, dangling: true });
        continue;
      }
    }
    if (stats.isDirectory()) collectMarkdown(path, out);
    else if (entry.endsWith('.md')) out.push({ path, dangling: false });
  }
  return out;
}

// Extract inline-link targets with balanced parentheses: after "](", scan to
// the matching close paren (one nesting level is enough for real-world paths
// like foo_(bar).md). Angle-bracket form: ](<target with spaces>).
function extractInlineTargets(text) {
  const targets = [];
  let index = 0;
  while (true) {
    const open = text.indexOf('](', index);
    if (open === -1) break;
    let cursor = open + 2;
    if (text[cursor] === '<') {
      const close = text.indexOf('>', cursor);
      if (close !== -1) {
        targets.push(text.slice(cursor + 1, close));
        index = close + 1;
        continue;
      }
    }
    let depth = 1;
    let target = '';
    while (cursor < text.length && depth > 0) {
      const ch = text[cursor];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      } else if (ch === '\n') break;
      target += ch;
      cursor += 1;
    }
    if (depth === 0 && target !== '') {
      // Strip optional title: [x](path "title")
      targets.push(target.split(/\s+"/)[0].trim());
    }
    index = cursor + 1;
  }
  return targets;
}

const REFERENCE_DEF_RE = /^\[[^\]]+\]:\s+(\S+)/gm;

// Read-only scan: returns the broken-link descriptions without touching the
// baseline. Exported so `harness audit --deep` can reuse the exact link
// logic without mutating the repo (the ratchet stays the CLI's business).
// Does `resolved` sit outside the repository root? Compared on normalised
// absolute paths with a trailing separator, so a sibling directory whose name
// merely starts with the root's name (…/Braintied-old) is not mistaken for a
// path inside …/Braintied.
export function escapesRoot(root, resolved) {
  const base = resolve(root);
  const target = resolve(resolved);
  return target !== base && !target.startsWith(base + sep);
}

export function scanBrokenLinks(root) {
  const files = [];
  for (const top of ['README.md', 'CLAUDE.md', 'AGENTS.md']) {
    const path = join(root, top);
    if (existsSync(path)) files.push({ path, dangling: false });
  }
  // Fleet reality: most repos use docs/, some (kulti) use Docs/. Take the
  // ACTUAL entry name from readdir — probing both would double-collect the
  // same tree on case-insensitive filesystems (macOS).
  let rootEntries = [];
  try {
    rootEntries = readdirSync(root);
  } catch {
    rootEntries = [];
  }
  for (const docsName of rootEntries.filter((entry) => entry === 'docs' || entry === 'Docs')) {
    collectMarkdown(join(root, docsName), files);
  }

  const broken = [];
  for (const file of files) {
    const relative = file.path.replace(root + '/', '');
    if (file.dangling) {
      broken.push(`${relative} (dangling symlink)`);
      continue;
    }
    const raw = readFileSync(file.path, 'utf8');
    const text = raw.replace(/```[\s\S]*?```/g, '');
    const targets = extractInlineTargets(text);
    let match;
    while ((match = REFERENCE_DEF_RE.exec(text)) !== null) {
      targets.push(match[1]);
    }
    for (const target of targets) {
      if (/^(https?:|mailto:|#|tel:)/.test(target)) continue;
      const clean = target.split('#')[0];
      if (clean === '') continue;
      const resolved = clean.startsWith('/')
        ? join(root, clean)
        : join(dirname(file.path), clean);
      // A link that escapes the repository cannot be judged by the repository's
      // own gate: whether it resolves depends entirely on where the repo happens
      // to be checked out. Braintied's strategy docs deliberately point at
      // sibling repos (`../../Kit/docs/north-star.md`), which resolve from
      // ~/Development/Braintied and from nowhere else — so the same commit was
      // green in the canonical checkout and RED in a fresh worktree, reported as
      // four broken links that are not broken.
      //
      // Skipped rather than followed. Calling these broken is false, and
      // "fixing" them would mean deleting real cross-repo references.
      if (escapesRoot(root, resolved)) continue;
      if (!existsSync(resolved)) {
        broken.push(`${relative} → ${target}`);
      }
    }
  }
  return broken;
}

function main() {
  const argv = process.argv.slice(2);
  const update = argv.includes('--update-baseline');
  const rebaseline = argv.includes('--rebaseline');
  const rootArg = argv.find((arg) => !arg.startsWith('--'));
  const root = resolve(rootArg !== undefined ? rootArg : '.');
  const baselineFile = join(root, '.doc-links-baseline');

  const broken = scanBrokenLinks(root);

  let baseline = null;
  if (existsSync(baselineFile)) {
    const parsed = Number(readFileSync(baselineFile, 'utf8').trim());
    baseline = Number.isFinite(parsed) ? parsed : null;
  }

  if (rebaseline) {
    writeFileSync(baselineFile, String(broken.length) + '\n');
    console.log(`check-doc-links: rebaselined to ${broken.length} (was ${baseline === null ? 'none' : baseline}) — commit .doc-links-baseline.`);
    for (const line of broken) console.log(`  ${line}`);
    process.exit(0);
  }

  if (baseline === null) {
    writeFileSync(baselineFile, String(broken.length) + '\n');
    console.log(`check-doc-links: baseline written (${broken.length} broken). Commit .doc-links-baseline; the ratchet only decreases.`);
    for (const line of broken) console.log(`  ${line}`);
    process.exit(0);
  }

  if (broken.length > baseline) {
    console.error(`check-doc-links: ${broken.length} broken links (baseline ${baseline}) — new breakage:`);
    for (const line of broken) console.error(`  ${line}`);
    process.exit(1);
  }

  if (broken.length < baseline) {
    if (update) {
      writeFileSync(baselineFile, String(broken.length) + '\n');
      console.log(`check-doc-links: improved ${baseline} → ${broken.length}; ratchet tightened (baseline rewritten — commit it).`);
    } else {
      console.log(`check-doc-links: ok — improved to ${broken.length} (baseline ${baseline}). Tighten with --update-baseline.`);
    }
  } else {
    console.log(`check-doc-links: ok (${broken.length}/${baseline} baseline)`);
  }
  for (const line of broken) console.log(`  still broken: ${line}`);
}

if (process.argv[1] !== undefined &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
