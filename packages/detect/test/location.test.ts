/**
 * Интервал места (H-B13) и ML-оценка (H-B12). Тест знает правду из plant; детектор — только кадры.
 */
import { describe, expect, it } from 'vitest';
import { createTwin, type DetectorOutput } from '@pipetwin/core';
import { SimulatedSource } from '@pipetwin/core/plant';
import { createDetector, featureVector, KnnLocator, quantile, type KnnLocatorModel } from '../src';
import { ctxFor, defaultConfig, readJson } from './helpers';

function run(x: number, sizePct: number, seed: number, withMl: boolean): Array<DetectorOutput & { since: number }> {
  const cfg = defaultConfig();
  const truth = structuredClone(cfg);
  truth.geometry.roughness = 8e-5;
  const src = new SimulatedSource(truth, { seed, events: [{ t: 90, type: 'leak', x, sizePct, rampSec: 0 }], durationSec: 230 });
  const twin = createTwin(cfg);
  const spec = readJson<Parameters<typeof createDetector>[0]>('configs/strategy.selected.json');
  const det = createDetector({ ...spec, warmupSec: 60 }, withMl ? { mlLocator: readJson<KnnLocatorModel>('configs/models/locator.default.json') } : {});
  det.reset(ctxFor(cfg, twin));
  const outs: Array<DetectorOutput & { since: number }> = [];
  let tA: number | null = null;
  while (!src.done) {
    for (const f of src.step(0.1)) {
      const o = det.update(f, twin.predict(f));
      if (o.alarm && tA === null && f.t >= 90) tA = o.t;
      if (tA !== null && o.alarm) outs.push({ ...o, since: o.t - tA });
    }
  }
  return outs;
}

describe('H-B13 интервал места сужается и содержит истину', () => {
  it('утечка 10%: при тревоге — отрезок у датчика, через ~10 с — по волне, ≤ 2 км, истина внутри', () => {
    const x = 31000;
    const outs = run(x, 10, 7, false);
    expect(outs.length).toBeGreaterThan(0);
    const first = outs[0]!;
    expect(first.locationInterval).toBeDefined();
    expect(first.locationStage).toBe('segment');
    const [lo0, hi0] = first.locationInterval!;
    expect(lo0).toBeLessThanOrEqual(x);
    expect(hi0).toBeGreaterThanOrEqual(x);
    const later = outs.find((o) => o.since >= 15)!;
    expect(later.locationStage).toBe('wave');
    const [lo, hi] = later.locationInterval!;
    expect(hi - lo).toBeLessThan(2000);
    expect(hi - lo).toBeLessThan(hi0 - lo0);
    expect(lo).toBeLessThanOrEqual(x);
    expect(hi).toBeGreaterThanOrEqual(x);
  });

  it('с ML-моделью в первые секунды стадия ml, зона уже отрезка', () => {
    const outs = run(18000, 2, 3, true);
    const early = outs.filter((o) => o.since >= 2 && o.since <= 15 && o.locationStage === 'ml');
    expect(early.length).toBeGreaterThan(0);
    const seg = outs[0]!.locationInterval!;
    const ml = early.at(-1)!.locationInterval!;
    expect(ml[1] - ml[0]).toBeLessThanOrEqual(seg[1] - seg[0] + 1);
  });
});

describe('H-B12 ML-оценка места (k ближайших соседей)', () => {
  const base: KnnLocatorModel = {
    kind: 'knn-locator',
    version: 1,
    pipeline: { name: 't', length: 1000, sensorIds: ['a', 'b'], pressureIds: ['a', 'b'] },
    weights: { shape: 1, arrival: 1, time: 0 },
    k: 3,
    quantiles: [0, 1],
    coverage: 0.9,
    X: [],
    y: [],
  };
  const f = (za: number, zb: number) => ({ z: { a: za, b: zb }, first: {}, sinceAlarm: 0, transit: 1 });

  it('интервал — разброс мест у ближайших примеров', () => {
    const X = [f(-1, 0), f(-0.9, -0.1), f(-0.8, -0.2), f(0, -1), f(-0.1, -0.9)].map((s) => featureVector(base, s)!);
    const loc = new KnnLocator({ ...base, X, y: [0.1, 0.15, 0.2, 0.9, 0.85] });
    const r = loc.locate(f(-0.95, -0.05))!;
    expect(r.interval[0]).toBeCloseTo(100, 6);
    expect(r.interval[1]).toBeCloseTo(200, 6);
    expect(r.x).toBeCloseTo(150, 6);
  });

  it('модель не применяется к другой трубе', () => {
    expect(KnnLocator.fits(base, 1000, ['a', 'b', 'c'])).toBe(true);
    expect(KnnLocator.fits(base, 2000, ['a', 'b'])).toBe(false);
    expect(KnnLocator.fits(base, 1000, ['a'])).toBe(false);
  });

  it('квантиль с интерполяцией', () => {
    expect(quantile([3, 1, 2], 0.5)).toBe(2);
    expect(quantile([0, 10], 0.25)).toBe(2.5);
  });
});

