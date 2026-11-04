/**
 * ML-классификатор «утечка или отказ датчика» (H-B19): данные — прогоны симулятора, модель —
 * дерево решений глубины 3 по признакам события перед подтверждением утечки.
 *
 *   npx tsx scripts/train-event-classifier.ts collect --shard 0/4 --out results/ml/events-0.jsonl
 *   npx tsx scripts/train-event-classifier.ts fit --in 'results/ml/events-*.jsonl' --out configs/models/event-classifier.default.json
 *
 * Сценарии: утечки 1–12% по всей трубе, половина — у концов (там утечку почти один видит расходомер),
 * часть — сразу после смены режима насоса; отказы датчиков — скачок и дрейф на каждом датчике давления
 * и расхода, ±4…12σ. Пример — каждое событие, дошедшее до подтверждения утечки: метка «утечка», если
 * в трубе есть настоящая утечка, иначе «отказ». Обучение — на чётных зёрнах, проверка — на нечётных.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTwin, resolveConfig, type PipelineConfigInput, type ScenarioEvent } from '../packages/core/src';
import { Rng } from '../packages/core/src/math/rng';
import { SimulatedSource } from '../packages/core/src/plant';
import { createDetector, EVENT_FEATURES, leakProbability, type EventClassifierModel, type EventFeatureName, type EventTreeNode, type KnnLocatorModel, type StrategySpec } from '../packages/detect/src';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const SENSORS = ['p_in', 'p_km10', 'p_km25', 'p_out', 'q_in', 'q_out'];

interface Scen {
  n: number;
  seed: number;
  label: 'leak' | 'fault';
  noise: number;
  events: ScenarioEvent[];
  note: string;
}

function scenarios(base = 20261104): Scen[] {
  const rng = new Rng(base);
  const out: Scen[] = [];
  let n = 0;
  const noise = () => [0.1, 0.2, 0.3][rng.int(0, 2)]!;
  for (let k = 0; k < 240; k++) {
    const nearEnd = k % 2 === 0;
    const x = nearEnd ? (rng.uniform(0, 1) < 0.5 ? rng.uniform(1000, 8000) : rng.uniform(42000, 49000)) : rng.uniform(1000, 49000);
    const size = [1, 2, 3, 5, 8, 12][k % 6]!;
    const ev: ScenarioEvent[] = [];
    const afterPump = k % 5 === 0;
    if (afterPump) ev.push({ t: 115, type: 'pump', changePct: rng.uniform(-10, 10), rampSec: 3 });
    ev.push({ t: afterPump ? 120 + rng.uniform(0, 30) : 120, type: 'leak', x, sizePct: size, rampSec: k % 3 === 0 ? 30 : 0 });
    out.push({ n: n++, seed: base - 20261104 + 7000 + k, label: 'leak', noise: noise(), events: ev, note: `утечка ${size}% на ${(x / 1000).toFixed(1)} км${afterPump ? ' после насоса' : ''}` });
  }
  for (let rep = 0; rep < 2; rep++) {
    for (const id of SENSORS) {
      for (const mode of ['step', 'drift'] as const) {
        for (const mag of [-12, -8, -6, -4, 4, 6, 8, 12]) {
          out.push({ n: n++, seed: base - 20261104 + 8000 + n, label: 'fault', noise: noise(), events: [{ t: 120, type: 'sensor-fault', sensorId: id, mode, magnitude: mag, durationSec: 600 }], note: `${mode} ${mag > 0 ? '+' : ''}${mag}σ на ${id}` });
        }
      }
    }
  }
  return out;
}

const spec = JSON.parse(readFileSync(resolve(ROOT, 'configs/strategy.selected.json'), 'utf8')) as StrategySpec;
const ml = JSON.parse(readFileSync(resolve(ROOT, 'configs/models/locator.default.json'), 'utf8')) as KnnLocatorModel;

interface Sample {
  n: number;
  seed: number;
  label: 'leak' | 'fault';
  note: string;
  f: Record<EventFeatureName, number>;
}

/** Прогон сценария; признаки каждого события перед его подтверждением (и ложная ли утечка в итоге). */
export function runScenario(sc: Scen, classifier?: EventClassifierModel): { samples: Sample[]; leakConfirmed: boolean; faultFlagged: boolean } {
  const input = JSON.parse(readFileSync(resolve(ROOT, 'configs/pipeline.default.json'), 'utf8')) as PipelineConfigInput & { sensors: Array<Record<string, unknown>> };
  input.sensors = input.sensors.map((s) => (s.kind === 'T' ? s : { ...s, noisePct: sc.noise, noiseStd: undefined }));
  const cfg = resolveConfig(input).config;
  const truth = structuredClone(cfg);
  truth.geometry.roughness = 8e-5;
  const src = new SimulatedSource(truth, { seed: sc.seed, events: sc.events, durationSec: 420 });
  const twin = createTwin(cfg);
  const det = createDetector({ ...spec, warmupSec: 60 }, { mlLocator: ml, ...(classifier ? { eventClassifier: classifier } : {}) });
  det.reset({ config: cfg, sensors: cfg.sensors, sampleRateHz: cfg.sampling.rateHz, twin });
  const samples: Sample[] = [];
  let lastF: Record<EventFeatureName, number> | null = null;
  let lastT = -Infinity;
  let confirmedIds = new Set<string>();
  let leakConfirmed = false;
  let faultFlagged = false;
  while (!src.done) {
    for (const f of src.step(0.1)) {
      const o = det.update(f, twin.predict(f));
      if (f.t - lastT >= 1) {
        lastT = f.t;
        const ef = det.eventFeatures();
        if (ef) lastF = ef;
      }
      if (o.eventClass === 'sensor-fault' && f.t > 115) faultFlagged = true;
      for (const l of o.leaks ?? []) {
        if (l.state === 'confirmed' && !confirmedIds.has(l.id)) {
          confirmedIds.add(l.id);
          leakConfirmed = true;
          if (lastF && l.tAlarm >= 115) samples.push({ n: sc.n, seed: sc.seed, label: sc.label, note: sc.note, f: lastF });
        }
      }
    }
  }
  confirmedIds = new Set();
  return { samples, leakConfirmed, faultFlagged };
}

