/**
 * Обучение ML-оценки места (H-B12): k ближайших соседей по форме отклика датчиков.
 *
 *   npx tsx scripts/train-ml-locator.ts collect --split train --n 300 --shard 0/4 --out results/ml/train-0.jsonl
 *   npx tsx scripts/train-ml-locator.ts fit --train 'results/ml/train-*.jsonl' --val results/ml/val-0.jsonl [--max-dt 24]
 *   npx tsx scripts/train-ml-locator.ts eval --model configs/models/locator.default.json --data results/ml/test-0.jsonl
 *
 * collect: прогоны симулятора с утечкой в случайном месте (2–98% длины), размером 0,5–20% (лог-равномерно),
 *          шумом 0,1–0,5%, нарастанием 0 или 30 с; «настоящая» шероховатость отличается от модели.
 *          После тревоги каждые 2 с (до 120 с) пишутся признаки детектора и истинное место.
 *          Наборы train / val / test — на разных seed.
 * fit:     подбор весов групп признаков, k и квантилей по валидации (цель — покрытие 90% при наименьшей ширине).
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTwin, resolveConfig, type PipelineConfigInput } from '../packages/core/src';
import { Rng } from '../packages/core/src/math/rng';
import { SimulatedSource } from '../packages/core/src/plant';
import { createDetector, type StrategySpec } from '../packages/detect/src';
import { featureVector, KnnLocator, quantile, type KnnLocatorModel, type LocatorFeatures } from '../packages/detect/src/ml/knn-locator';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const SPLIT_SEED = { train: 11000, val: 22000, test: 33000 } as const;

interface Sample {
  x: number;
  size: number;
  noise: number;
  run: number;
  dt: number;
  f: LocatorFeatures;
}

function pipelineInput(): PipelineConfigInput {
  return JSON.parse(readFileSync(resolve(ROOT, opt('config', 'configs/pipeline.default.json')!), 'utf8')) as PipelineConfigInput;
}

function collect(): void {
  const split = opt('split', 'train') as keyof typeof SPLIT_SEED;
  const n = Number(opt('n', '100'));
  const [shard, shards] = (opt('shard', '0/1') ?? '0/1').split('/').map(Number) as [number, number];
  const out = resolve(ROOT, opt('out', `results/ml/${split}-${shard}.jsonl`)!);
  mkdirSync(dirname(out), { recursive: true });
  const input = pipelineInput();
  const spec = JSON.parse(readFileSync(resolve(ROOT, 'configs/strategy.selected.json'), 'utf8')) as StrategySpec;
  const lines: string[] = [];
  for (let run = shard; run < n; run += shards) {
    const rng = new Rng(SPLIT_SEED[split] + run * 7919);
    const noise = [0.1, 0.2, 0.3, 0.5][Math.floor(rng.uniform(0, 1) * 4)]!;
    const inp = structuredClone(input) as PipelineConfigInput & { sensors: Array<Record<string, unknown>> };
    inp.sensors = inp.sensors.map((s) => (s.kind === 'T' ? s : { ...s, noisePct: noise, noiseStd: undefined }));
    const cfg = resolveConfig(inp).config;
    const truth = structuredClone(cfg);
    truth.geometry.roughness = cfg.geometry.roughness * (1.2 + 0.6 * rng.uniform(0, 1));
    const L = cfg.geometry.length;
    const x = L * (0.02 + 0.96 * rng.uniform(0, 1));
    const size = Math.exp(Math.log(0.5) + (Math.log(20) - Math.log(0.5)) * rng.uniform(0, 1));
    const ramp = rng.uniform(0, 1) < 0.7 ? 0 : 30;
    const tL = 90;
    const src = new SimulatedSource(truth, { seed: SPLIT_SEED[split] + run, events: [{ t: tL, type: 'leak', x, sizePct: size, rampSec: ramp }], durationSec: tL + 60 + ramp + 125 });
    const twin = createTwin(cfg);
    const det = createDetector({ ...spec, warmupSec: 60 });
    det.reset({ config: cfg, sensors: cfg.sensors, sampleRateHz: cfg.sampling.rateHz, twin });
    let tA: number | null = null;
    let next = 0;
    while (!src.done) {
      for (const f of src.step(0.1)) {
        const o = det.update(f, twin.predict(f));
        if (o.alarm && f.t < tL) continue;
        if (o.alarm && tA === null) tA = o.t;
        if (tA !== null && o.alarm && o.t - tA >= next && next <= 120) {
          const feat = det.locatorFeatures(o.t);
          if (feat) lines.push(JSON.stringify({ x: x / L, size, noise, run, dt: next, f: feat } satisfies Sample));
          next += 2;
        }
      }
    }
    process.stderr.write(`${split} ${run}: x=${(x / 1000).toFixed(1)} км, ${size.toFixed(1)}%, шум ${noise}%, тревога ${tA === null ? 'нет' : `через ${(tA - tL).toFixed(1)} с`}\n`);
  }
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(`записано ${lines.length} примеров в ${out}`);
}

function load(pattern: string): Sample[] {
  const files = pattern.includes('*')
    ? readdirSync(resolve(ROOT, dirname(pattern)))
        .filter((f) => new RegExp(`^${basename(pattern).replace(/\./g, '\\.').replace('*', '.*')}$`).test(f))
        .map((f) => resolve(ROOT, dirname(pattern), f))
    : [resolve(ROOT, pattern)];
  return files.flatMap((f) =>
    readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Sample),
  );
}

function baseModel(input: PipelineConfigInput): Omit<KnnLocatorModel, 'X' | 'y' | 'weights' | 'k' | 'quantiles' | 'coverage'> {
  const cfg = resolveConfig(input).config;
  const sensorIds = cfg.sensors.filter((s) => s.kind !== 'T').map((s) => s.id);
  const pressureIds = cfg.sensors.filter((s) => s.kind === 'p').map((s) => s.id);
  return { kind: 'knn-locator', version: 1, pipeline: { name: cfg.meta.name, length: cfg.geometry.length, sensorIds, pressureIds } };
}

/** Покрытие, медиана ширины и ошибки на наборе (доли длины). */
function evaluate(model: KnnLocatorModel, data: Sample[]) {
  const loc = new KnnLocator(model);
  const L = model.pipeline.length;
  let hit = 0;
  const widths: number[] = [];
  const errs: number[] = [];
  for (const s of data) {
    const r = loc.locate(s.f);
    if (!r) continue;
    const x = s.x * L;
    if (r.interval[0] <= x && x <= r.interval[1]) hit++;
    widths.push((r.interval[1] - r.interval[0]) / L);
    errs.push(Math.abs(r.x - x) / L);
  }
  const med = (a: number[]) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)] ?? NaN;
  return { n: widths.length, coverage: hit / Math.max(1, widths.length), width: med(widths), err: med(errs) };
}

