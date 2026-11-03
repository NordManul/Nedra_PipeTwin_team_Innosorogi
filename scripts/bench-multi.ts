/**
 * Стенд нескольких утечек (H-B15): одновременные пары, утечки подряд, снятие части и всех сразу,
 * одиночные контрольные (не должны делиться), прогоны без утечек со сменами режима (не должно быть фантомов).
 *
 *   npx tsx scripts/bench-multi.ts run --shard 0/4 --out results/multi/runs-0.jsonl [--kind simultaneous,single]
 *   npx tsx scripts/bench-multi.ts report --in 'results/multi/runs-*.jsonl'
 *
 * Детектор видит только кадры датчиков; правда (места, время начала и снятия) — у стенда.
 * Метрики по каждой истинной утечке и по каждому снятию:
 *   найдена — до первого снятия (или к концу) есть активная утечка, чья зона содержит истинное место;
 *   разделены — у одновременной пары обе утечки найдены разными записями;
 *   фантом — активная утечка, зона которой не содержит ни одной действующей истинной;
 *   снятие распознано — через RECHECK_SEC после снятия активных записей столько же, сколько действующих
 *   утечек, и каждая действующая покрыта; время — до первого такого момента.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTwin, resolveConfig, type ActiveLeak, type PipelineConfigInput, type ScenarioEvent } from '../packages/core/src';
import { Rng } from '../packages/core/src/math/rng';
import { SimulatedSource } from '../packages/core/src/plant';
import { createDetector, type KnnLocatorModel, type StrategySpec } from '../packages/detect/src';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
/** Через сколько секунд после снятия проверять, что система поняла его. */
const RECHECK_SEC = 240;
const L = 50000;

type Kind = 'simultaneous' | 'sequential' | 'all-at-once' | 'single' | 'no-leak';
interface TrueLeak {
  id: string;
  t: number;
  x: number;
  size: number;
  /** Когда сняли. */
  off?: number;
}
interface Scen {
  n: number;
  kind: Kind;
  seed: number;
  noise: number;
  leaks: TrueLeak[];
  regimes: ScenarioEvent[];
  duration: number;
}

function scenarios(): Scen[] {
  const rng = new Rng(20261103);
  const out: Scen[] = [];
  const place = (avoid: number[], sep: number) => {
    for (;;) {
      const x = rng.uniform(2000, 48000);
      if (avoid.every((a) => Math.abs(a - x) >= sep)) return x;
    }
  };
  const size = () => [3, 5, 8, 12][rng.int(0, 3)]!;
  const noise = () => [0.1, 0.2, 0.3][rng.int(0, 2)]!;
  let n = 0;
  // одновременные пары: начало с разницей 0–5 с, снимаем по одной
  for (let k = 0; k < 70; k++) {
    const x1 = place([], 0);
    const x2 = place([x1], 8000);
    const t2 = 90 + rng.uniform(0, 5);
    out.push({ n: n++, kind: 'simultaneous', seed: 1000 + k, noise: noise(), duration: 1100, regimes: [], leaks: [{ id: 'A', t: 90, x: x1, size: size(), off: 600 }, { id: 'B', t: t2, x: x2, size: size(), off: 800 }] });
  }
  // подряд: 2–3 утечки через 5–6 мин, снимаем случайную часть, потом остальные
  for (let k = 0; k < 60; k++) {
    const m = rng.int(2, 3);
    const xs: number[] = [];
    const leaks: TrueLeak[] = [];
    for (let i = 0; i < m; i++) {
      const x = place(xs, 6000);
      xs.push(x);
      leaks.push({ id: 'ABC'[i]!, t: 90 + i * rng.uniform(300, 360), x, size: size() });
    }
    const t1 = leaks.at(-1)!.t + 360;
    const first = new Set(leaks.filter(() => rng.uniform(0, 1) < 0.5).map((l) => l.id));
    if (!first.size) first.add(leaks[0]!.id);
    if (first.size === leaks.length) first.delete(leaks.at(-1)!.id);
    for (const l of leaks) l.off = first.has(l.id) ? t1 : t1 + 300;
    out.push({ n: n++, kind: 'sequential', seed: 2000 + k, noise: noise(), duration: t1 + 600, regimes: [], leaks });
  }
  // подряд, сняли все сразу
  for (let k = 0; k < 40; k++) {
    const m = rng.int(2, 3);
    const xs: number[] = [];
    const leaks: TrueLeak[] = [];
    for (let i = 0; i < m; i++) {
      const x = place(xs, 6000);
      xs.push(x);
      leaks.push({ id: 'ABC'[i]!, t: 90 + i * rng.uniform(300, 360), x, size: size() });
    }
    const t1 = leaks.at(-1)!.t + 360;
    for (const l of leaks) l.off = t1;
    out.push({ n: n++, kind: 'all-at-once', seed: 3000 + k, noise: noise(), duration: t1 + 400, regimes: [], leaks });
  }
  // одиночные контрольные
  for (let k = 0; k < 40; k++) {
    out.push({ n: n++, kind: 'single', seed: 4000 + k, noise: noise(), duration: 900, regimes: [], leaks: [{ id: 'A', t: 90, x: place([], 0), size: [2, 3, 5, 8, 12, 20][k % 6]!, off: 600 }] });
  }
  // без утечек, 20 минут со сменами режима
  for (let k = 0; k < 20; k++) {
    const regimes: ScenarioEvent[] = [
      { t: 150, type: 'pump', changePct: rng.uniform(-12, 12), rampSec: 3 },
      { t: 450, type: 'valve', opening: rng.uniform(0.55, 1), rampSec: 5 },
      { t: 800, type: 'pump', changePct: rng.uniform(-12, 12), rampSec: 3 },
    ];
    out.push({ n: n++, kind: 'no-leak', seed: 5000 + k, noise: noise(), duration: 1200, regimes, leaks: [] });
  }
  return out;
}