function collect(): void {
  const [i, n] = (opt('shard', '0/1') ?? '0/1').split('/').map(Number) as [number, number];
  const out = resolve(ROOT, opt('out', `results/ml/events-${i}.jsonl`)!);
  mkdirSync(dirname(out), { recursive: true });
  const lines: string[] = [];
  const list = scenarios().filter((s) => s.n % n === i);
  for (const sc of list) {
    const r = runScenario(sc);
    for (const s of r.samples) lines.push(JSON.stringify(s));
    process.stderr.write(`\r${sc.n}  `);
  }
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(`\n${lines.length} примеров → ${out}`);
}

function load(pattern: string): Sample[] {
  const dir = resolve(ROOT, dirname(pattern));
  const re = new RegExp(`^${basename(pattern).replace(/\./g, '\\.').replace('*', '.*')}$`);
  return readdirSync(dir)
    .filter((f) => re.test(f))
    .flatMap((f) => readFileSync(resolve(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Sample));
}

/** Признаки, которые дерево не использует: скачок граничного давления зависит от того, как насос держит напор (см. H-B19). */
const EXCLUDED: EventFeatureName[] = ['boundaryJump'];
const COST_LEAK = 10;
const DEPTH = 3;
const MIN_LEAF = 4;

/** Дерево решений (CART, индекс Джини) с ценой ошибки: потерянная утечка в COST_LEAK раз дороже. */
function buildTree(S: Sample[], feats: EventFeatureName[], depth: number, wLeak: number, wFault: number): EventTreeNode {
  const w = (s: Sample) => (s.label === 'leak' ? wLeak : wFault);
  const gini = (set: Sample[]) => {
    const a = set.reduce((acc, s) => acc + (s.label === 'leak' ? w(s) : 0), 0);
    const t = set.reduce((acc, s) => acc + w(s), 0);
    return { g: t ? 1 - (a / t) ** 2 - (1 - a / t) ** 2 : 0, t, a };
  };
  const here = gini(S);
  const leaf: EventTreeNode = { p: here.t ? here.a / here.t : 0.5, n: S.length };
  if (depth === 0 || S.length < 2 * MIN_LEAF || leaf.p === 0 || leaf.p === 1) return leaf;
  let best: { g: number; f: EventFeatureName; th: number; le: Sample[]; gt: Sample[] } | null = null;
  for (const f of feats) {
    const vals = [...new Set(S.map((s) => s.f[f]))].sort((u, v) => u - v);
    for (let k = 0; k + 1 < vals.length; k++) {
      const th = (vals[k]! + vals[k + 1]!) / 2;
      const le = S.filter((s) => s.f[f] <= th);
      const gt = S.filter((s) => s.f[f] > th);
      if (le.length < MIN_LEAF || gt.length < MIN_LEAF) continue;
      const l = gini(le);
      const r = gini(gt);
      const g = (l.g * l.t + r.g * r.t) / (l.t + r.t);
      if (!best || g < best.g) best = { g, f, th, le, gt };
    }
  }
  if (!best || best.g >= here.g) return leaf;
  return { feature: best.f, threshold: Number(best.th.toFixed(4)), le: buildTree(best.le, feats, depth - 1, wLeak, wFault), gt: buildTree(best.gt, feats, depth - 1, wLeak, wFault) };
}

function treeModel(S: Sample[], note: string): EventClassifierModel {
  const feats = EVENT_FEATURES.filter((f) => !EXCLUDED.includes(f));
  const nLeak = S.filter((s) => s.label === 'leak').length;
  const nFault = S.length - nLeak;
  return { kind: 'tree', version: 1, features: feats, root: buildTree(S, feats, DEPTH, COST_LEAK, nLeak / Math.max(1, nFault)), threshold: 0.5, costLeak: COST_LEAK, trainedOn: note };
}

function printTree(n: EventTreeNode, ind = ''): void {
  if (!('feature' in n)) return console.log(`${ind}→ P(утечка) = ${n.p.toFixed(2)} (${n.n} событий)`);
  console.log(`${ind}${n.feature} ≤ ${n.threshold}?`);
  printTree(n.le, `${ind}  да: `);
  printTree(n.gt, `${ind}  нет: `);
}

function report(model: EventClassifierModel, set: Sample[], name: string): void {
  const leaks = set.filter((s) => s.label === 'leak');
  const faults = set.filter((s) => s.label === 'fault');
  const lost = leaks.filter((s) => leakProbability(model, s.f) < model.threshold);
  const caught = faults.filter((s) => leakProbability(model, s.f) < model.threshold);
  console.log(`${name}: утечек ${leaks.length}, потеряно ${lost.length}; отказов, дошедших до «утечки», ${faults.length}, распознано ${caught.length}`);
  for (const s of lost) console.log(`  потеряна: ${s.note}`);
  for (const s of faults.filter((s) => !caught.includes(s))) console.log(`  пропущен отказ: ${s.note}`);
}

function fit(): void {
  const all = load(opt('in', 'results/ml/events-*.jsonl')!);
  const train = all.filter((s) => s.seed % 2 === 0);
  const test = all.filter((s) => s.seed % 2 === 1);
  // проверка честная: дерево на чётных зёрнах, оценка на нечётных
  const half = treeModel(train, 'половина');
  report(half, train, 'обучение (чётные зёрна)');
  report(half, test, 'проверка (нечётные зёрна)');
  // в работу — дерево на всех данных
  const nLeak = all.filter((s) => s.label === 'leak').length;
  const model = treeModel(all, `${all.length} событий симулятора (утечки ${nLeak}, отказы датчиков ${all.length - nLeak}), ${new Date().toISOString().slice(0, 10)}`);
  console.log('\nдерево на всех данных:');
  printTree(model.root);
  report(model, all, 'все данные');
  const out = opt('out');
  if (out) {
    writeFileSync(resolve(ROOT, out), JSON.stringify(model, null, 1) + '\n');
    console.log(`модель → ${out}`);
  }
}

/**
 * Проверка системы целиком на новых сценариях (другое зерно генератора): сколько настоящих утечек
 * подтверждено и сколько отказов датчиков закончились подтверждённой «утечкой» — без модели и с ней.
 */
function evaluate(): void {
  const [i, n] = (opt('shard', '0/1') ?? '0/1').split('/').map(Number) as [number, number];
  const model = JSON.parse(readFileSync(resolve(ROOT, opt('model', 'configs/models/event-classifier.default.json')!), 'utf8')) as EventClassifierModel;
  const list = scenarios(Number(opt('base', '20261105'))).filter((s) => s.n % n === i);
  const lines: string[] = [];
  for (const sc of list) {
    const a = runScenario(sc);
    const b = runScenario(sc, model);
    lines.push(JSON.stringify({ n: sc.n, label: sc.label, note: sc.note, without: a.leakConfirmed, with: b.leakConfirmed, flagged: b.faultFlagged }));
    process.stderr.write(`\r${sc.n}  `);
  }
  const out = resolve(ROOT, opt('out', `results/ml/events-eval-${i}.jsonl`)!);
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(`\n${lines.length} сценариев → ${out}`);
}

const cmd = args[0];
if (cmd === 'collect') collect();
else if (cmd === 'fit') fit();
else if (cmd === 'eval') evaluate();
else console.error('команды: collect | fit | eval');