describe('калибровка слияния «ИЛИ»', () => {
  it('масштабирует пороги участников, а не число голосов', async () => {
    const { scaleThreshold } = await import('../src');
    const spec = {
      strategy: 'fusion' as const,
      params: { thr: 1, minVotes: 1 },
      fusionRule: 'vote' as const,
      members: [
        { detector: 'cusum' as const, params: { drift: 0.5, h: 50 }, weight: 1 },
        { detector: 'ewma' as const, params: { tauSec: 3, L: 9 }, weight: 1 },
      ],
      localization: 'lsq' as const,
      signatureFilter: true,
      warmupSec: 60,
    };
    const s = scaleThreshold(spec, 1.2);
    expect(s.params.minVotes).toBe(1);
    expect(s.members![0]!.params!.h).toBeCloseTo(60, 6);
    expect(s.members![1]!.params!.L).toBeCloseTo(10.8, 6);
    expect(s.members![0]!.params!.drift).toBe(0.5);
  });
});

describe('несколько утечек подряд и их устранение', () => {
  it('две утечки 5%: обе найдены и подтверждены, каждая снимается сама после устранения, затем норма', () => {
    const cfg = defaultConfig();
    const truth = structuredClone(cfg);
    truth.geometry.roughness = 8e-5;
    const src = new SimulatedSource(truth, {
      seed: 4,
      events: [
        { t: 90, type: 'leak', id: 'A', x: 31000, sizePct: 5, rampSec: 0 },
        { t: 450, type: 'leak', id: 'B', x: 12000, sizePct: 5, rampSec: 0 },
      ],
      durationSec: 1150,
    });
    const twin = createTwin(cfg);
    const spec = readJson<Parameters<typeof createDetector>[0]>('configs/strategy.selected.json');
    const det = createDetector({ ...spec, warmupSec: 60 });
    det.reset(ctxFor(cfg, twin));
    const seen = new Map<string, { states: Set<string>; lo: number; hi: number }>();
    let activeAt = (t: number) => false as boolean;
    const timeline: Array<{ t: number; ids: string[] }> = [];
    while (!src.done) {
      for (const f of src.step(0.1)) {
        if (Math.abs(f.t - 700) < 0.05) src.removeLeak('A');
        if (Math.abs(f.t - 900) < 0.05) src.removeLeak('B');
        const o = det.update(f, twin.predict(f));
        for (const l of o.leaks ?? []) {
          const e = seen.get(l.id) ?? { states: new Set<string>(), lo: NaN, hi: NaN };
          e.states.add(l.state);
          if (l.locationInterval) [e.lo, e.hi] = l.locationInterval;
          seen.set(l.id, e);
        }
        timeline.push({ t: f.t, ids: (o.leaks ?? []).map((l) => l.id) });
      }
    }
    activeAt = (t: number) => (timeline.find((x) => x.t >= t)?.ids.length ?? 0) > 0;
    // ровно две утечки, обе подтверждены, зоны содержат истину
    expect([...seen.keys()]).toEqual(['L1', 'L2']);
    expect(seen.get('L1')!.states.has('confirmed')).toBe(true);
    expect(seen.get('L2')!.states.has('confirmed')).toBe(true);
    expect(seen.get('L1')!.lo).toBeLessThanOrEqual(31000);
    expect(seen.get('L1')!.hi).toBeGreaterThanOrEqual(31000);
    expect(seen.get('L2')!.lo).toBeLessThanOrEqual(12000);
    expect(seen.get('L2')!.hi).toBeGreaterThanOrEqual(12000);
    // после устранения A остаётся одна B; после устранения B — норма
    expect(timeline.find((x) => x.t >= 880)!.ids).toEqual(['L2']);
    expect(activeAt(1100)).toBe(false);
  });
});

