#!/usr/bin/env node
// Reorganize local imports in TS files:
//   - Leaves framework/external imports (non-relative paths) untouched at top.
//   - Groups local imports (starting with './' or '../') by category:
//       enums -> models -> services -> components -> other
//   - Alphabetizes within each group by the source path.
//   - Separates groups with a single blank line. No comments.
//
// Usage: node scripts/reorganize-imports.mjs [path]
//   defaults to src/app

import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || 'src/app';

const importRegex = /^\s*import(?:\s+type)?\s+[^'"]*from\s+['"]([^'"]+)['"]\s*;?\s*$/;

function classify(srcPath) {
  // Use the source path to categorize. Fall back to "other".
  if (/\.enum(?:['"]|\.ts)?$/.test(srcPath) || /\/enums?\//.test(srcPath)) return 'enum';
  if (/\.model(?:['"]|\.ts)?$/.test(srcPath) || /\.type(?:['"]|\.ts)?$/.test(srcPath) || /\/models?\//.test(srcPath)) return 'model';
  if (/\.service(?:['"]|\.ts)?$/.test(srcPath)) return 'service';
  if (/\.component(?:['"]|\.ts)?$/.test(srcPath)) return 'component';
  return 'other';
}

function isLocal(p) {
  return p.startsWith('./') || p.startsWith('../');
}

function extractImports(lines) {
  // Walk lines until we hit a non-import, non-blank, non-comment line.
  // Returns { startIdx, endIdx, items: [{ raw, path, isLocal }] }.
  const items = [];
  let i = 0;
  let lastImportLine = -1;
  while (i < lines.length) {
    const line = lines[i];
    // Skip leading blank lines / comments at the very top.
    if (line.trim() === '' || /^\s*\/\//.test(line) || /^\s*\/\*/.test(line)) {
      // Stop scanning if we've already collected imports and now hit non-import content.
      // But blank lines/comments between imports are fine — just skip.
      i++;
      continue;
    }
    if (/^\s*import\b/.test(line)) {
      // Collect potentially multi-line import (ends with `;`).
      const startIdx = i;
      let buf = line;
      while (!/;\s*$/.test(buf) && i + 1 < lines.length) {
        i++;
        buf += '\n' + lines[i];
      }
      const m = buf.match(/from\s+['"]([^'"]+)['"]\s*;?\s*$/m);
      if (!m) {
        // Couldn't parse — bail out and don't touch this file.
        return null;
      }
      const p = m[1];
      items.push({ raw: buf, path: p, isLocal: isLocal(p), startIdx, endIdx: i });
      lastImportLine = i;
      i++;
    } else {
      // Non-import, non-blank, non-comment line — imports are done.
      break;
    }
  }
  if (items.length === 0) return null;
  return { lastImportLine, items };
}

function reorganize(content) {
  const lines = content.split(/\r?\n/);
  const ex = extractImports(lines);
  if (!ex) return null;

  const { lastImportLine, items } = ex;

  const framework = items.filter(it => !it.isLocal);
  const local = items.filter(it => it.isLocal);

  // If there are no local imports, nothing to do.
  if (local.length === 0) return null;

  // Preserve framework imports in their original order.
  const fwBlock = framework.map(it => it.raw).join('\n');

  // Group local by category.
  const buckets = { enum: [], model: [], service: [], component: [], other: [] };
  for (const it of local) buckets[classify(it.path)].push(it);
  // Alphabetize within each bucket by source path.
  for (const k of Object.keys(buckets)) {
    buckets[k].sort((a, b) => a.path.localeCompare(b.path));
  }
  const order = ['enum', 'model', 'service', 'component', 'other'];
  const localBlocks = order
    .map(k => buckets[k].map(it => it.raw).join('\n'))
    .filter(s => s.length > 0);

  const newHeader =
    (fwBlock ? fwBlock + '\n\n' : '') +
    localBlocks.join('\n\n');

  // Replace lines 0..lastImportLine with newHeader.
  const rest = lines.slice(lastImportLine + 1).join('\n');
  // Ensure exactly one blank line between header and rest.
  const trimmedRest = rest.replace(/^\s*\n+/, '');
  return newHeader + '\n\n' + trimmedRest;
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
}

const files = [];
walk(root, files);

let changed = 0;
let skipped = 0;
for (const f of files) {
  const content = fs.readFileSync(f, 'utf8');
  let next;
  try {
    next = reorganize(content);
  } catch (err) {
    console.error('skip (error):', f, err.message);
    skipped++;
    continue;
  }
  if (next == null) {
    continue;
  }
  if (next !== content) {
    fs.writeFileSync(f, next, 'utf8');
    changed++;
  }
}
console.log(`changed: ${changed}, skipped: ${skipped}, scanned: ${files.length}`);
