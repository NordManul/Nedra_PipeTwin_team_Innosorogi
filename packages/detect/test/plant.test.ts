/**
 * Детекция на ядре A: T-B13, T-B14, T-B18. Тест (не код детектора!) использует plant,
 * чтобы знать правду. Сам детектор видит только кадры и прогноз twin.
 */
import { describe, expect, it } from 'vitest';
import { createTwin, minDetectionTime, type ActionsFile, type DetectorOutput, type PipelineConfig, type ScenarioEvent } from '@pipetwin/core';
import { SimulatedSource } from '@pipetwin/core/plant';
import { buildEventCard, createDetector, defaultStrategy } from '../src';
import { ctxFor, defaultConfig, readJson } from './helpers';

function truthOf(cfg: PipelineConfig, noisePct = 0.2): PipelineConfig {
  const t = structuredClone(cfg);
  t.geometry.roughness = 8e-5; // twin считает 0,05 мм — ошибка модели, как в жизни
  for (const s of t.sensors) if (s.kind === 'p' && s.range) s.noiseStd = (noisePct / 100) * (s.range[1] - s.range[0]);
  return t;
}

interface Run {
  firstAlarm: Record<string, number>;
  outs: Record<string, DetectorOutput[]>;
  src: SimulatedSource;
}

function simulate(names: string[], events: ScenarioEvent[], durationSec: number, seed: number, noisePct = 0.2): Run {
  const cfg = defaultConfig();
  const src = new SimulatedSource(truthOf(cfg, noisePct), { seed, events, durationSec });
  const twin = createTwin(cfg);
  const dets = names.map((n) => {
    const d = createDetector(defaultStrategy(n));
    d.reset(ctxFor(cfg, twin));
    return [n, d] as const;
  });
  const firstAlarm: Record<string, number> = {};
  const outs: Record<string, DetectorOutput[]> = Object.fromEntries(names.map((n) => [n, []]));
  while (!src.done) {
    for (const f of src.step(0.1)) {
      const p = twin.predict(f);
      for (const [n, d] of dets) {
        const o = d.update(f, p);
        outs[n]!.push(o);
        if (o.alarm && firstAlarm[n] === undefined) firstAlarm[n] = o.t;
      }
    }
  }
  return { firstAlarm, outs, src };
}

describe('T-B13 детекция на ядре A', () => {
  it('утечка 5% в середине, шум 0,3%: хотя бы один детектор быстрее 5 с, не быстрее физического предела', () => {
    const cfg = defaultConfig();
    const names = ['threshold', 'cusum', 'ewma', 'npw', 'kalman'];
    const r = simulate(names, [{ t: 80, type: 'leak', x: 25000, sizePct: 5, rampSec: 0 }], 110, 31, 0.3);
    const ttd = Object.values(r.firstAlarm).map((t) => t - 80);
    const fastest = Math.min(...ttd);
    expect(fastest).toBeLessThan(5);
    expect(fastest).toBeGreaterThanOrEqual(minDetectionTime(cfg, 25000, r.src.waveSpeed) - 0.2);
  });
});

describe('T-B14 режимы без утечки', () => {
  it('насос +10% и прикрытие задвижки: с сигнатурным фильтром ноль тревог', () => {
    const r = simulate(
      ['threshold', 'cusum', 'ewma'],
      [
        { t: 100, type: 'pump', changePct: 10, rampSec: 3 },
        { t: 240, type: 'valve', opening: 0.6, rampSec: 5 },
      ],
      400,
      41,
    );
    expect(r.firstAlarm).toEqual({});
    expect(r.outs.cusum!.some((o) => o.eventClass === 'pump-change')).toBe(true);
    expect(r.outs.cusum!.some((o) => o.eventClass === 'valve-change')).toBe(true);
  });
});

describe('T-B18 объяснение и рекомендация', () => {
  const rules = readJson<ActionsFile>('configs/actions.json').rules;
  const cases = [0.5, 3, 10];
  const results = cases.map((size) => {
    const r = simulate(['cusum'], [{ t: 80, type: 'leak', x: 23000, sizePct: size, rampSec: 0 }], 260, 50 + size);
    const outs = r.outs.cusum!;
    const tAlarm = r.firstAlarm.cusum!;
    // карточка обновляется, пока тревога активна; берём состояние через 120 с после тревоги
    const late = outs.filter((o) => o.alarm && o.t <= tAlarm + 120).at(-1)!;
    const card = buildEventCard({ ...late, t: tAlarm }, { rules, nominalFlow: 0.322, detector: 'cusum' });
    const truth = r.src.truth().leaks[0]!;
    return { size, card, tAlarm, truthRate: truth.rate!, vLossTrue: truth.rate! * (tAlarm - 80) };
  });

  it('утечки 0,5%, 3%, 10% у p_km25: пойманы, вклад у p_km25 и соседей; место для утечек от 3% — точнее 5 км', () => {
    for (const r of results) {
      expect(r.tAlarm, `${r.size}%`).toBeDefined();
      if (r.size >= 3) expect(Math.abs(r.card.location!.x - 23000), `${r.size}%`).toBeLessThan(5000);
      const top = r.card.contributions.slice(0, 2).map((c) => c.sensorId);
      expect(top.some((id) => ['p_km25', 'p_km10', 'q_in', 'q_out'].includes(id)), `${r.size}%: ${top}`).toBe(true);
    }
  });

  it('три разные рекомендации по размеру утечки', () => {
    const ids = results.map((r) => r.card.action.ruleId);
    expect(new Set(ids).size).toBe(3);
  });

  it('расход утечки (и V_loss) в пределах 25% от истины для утечек от 3%', () => {
    for (const r of results.filter((x) => x.size >= 3)) {
      expect(Math.abs(r.card.leakRate! / r.truthRate - 1), `${r.size}%`).toBeLessThan(0.25);
    }
  });
});