describe('одновременные утечки и снятие всех сразу', () => {
  function runScenario(events: Array<{ t: number; id: string; x: number; size: number }>, removals: Record<number, string[]>, dur: number, seed = 4) {
    const cfg = defaultConfig();
    const truth = structuredClone(cfg);
    truth.geometry.roughness = 8e-5;
    const src = new SimulatedSource(truth, { seed, events: events.map((e) => ({ t: e.t, type: 'leak' as const, id: e.id, x: e.x, sizePct: e.size, rampSec: 0 })), durationSec: dur });
    const twin = createTwin(cfg);
    const spec = readJson<Parameters<typeof createDetector>[0]>('configs/strategy.selected.json');
    const det = createDetector({ ...spec, warmupSec: 60 });
    det.reset(ctxFor(cfg, twin));
    const timeline: Array<{ t: number; leaks: DetectorOutput['leaks']; unhealthy: string[] }> = [];
    while (!src.done) {
      for (const f of src.step(0.1)) {
        for (const [tt, ids] of Object.entries(removals)) if (Math.abs(f.t - Number(tt)) < 0.05) for (const id of ids) src.removeLeak(id);
        const o = det.update(f, twin.predict(f));
        timeline.push({ t: f.t, leaks: o.leaks ?? [], unhealthy: o.unhealthySensors ?? [] });
      }
    }
    const at = (t: number) => timeline.find((x) => x.t >= t)!.leaks ?? [];
    return Object.assign(at, { unhealthy: () => new Set(timeline.flatMap((x) => x.unhealthy)) });
  }

  it('две одновременные утечки (км 31 и 12) делятся на две с верными зонами; снятые по одной — норма', () => {
    const at = runScenario([{ t: 90, id: 'A', x: 31000, size: 5 }, { t: 90, id: 'B', x: 12000, size: 5 }], { 700: ['A'], 900: ['B'] }, 1150);
    const both = at(400);
    expect(both.length).toBe(2);
    const zones = both.map((l) => l.locationInterval!).sort((a, b) => a[0] - b[0]);
    expect(zones[0]![0]).toBeLessThanOrEqual(12000);
    expect(zones[0]![1]).toBeGreaterThanOrEqual(12000);
    expect(zones[1]![0]).toBeLessThanOrEqual(31000);
    expect(zones[1]![1]).toBeGreaterThanOrEqual(31000);
    const left = at(880);
    expect(left.length).toBe(1);
    expect(left[0]!.locationInterval![0]).toBeLessThanOrEqual(12000);
    expect(left[0]!.locationInterval![1]).toBeGreaterThanOrEqual(12000);
    expect(at(1140).length).toBe(0);
  });

  it('три утечки подряд, снятые все сразу, — система сама возвращается к норме', () => {
    const at = runScenario(
      [
        { t: 90, id: 'A', x: 31000, size: 5 },
        { t: 450, id: 'B', x: 12000, size: 5 },
        { t: 810, id: 'C', x: 44000, size: 10 },
      ],
      { 1200: ['A', 'B', 'C'] },
      1450,
    );
    expect(at(1150).length).toBe(3);
    expect(at(1440).length).toBe(0);
  });

  it('утечка у входа (км 3) после другой: расходомер на входе не объявляется отказавшим, обе снимаются', () => {
    // её почти один видит расходомер на входе; прежде монитор отказов исключал его — утечка терялась,
    // а без баланса расходов снятие не распознавалось, и первая авария висела
    const at = runScenario([{ t: 90, id: 'A', x: 31000, size: 3 }, { t: 330, id: 'B', x: 3000, size: 3 }], { 830: ['A', 'B'] }, 1060, 5);
    const both = at(800);
    expect(both.length).toBe(2);
    expect(both.some((l) => l.locationInterval![0] <= 3000 && l.locationInterval![1] >= 3000)).toBe(true);
    expect(at.unhealthy().has('q_in')).toBe(false);
    expect(at(1050).length).toBe(0);
  });
});