function fit(): void {
  const input = pipelineInput();
  // ML-стадия работает только в первые секунды тревоги (pipeline.ts, ML_UNTIL_TRANSITS) — учим на этом окне
  const maxDt = Number(opt('max-dt', '24'));
  const train = load(opt('train', 'results/ml/train-*.jsonl')!).filter((s) => s.dt <= maxDt);
  const val = load(opt('val', 'results/ml/val-*.jsonl')!).filter((s) => s.dt <= maxDt);
  const target = Number(opt('coverage', '0.9'));
  const base = baseModel(input);
  const X: number[][] = [];
  const y: number[] = [];
  for (const s of train) {
    const v = featureVector(base, s.f);
    if (!v) continue;
    X.push(v.map((a) => Math.round(a * 1e3) / 1e3));
    y.push(Math.round(s.x * 1e4) / 1e4);
  }
  console.log(`обучение: ${X.length} примеров из ${new Set(train.map((s) => s.run)).size} прогонов; валидация: ${val.length}`);
  let best: { model: KnnLocatorModel; width: number; coverage: number; err: number } | null = null;
  // валидация — каждый 3-й пример (соседние по времени примеры одного прогона почти одинаковы)
  const vs = val;
  const KS = [15, 30, 60];
  const QS = [0.05, 0.03, 0.02, 0.01, 0.005, 0];
  for (const shape of [1, 2, 4])
    for (const arrival of [0, 0.5, 1, 2])
      for (const time of [0, 0.3, 1]) {
        const probe: KnnLocatorModel = { ...base, weights: { shape, arrival, time }, k: Math.max(...KS), quantiles: [0, 1], coverage: target, X, y };
        const loc = new KnnLocator(probe);
        const nbr = vs.map((s) => {
          const v = featureVector(base, s.f);
          return v ? { x: s.x, ys: loc.neighbors(v) } : null;
        }).filter((r): r is { x: number; ys: number[] } => r !== null);
        for (const k of KS) {
          // квантили расширяем, пока покрытие на валидации не дойдёт до цели
          for (const q of QS) {
            let hit = 0;
            const widths: number[] = [];
            const errs: number[] = [];
            for (const r of nbr) {
              const ys = r.ys.slice(0, k);
              const lo = quantile(ys, q);
              const hi = quantile(ys, 1 - q);
              if (lo <= r.x && r.x <= hi) hit++;
              widths.push(hi - lo);
              errs.push(Math.abs(quantile(ys, 0.5) - r.x));
            }
            const coverage = hit / Math.max(1, nbr.length);
            if (coverage >= target) {
              const width = quantile(widths, 0.5);
              if (!best || width < best.width) best = { model: { ...probe, k, quantiles: [q, 1 - q] }, width, coverage, err: quantile(errs, 0.5) };
              break;
            }
          }
        }
        process.stderr.write(`веса ${shape}/${arrival}/${time}: лучшая ширина пока ${best ? ((best.width * base.pipeline.length) / 1000).toFixed(2) : '—'} км\n`);
      }
  if (!best) throw new Error('не удалось добиться нужного покрытия на валидации');
  const L = base.pipeline.length;
  console.log(
    `лучшее: веса ${JSON.stringify(best.model.weights)}, k=${best.model.k}, квантили ${best.model.quantiles.join('–')}: ` +
      `покрытие ${(best.coverage * 100).toFixed(0)}%, ширина мед ${((best.width * L) / 1000).toFixed(2)} км, ошибка мед ${((best.err * L) / 1000).toFixed(2)} км`,
  );
  const out = resolve(ROOT, opt('out', 'configs/models/locator.default.json')!);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(best.model) + '\n');
  console.log(`модель: ${out}`);
}

function evalCmd(): void {
  const model = JSON.parse(readFileSync(resolve(ROOT, opt('model', 'configs/models/locator.default.json')!), 'utf8')) as KnnLocatorModel;
  const data = load(opt('data', 'results/ml/test-*.jsonl')!);
  const L = model.pipeline.length;
  for (const dt of [0, 4, 10, 16, 20]) {
    const r = evaluate(model, data.filter((s) => s.dt === dt));
    console.log(`+${dt} с: n=${r.n}, покрытие ${(r.coverage * 100).toFixed(0)}%, ширина мед ${((r.width * L) / 1000).toFixed(2)} км, ошибка мед ${((r.err * L) / 1000).toFixed(2)} км`);
  }
}

const cmd = args[0];
if (cmd === 'collect') collect();
else if (cmd === 'fit') fit();
else if (cmd === 'eval') evalCmd();
else console.error('команды: collect | fit | eval');
