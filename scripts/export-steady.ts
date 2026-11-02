/**
 * Экспорт стационарных профилей TS-ядра для сверки с эталоном на SciPy (T-A19):
 *   npx tsx scripts/export-steady.ts > profiles.json
 * Для каждого эталонного конфига: разрешённый конфиг (СИ), режим и профиль p, T по сетке.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PipeModel, resolveConfig, steadyForward, type PipelineConfigInput } from '../packages/core/src';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8')) as PipelineConfigInput;

const cases: Array<{ name: string; input: PipelineConfigInput; pIn: number; q: number }> = [
  { name: 'default', input: read('configs/pipeline.default.json'), pIn: 4e6, q: 0.32 },
  { name: 'passport', input: read('configs/pipeline.example.json'), pIn: 3.9e6, q: 0.3 },
  { name: 'water-flat', input: { schemaVersion: 1, geometry: { length: '20 км', diameter: '0,4 м' }, fluid: { name: 'water' }, numerics: { dx: 50, frictionModel: 'colebrook', thermalMode: 'none' } }, pIn: 3e6, q: 0.2 },
  { name: 'heavy-laminar', input: { schemaVersion: 1, geometry: { length: '80 км', diameter: '0,5 м' }, fluid: { name: 'heavy-crude' }, boundary: { inletTemp: '70 °C' } }, pIn: 8e6, q: 0.08 },
  { name: 'hilly-diesel', input: { schemaVersion: 1, geometry: { length: '60 км', diameter: '0,3 м', elevation: [['0 км', '50 м'], ['20 км', '300 м'], ['40 км', '120 м'], ['60 км', '80 м']] }, fluid: { name: 'diesel' } }, pIn: 6e6, q: 0.09 },
];

const out = cases.map((c) => {
  const cfg = resolveConfig(c.input).config;
  const model = new PipeModel(cfg);
  const Tin = model.inletTemp(0);
  const m = model.fluid.rho(Tin) * c.q;
  const s = steadyForward(model, c.pIn, m, Tin);
  return { name: c.name, config: cfg, pIn: c.pIn, mIn: m, Tin, x: Array.from(s.x), p: Array.from(s.p), T: Array.from(s.T) };
});
process.stdout.write(JSON.stringify(out));