interface Snapshot {
  t: number;
  leaks: Array<Pick<ActiveLeak, 'id' | 'state'> & { lo: number; hi: number }>;
}

function runOne(sc: Scen, spec: StrategySpec, ml: KnnLocatorModel | undefined): Snapshot[] {
  const input = JSON.parse(readFileSync(resolve(ROOT, 'configs/pipeline.default.json'), 'utf8')) as PipelineConfigInput & { sensors: Array<Record<string, unknown>> };
  input.sensors = input.sensors.map((s) => (s.kind === 'T' ? s : { ...s, noisePct: sc.noise, noiseStd: undefined }));
  const cfg = resolveConfig(input).config;
  const truth = structuredClone(cfg);
  truth.geometry.roughness = 8e-5;
  const events: ScenarioEvent[] = [...sc.leaks.map((l) => ({ t: l.t, type: 'leak' as const, id: l.id, x: l.x, sizePct: l.size, rampSec: 0 })), ...sc.regimes];
  const src = new SimulatedSource(truth, { seed: sc.seed, events, durationSec: sc.duration });
  const twin = createTwin(cfg);
  const det = createDetector({ ...spec, warmupSec: 60 }, ml ? { mlLocator: ml } : {});
  det.reset({ config: cfg, sensors: cfg.sensors, sampleRateHz: cfg.sampling.rateHz, twin });
  const snaps: Snapshot[] = [];
  let next = 0;
  while (!src.done) {
    for (const f of src.step(0.1)) {
      for (const l of sc.leaks) if (l.off !== undefined && Math.abs(f.t - l.off) < 0.05) src.removeLeak(l.id);
      const o = det.update(f, twin.predict(f));
      if (f.t >= next) {
        next += 1;
        snaps.push({ t: f.t, leaks: (o.leaks ?? []).map((l) => ({ id: l.id, state: l.state, lo: l.locationInterval?.[0] ?? 0, hi: l.locationInterval?.[1] ?? L })) });
      }
    }
  }
  return snaps;
}

