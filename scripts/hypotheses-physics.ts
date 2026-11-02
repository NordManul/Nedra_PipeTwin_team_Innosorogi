/**
 * Измерения для гипотез по физике (results/physics/README.md):
 *   H-A1 — нужен ли нестационарный twin (ложные тревоги на смене режима, время детекции);
 *   H-A2 — точность и скорость явных формул трения против Коулбрука;
 *   H-A3 — влияет ли вязкость от температуры на прогноз сильнее шума;
 *   H-A5 — прогноз промежуточных давлений без расходомеров против шума датчика.
 *   npx tsx scripts/hypotheses-physics.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { colebrook, createTwin, haaland, resolveConfig, swameeJain, type PipelineConfig, type PipelineConfigInput, type ScenarioEvent } from '../packages/core/src';
import { SimulatedSource } from '../packages/core/src/plant';
import { createDetector, defaultStrategy } from '../packages/detect/src';

const ROOT = resolve(import.meta.dirname, '..');
const input = JSON.parse(readFileSync(resolve(ROOT, 'configs/pipeline.default.json'), 'utf8')) as PipelineConfigInput;
const base = resolveConfig(input).config;
const truth = structuredClone(base);
truth.geometry.roughness = 8e-5;

// H-A2
{
  let maxSj = 0;
  let maxHa = 0;
  for (let lr = 3; lr <= 7; lr += 0.1) for (let le = -6; le <= -2; le += 0.25) {
    const Re = 10 ** lr;
    const rr = 10 ** le;
    const c = colebrook(Re, rr);
    maxSj = Math.max(maxSj, Math.abs(swameeJain(Re, rr) / c - 1));
    maxHa = Math.max(maxHa, Math.abs(haaland(Re, rr) / c - 1));
  }
  const time = (f: (a: number, b: number) => number) => {
    const n = 300000;
    let s = 0;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) s += f(1e4 + i, 1e-4);
    return ((performance.now() - t0) / n) * 1e6 + s * 0;
  };
  // Re ≥ 4000 — турбулентная область формул (ниже — общий ламинарный и переходный участок)
  console.log(`H-A2: ошибка λ относительно Коулбрука при Re 1e3–1e7: Свами–Джейн ≤ ${(maxSj * 100).toFixed(2)}%, Хааланд ≤ ${(maxHa * 100).toFixed(2)}%`);
  console.log(`H-A2: время вызова, нс: Коулбрук ${time(colebrook).toFixed(0)}, Свами–Джейн ${time(swameeJain).toFixed(0)}, Хааланд ${time(haaland).toFixed(0)}`);
}

// H-A3: прогноз p_km25 с теплом и без против шума датчика
{
  const iso = structuredClone(base);
  iso.numerics.thermalMode = 'none';
  const frames = new SimulatedSource(base, { seed: 5 }).step(30);
  const a = createTwin(base);
  const b = createTwin(iso);
  let d = 0;
  for (const f of frames) {
    const pa = a.predict(f);
    const pb = b.predict(f);
    if (pa.ok && pb.ok) d = Math.abs(pa.values.p_km25! - pb.values.p_km25!);
  }
  const sigma = base.sensors.find((s) => s.id === 'p_km25')!.noiseStd;
  console.log(`H-A3: разница прогноза p_km25 с учётом тепла и без: ${(d / 1000).toFixed(1)} кПа = ${(d / sigma).toFixed(1)} σ шума датчика`);
}

// H-A5: невязка промежуточных давлений, twin только по давлениям на концах
{
  const noQ: PipelineConfig = { ...base, sensors: base.sensors.filter((s) => s.kind !== 'q') };
  const tr: PipelineConfig = { ...truth, sensors: truth.sensors.filter((s) => s.kind !== 'q') };
  const frames = new SimulatedSource(tr, { seed: 6 }).step(300);
  const twin = createTwin(noQ);
  const res: number[] = [];
  for (const f of frames) {
    const p = twin.predict(f);
    if (p.ok && f.t > 20) res.push(f.values.p_km25! - p.values.p_km25!);
  }
  const m = res.reduce((a, b) => a + b, 0) / res.length;
  const sd = Math.sqrt(res.reduce((a, b) => a + (b - m) ** 2, 0) / res.length);
  const sigma = base.sensors.find((s) => s.id === 'p_km25')!.noiseStd;
  console.log(`H-A5: без расходомеров невязка p_km25: смещение ${(m / 1000).toFixed(1)} кПа (${(m / sigma).toFixed(2)} σ), разброс ${(sd / sigma).toFixed(2)} σ шума датчика`);
}

// H-A1: стационарный и нестационарный twin — смена режима без утечки и утечка 5%
{
  const run = (model: 'steady' | 'transient', events: ScenarioEvent[], dur: number, seed: number) => {
    const cfg = structuredClone(base);
    cfg.twin.model = model;
    const src = new SimulatedSource(truth, { seed, events, durationSec: dur });
    const twin = createTwin(cfg);
    const det = createDetector({ ...defaultStrategy('cusum'), params: { drift: 0.5, h: 29 } });
    det.reset({ config: cfg, sensors: cfg.sensors, sampleRateHz: 10, twin });
    let first: number | null = null;
    let alarms = 0;
    let was = false;
    while (!src.done) for (const f of src.step(0.1)) {
      const o = det.update(f, twin.predict(f));
      if (o.alarm && !was) {
        alarms++;
        first ??= o.t;
      }
      was = o.alarm;
    }
    return { first, alarms };
  };
  for (const model of ['steady', 'transient'] as const) {
    const reg = [101, 102, 103].map((s) => run(model, [{ t: 90, type: 'pump', changePct: 10, rampSec: 3 }, { t: 200, type: 'valve', opening: 0.6, rampSec: 5 }], 330, s).alarms);
    const leak = [101, 102, 103].map((s) => run(model, [{ t: 80, type: 'leak', x: 25000, sizePct: 5, rampSec: 0 }], 140, s).first);
    console.log(`H-A1: twin ${model}: ложных тревог на смене режима ${reg.join('+')} (3 прогона); TTD утечки 5%: ${leak.map((t) => (t === null ? 'пропуск' : (t - 80).toFixed(1))).join(', ')} с`);
  }
}
