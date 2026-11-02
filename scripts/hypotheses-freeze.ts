/**
 * H-A6: онлайн-подстройка смещений невязки не «съедает» утечку, если замораживается при подозрении.
 * Утечка 2% в 100 с, наблюдение 600 с: доля времени в тревоге и средний z давления на км 25.
 *   npx tsx scripts/hypotheses-freeze.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTwin, resolveConfig } from '../packages/core/src';
import { SimulatedSource } from '../packages/core/src/plant';
import { createDetector, defaultStrategy } from '../packages/detect/src';

const ROOT = resolve(import.meta.dirname, '..');
const cfg = resolveConfig(JSON.parse(readFileSync(resolve(ROOT, 'configs/pipeline.default.json'), 'utf8'))).config;
const truth = structuredClone(cfg);
truth.geometry.roughness = 8e-5;

for (const variant of ['с заморозкой', 'без заморозки', 'быстрая подстройка без заморозки'] as const) {
  const src = new SimulatedSource(truth, { seed: 77, events: [{ t: 100, type: 'leak', x: 23000, sizePct: 2, rampSec: 0 }], durationSec: 700 });
  const twin = createTwin(cfg);
  const det = createDetector({ ...defaultStrategy('cusum'), params: { drift: 0.5, h: 29 } }, variant === 'быстрая подстройка без заморозки' ? { preprocess: { baselineTauSec: 30 } } : {});
  det.reset({ config: cfg, sensors: cfg.sensors, sampleRateHz: 10, twin });
  if (variant !== 'с заморозкой') det.preprocessor.freeze = () => undefined; // подстройка не останавливается
  let inAlarm = 0;
  let total = 0;
  const zLate: number[] = [];
  let first: number | null = null;
  while (!src.done) for (const f of src.step(0.1)) {
    const o = det.update(f, twin.predict(f));
    if (f.t > 100) {
      total++;
      if (o.alarm) {
        inAlarm++;
        first ??= o.t;
      }
      if (f.t > 500 && o.z?.p_km25 !== undefined) zLate.push(o.z.p_km25);
    }
  }
  const zMean = zLate.reduce((a, b) => a + b, 0) / Math.max(1, zLate.length);
  console.log(`H-A6 ${variant}: тревога через ${first === null ? '—' : (first - 100).toFixed(1)} с; в тревоге ${((inAlarm / total) * 100).toFixed(0)}% времени после утечки; средний z(p_km25) через 400–600 с: ${zMean.toFixed(2)}`);
}