function run(): void {
  const [shard, shards] = (opt('shard', '0/1') ?? '0/1').split('/').map(Number) as [number, number];
  const out = resolve(ROOT, opt('out', `results/multi/runs-${shard}.jsonl`)!);
  mkdirSync(dirname(out), { recursive: true });
  const spec = JSON.parse(readFileSync(resolve(ROOT, 'configs/strategy.selected.json'), 'utf8')) as StrategySpec;
  const mlPath = resolve(ROOT, 'configs/models/locator.default.json');
  const ml = JSON.parse(readFileSync(mlPath, 'utf8')) as KnnLocatorModel;
  const lines: string[] = [];
  const kinds = opt('kind')?.split(',');
  for (const sc of scenarios().filter((s) => s.n % shards === shard && (!kinds || kinds.includes(s.kind)))) {
    const snaps = runOne(sc, spec, ml);
    lines.push(JSON.stringify({ sc, snaps }));
    process.stderr.write(`${sc.n} ${sc.kind}\n`);
  }
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(`записано ${lines.length} сценариев в ${out}`);
}

// ---------------------------------------------------------------- оценка

const covers = (s: Snapshot['leaks'][number], x: number) => s.lo <= x && x <= s.hi;
const active = (sc: Scen, t: number) => sc.leaks.filter((l) => l.t <= t && (l.off === undefined || t < l.off));

interface Eval {
  kind: Kind;
  found: boolean[];
  /** Время до первой записи, покрывающей утечку, с. */
  findSec: Array<number | null>;
  split?: boolean;
  /** Фантомы — по всем секундам, когда действующих утечек нет или запись не покрывает ни одну. */
  phantomSec: number;
  removals: Array<{ ok: boolean; sec: number | null }>;
  finalOk: boolean;
}

function evaluate(sc: Scen, snaps: Snapshot[]): Eval {
  const at = (t: number) => snaps.find((s) => s.t >= t) ?? snaps.at(-1)!;
  const firstOff = Math.min(...sc.leaks.map((l) => l.off ?? Infinity), sc.duration);
  // найдена: до первого снятия есть подтверждённая или уточняемая запись, покрывающая место
  const found = sc.leaks.map((l) => snaps.some((s) => s.t >= l.t && s.t < Math.min(l.off ?? Infinity, firstOff) && s.leaks.some((e) => covers(e, l.x) && e.hi - e.lo < 0.9 * L)));
  const findSec = sc.leaks.map((l) => {
    const s = snaps.find((q) => q.t >= l.t && q.leaks.some((e) => covers(e, l.x) && e.hi - e.lo < 0.9 * L));
    return s ? s.t - l.t : null;
  });
  let split: boolean | undefined;
  if (sc.kind === 'simultaneous') {
    const before = snaps.filter((s) => s.t > 300 && s.t < firstOff - 5);
    split = before.some((s) => {
      const conf = s.leaks.filter((e) => e.state === 'confirmed');
      if (conf.length < 2) return false;
      const a = conf.findIndex((e) => covers(e, sc.leaks[0]!.x));
      const b = conf.findIndex((e, i) => i !== a && covers(e, sc.leaks[1]!.x));
      return a >= 0 && b >= 0;
    });
  }
  // фантомы: подтверждённые записи, которые не покрывают ни одной действующей утечки (вне переходных 300 с после снятий)
  let phantomSec = 0;
  for (const s of snaps) {
    const recentOff = sc.leaks.some((l) => l.off !== undefined && s.t >= l.off && s.t < l.off + RECHECK_SEC);
    if (recentOff) continue;
    const act = active(sc, s.t);
    if (s.leaks.some((e) => e.state === 'confirmed' && !act.some((l) => covers(e, l.x)))) phantomSec++;
  }
  // снятия: моменты снятия (группами)
  const offs = [...new Set(sc.leaks.map((l) => l.off).filter((v): v is number => v !== undefined))].sort((a, b) => a - b);
  const removals = offs.map((t) => {
    const rest = active(sc, t + 1);
    const ok = (s: Snapshot) => s.leaks.length === rest.length && rest.every((l) => s.leaks.some((e) => covers(e, l.x)));
    const s = snaps.find((q) => q.t > t && q.t <= t + RECHECK_SEC && ok(q));
    return { ok: ok(at(t + RECHECK_SEC)) || !!s, sec: s ? s.t - t : null };
  });
  const finalOk = (snaps.at(-1)?.leaks.length ?? 0) === active(sc, sc.duration).length;
  return { kind: sc.kind, found, findSec, ...(split !== undefined ? { split } : {}), phantomSec, removals, finalOk };
}

