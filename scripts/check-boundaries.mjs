#!/usr/bin/env node
/**
 * Проверка границы честности (ТЗ, раздел 7.2): из кода детектора не достижим plant —
 * ни прямым импортом, ни транзитивно. Строит граф импортов от точек входа детектора.
 *   node scripts/check-boundaries.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN = resolve(ROOT, 'packages/core/src/plant');
const ENTRIES = ['packages/detect/src/index.ts', 'apps/web/src/engine/detect-engine.ts', 'apps/web/src/engine/detect.worker.ts'];
const ALIASES = {
  '@pipetwin/core': 'packages/core/src/index.ts',
  '@pipetwin/core/contracts': 'packages/core/src/contracts.ts',
  '@pipetwin/core/plant': 'packages/core/src/plant/index.ts',
  '@pipetwin/detect': 'packages/detect/src/index.ts',
  '@pipetwin/io': 'packages/io/src/index.ts',
  '@pipetwin/bench': 'packages/bench/src/index.ts',
};
const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveSpec(spec, from) {
  if (ALIASES[spec]) return resolve(ROOT, ALIASES[spec]);
  if (!spec.startsWith('.')) return null; // внешний пакет
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}/index.ts`]) if (existsSync(c) && !c.endsWith('/')) if (c.endsWith('.ts') || c.endsWith('.json')) return c;
  return null;
}

const errors = [];
for (const entry of ENTRIES) {
  const start = resolve(ROOT, entry);
  const seen = new Map([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const file = queue.shift();
    if (file.startsWith(FORBIDDEN)) {
      const chain = [];
      for (let f = file; f; f = seen.get(f)) chain.unshift(relative(ROOT, f));
      errors.push(`${entry}: достижим plant — ${chain.join(' → ')}`);
      continue;
    }
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const m of src.matchAll(IMPORT_RE)) {
      const target = resolveSpec(m[1] ?? m[2], file);
      if (target && !seen.has(target)) {
        seen.set(target, file);
        queue.push(target);
      }
    }
  }
  if (!errors.some((e) => e.startsWith(entry))) console.log(`ok  ${entry}: файлов в графе ${seen.size}, plant не достижим`);
}
if (errors.length) {
  for (const e of errors) console.error(`ОШИБКА ${e}`);
  process.exit(1);
}
