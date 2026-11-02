/**
 * T-A20, H-A7: время шага plant + twin. Цель: < 1 мс на 1000 узлов в Node (< 2 мс в Chrome).
 *   npx tsx scripts/perf.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTwin, resolveConfig, type PipelineConfigInput } from '../packages/core/src';
import { Plant, SimulatedSource } from '../packages/core/src/plant';

const ROOT = resolve(import.meta.dirname, '..');
const base = JSON.parse(readFileSync(resolve(ROOT, 'configs/pipeline.default.json'), 'utf8')) as PipelineConfigInput;

for (const nodes of [500, 1000, 2000]) {
  const input = { ...base, numerics: { dx: 50000 / nodes, frictionModel: 'colebrook' as const, thermalMode: 'quasi-steady' as const } };
  const cfg = resolveConfig(input).config;
  const plant = new Plant(cfg);
  for (let i = 0; i < 200; i++) plant.step();
  const n = 2000;
  let t0 = performance.now();
  for (let i = 0; i < n; i++) plant.step();
  const plantMs = (performance.now() - t0) / n;

  const src = new SimulatedSource(cfg, { seed: 1 });
  const frames = src.step(120);
  const twin = createTwin(cfg);
  for (const f of frames.slice(0, 100)) twin.predict(f);
  t0 = performance.now();
  for (const f of frames.slice(100)) twin.predict(f);
  const twinMs = (performance.now() - t0) / (frames.length - 100);
  console.log(`${String(nodes).padStart(5)} узлов: шаг plant ${plantMs.toFixed(3)} мс; twin на кадр ${twinMs.toFixed(3)} мс; вместе ${(plantMs + twinMs).toFixed(3)} мс`);
}