function report(): void {
  const pattern = opt('in', 'results/multi/runs-*.jsonl')!;
  const dir = resolve(ROOT, dirname(pattern));
  const re = new RegExp(`^${basename(pattern).replace(/\./g, '\\.').replace('*', '.*')}$`);
  const rows = readdirSync(dir)
    .filter((f) => re.test(f))
    .flatMap((f) => readFileSync(resolve(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { sc: Scen; snaps: Snapshot[] }));
  const ev = rows.map((r) => ({ sc: r.sc, e: evaluate(r.sc, r.snaps) }));
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}% (${a}/${b})` : '—');
  const med = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]! : NaN);
  const lines: string[] = ['| Набор | Сценариев | Утечки найдены, место в зоне | Пара разделена | Снятие распознано | Время распознавания, медиана | Секунд с фантомом | Итог верный |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];
  const names: Record<Kind, string> = { simultaneous: 'Одновременные пары, снятие по одной', sequential: '2–3 подряд, снятие части, потом остальных', 'all-at-once': '2–3 подряд, снятие всех сразу', single: 'Одиночные (контроль)', 'no-leak': 'Без утечек, смены режима (20 мин)' };
  for (const kind of Object.keys(names) as Kind[]) {
    const g = ev.filter((x) => x.e.kind === kind);
    if (!g.length) continue;
    const f = g.flatMap((x) => x.e.found);
    const sp = g.filter((x) => x.e.split !== undefined);
    const rem = g.flatMap((x) => x.e.removals);
    const secs = rem.map((r) => r.sec).filter((v): v is number => v !== null);
    const ph = g.reduce((a, x) => a + x.e.phantomSec, 0);
    lines.push(
      `| ${names[kind]} | ${g.length} | ${f.length ? pct(f.filter(Boolean).length, f.length) : '—'} | ${sp.length ? pct(sp.filter((x) => x.e.split).length, sp.length) : '—'} | ${rem.length ? pct(rem.filter((r) => r.ok).length, rem.length) : '—'} | ${secs.length ? `${Math.round(med(secs))} с` : '—'} | ${ph} | ${pct(g.filter((x) => x.e.finalOk).length, g.length)} |`,
    );
  }
  // разделение пар по размеру и по тому, разделены ли утечки датчиком давления
  const sensors = [0, 10000, 25000, 50000];
  const between = (a: number, b: number) => sensors.some((s) => s > Math.min(a, b) && s < Math.max(a, b));
  const sim = ev.filter((x) => x.e.kind === 'simultaneous');
  const sepd = sim.filter((x) => between(x.sc.leaks[0]!.x, x.sc.leaks[1]!.x));
  const same = sim.filter((x) => !between(x.sc.leaks[0]!.x, x.sc.leaks[1]!.x));
  lines.push('', `Одновременные пары: между утечками есть датчик давления — разделено ${pct(sepd.filter((x) => x.e.split).length, sepd.length)}; обе между одними датчиками — ${pct(same.filter((x) => x.e.split).length, same.length)} (физически почти неразличимы).`);
  for (const s of [3, 5, 8, 12]) {
    const g = sepd.filter((x) => Math.min(x.sc.leaks[0]!.size, x.sc.leaks[1]!.size) === s);
    if (g.length) lines.push(`- меньшая из пары ${s}%: разделено ${pct(g.filter((x) => x.e.split).length, g.length)}`);
  }
  const text = lines.join('\n');
  console.log(text);
  const out = opt('out');
  if (out) writeFileSync(resolve(ROOT, out), text + '\n');
}

const cmd = args[0];
if (cmd === 'run') run();
else if (cmd === 'report') report();
else console.error('команды: run | report');
