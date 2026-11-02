/**
 * Генератор сценариев (WP-B6). Декларативные наборы из плана экспериментов (ТЗ, раздел 13):
 *  E3 — основная матрица (размер × место × шум × нарастание × seed);
 *  E4 — число датчиков и частота опроса;
 *  E5 — режимные события без утечки и с утечкой;
 *  E6 — ошибка модели (шероховатость, вязкость, дрейф датчика);
 *  random — случайные трубы (на них выбирается стратегия);
 *  noleak — длинные прогоны без утечки для FAR.
 * Сценарии самодостаточны: конфиг трубы встроен, файлы читать не нужно (удобно для воркеров).
 */
import { Rng, type PipelineConfigInput, type Scenario, type ScenarioEvent } from '@pipetwin/core';

export type Split = 'validation' | 'test';

export interface SuiteOptions {
  quick: boolean;
  split: Split;
  /** Базовый конфиг трубы (входной). */
  pipeline: PipelineConfigInput;
  seeds: { validation: number[]; test: number[] };
}

/** Прогрев детектора, с; утечка — через 5 с после него (ТЗ: 60 с до утечки и 60 с после). */
export const WARMUP_SEC = 60;
export const LEAK_T = WARMUP_SEC + 5;
export const AFTER_LEAK_SEC = 60;

/** «Настоящая» труба отличается от знаний twin (ТЗ, раздел 3.2). */
const TRUTH_ROUGHNESS = '0,08 мм';

function noiseInput(base: PipelineConfigInput, noisePct: number): PipelineConfigInput {
  const sensors = (base.sensors ?? []).map((s) => (s.kind === 'T' ? s : { ...s, noisePct, noiseStd: undefined }));
  return { ...base, sensors: sensors.map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined))) };
}

function scenario(id: string, pipeline: PipelineConfigInput, events: ScenarioEvent[], seed: number, split: Split, durationSec: number, tags: string[], truth: Record<string, unknown> = {}): Scenario {
  return {
    schemaVersion: 1,
    id,
    pipeline,
    truthOverrides: { geometry: { roughness: TRUTH_ROUGHNESS }, ...truth },
    source: { type: 'simulated' },
    durationSec,
    seed,
    warmupSec: WARMUP_SEC,
    split,
    events,
    tags,
  };
}

const leak = (L: number, frac: number, sizePct: number, rampSec: number): ScenarioEvent => ({ t: LEAK_T, type: 'leak', id: 'L1', x: Math.round(L * frac), sizePct, rampSec });

function lengthOf(p: PipelineConfigInput): number {
  const l = (p.geometry as { length?: unknown } | undefined)?.length;
  return typeof l === 'number' ? l : 50000;
}

/** E3: основная матрица. */
export function suiteE3(o: SuiteOptions): Scenario[] {
  const sizes = o.quick ? [1, 2, 5, 10] : [0.5, 1, 2, 5, 10, 20];
  const places = o.quick ? [0.3, 0.7] : [0.1, 0.3, 0.5, 0.7, 0.9];
  const noises = o.quick ? [0.2] : [0.1, 0.3, 0.5];
  const ramps = o.quick ? [0] : [0, 30];
  const seeds = (o.split === 'validation' ? o.seeds.validation : o.seeds.test).slice(0, o.quick ? 1 : undefined);
  const L = lengthOf(o.pipeline);
  const out: Scenario[] = [];
  for (const noise of noises) {
    const pipe = noiseInput(o.pipeline, noise);
    for (const size of sizes) for (const pl of places) for (const ramp of ramps) for (const seed of seeds) {
      out.push(scenario(`e3-s${size}-x${pl}-n${noise}-r${ramp}-${seed}`, pipe, [leak(L, pl, size, ramp)], seed, o.split, LEAK_T + AFTER_LEAK_SEC + ramp, ['E3', `size:${size}`, `noise:${noise}`]));
    }
  }
  return out;
}

/** E5: режимные события без утечки (ложные тревоги) и те же события с утечкой (задержка детекции). */
export function suiteE5(o: SuiteOptions): Scenario[] {
  const L = lengthOf(o.pipeline);
  const seeds = (o.split === 'validation' ? o.seeds.validation : o.seeds.test).slice(0, o.quick ? 1 : 3);
  const regimes: Array<[string, ScenarioEvent[]]> = [
    ['pump-up10', [{ t: 90, type: 'pump', changePct: 10, rampSec: 3 }]],
    ['pump-down10', [{ t: 90, type: 'pump', changePct: -10, rampSec: 3 }]],
    ['valve-close', [{ t: 90, type: 'valve', opening: 0.6, rampSec: 5 }]],
    ['valve-open', [{ t: 90, type: 'valve', opening: 1, rampSec: 5 }]],
    ['pump-valve', [{ t: 90, type: 'pump', changePct: 8, rampSec: 3 }, { t: 200, type: 'valve', opening: 0.65, rampSec: 5 }]],
  ];
  const out: Scenario[] = [];
  for (const seed of seeds) {
    for (const [name, ev] of regimes) {
      out.push(scenario(`e5-${name}-noleak-${seed}`, o.pipeline, ev, seed, o.split, 360, ['E5', 'regime', 'noleak']));
      // утечка на фоне события: через 10 с после него
      out.push(scenario(`e5-${name}-leak-${seed}`, o.pipeline, [...ev, { t: 100, type: 'leak', id: 'L1', x: Math.round(0.5 * L), sizePct: 5, rampSec: 0 }], seed, o.split, 160, ['E5', 'regime', 'leak']));
    }
  }
  return out;
}

/** Длинные прогоны без утечки — знаменатель FAR; со слабым дрейфом режима. */
export function suiteNoLeak(o: SuiteOptions): Scenario[] {
  const seeds = o.split === 'validation' ? o.seeds.validation : o.seeds.test;
  const dur = o.quick ? 900 : 3600;
  const noises = o.quick ? [0.2] : [0.1, 0.3, 0.5];
  const out: Scenario[] = [];
  for (const noise of noises) {
    const pipe = noiseInput(o.pipeline, noise);
    for (const seed of seeds.slice(0, o.quick ? 2 : undefined)) {
      out.push(scenario(`noleak-n${noise}-${seed}`, pipe, [], seed, o.split, dur, ['noleak', `noise:${noise}`]));
    }
  }
  return out;
}

/** E4: число датчиков давления по трассе и частота опроса. */
export function suiteE4(o: SuiteOptions): Scenario[] {
  const L = lengthOf(o.pipeline);
  const seeds = (o.split === 'validation' ? o.seeds.validation : o.seeds.test).slice(0, o.quick ? 1 : 3);
  const out: Scenario[] = [];
  for (const nP of [3, 5, 10]) {
    for (const rate of o.quick ? [10] : [1, 10, 50]) {
      const sensors: Array<Record<string, unknown>> = [
        { id: 'p_in', kind: 'p', x: 0, range: [101325, 6.5e6], noisePct: 0.2, lagSec: 0.5 },
        { id: 'q_in', kind: 'q', x: 0, range: [0, 0.6], noisePct: 0.5, lagSec: 1 },
        { id: 'T_in', kind: 'T', x: 0, noiseK: 0.1, lagSec: 5 },
        { id: 'p_out', kind: 'p', x: L, range: [101325, 6.5e6], noisePct: 0.2, lagSec: 0.5 },
        { id: 'q_out', kind: 'q', x: L, range: [0, 0.6], noisePct: 0.5, lagSec: 1 },
      ];
      for (let k = 1; k <= nP - 2; k++) {
        const x = Math.round((L * k) / (nP - 1) / 100) * 100;
        sensors.push({ id: `p_km${String(x / 1000).replace('.', '_')}`, kind: 'p', x, range: [101325, 6.5e6], noisePct: 0.2, lagSec: 0.5 });
      }
      const pipe: PipelineConfigInput = { ...o.pipeline, sensors, sampling: { rateHz: rate } };
      for (const size of o.quick ? [2] : [0.5, 1, 2, 5]) for (const pl of [0.37, 0.61]) for (const seed of seeds) {
        out.push(scenario(`e4-p${nP}-f${rate}-s${size}-x${pl}-${seed}`, pipe, [leak(L, pl, size, 0)], seed, o.split, LEAK_T + AFTER_LEAK_SEC, ['E4', `sensors:${nP}`, `rate:${rate}`]));
      }
    }
  }
  return out;
}

/** E6: ошибка модели — шероховатость ±20%, вязкость ±15%, дрейф датчика. */
export function suiteE6(o: SuiteOptions): Scenario[] {
  const L = lengthOf(o.pipeline);
  const seeds = (o.split === 'validation' ? o.seeds.validation : o.seeds.test).slice(0, o.quick ? 1 : 3);
  const errors: Array<[string, Record<string, unknown>]> = [
    ['rough-up20', { geometry: { roughness: '0,06 мм' } }],
    ['rough-down20', { geometry: { roughness: '0,04 мм' } }],
    ['visc-up15', { fluid: { viscosity: { model: 'filonov-reynolds', nu0: 11.5e-6, T0: 293.15, u: 0.03 } } }],
    ['visc-down15', { fluid: { viscosity: { model: 'filonov-reynolds', nu0: 8.5e-6, T0: 293.15, u: 0.03 } } }],
    ['drift', { sensors: [{ id: 'p_km25', drift: 30 }] }],
  ];
  const out: Scenario[] = [];
  for (const [name, truth] of errors) for (const seed of seeds) {
    out.push(scenario(`e6-${name}-noleak-${seed}`, o.pipeline, [], seed, o.split, 600, ['E6', 'noleak'], truth));
    out.push(scenario(`e6-${name}-leak-${seed}`, o.pipeline, [leak(L, 0.5, 2, 0)], seed, o.split, LEAK_T + AFTER_LEAK_SEC, ['E6', 'leak'], truth));
  }
  return out;
}

/** Случайные трубы: L 5–200 км, D 0,2–1,2 м, ν 1–300 сСт, 3–10 датчиков давления, шум 0,1–1%. */
export function suiteRandom(o: SuiteOptions & { count?: number }): Scenario[] {
  const n = o.count ?? (o.quick ? 12 : 200);
  const rng = new Rng(o.split === 'validation' ? 7001 : 9001);
  const out: Scenario[] = [];
  for (let k = 0; k < n; k++) {
    const L = Math.round(rng.uniform(5e3, 2e5) / 100) * 100;
    const D = Number(rng.uniform(0.2, 1.2).toFixed(3));
    const nu = Number(rng.uniform(1, 300).toFixed(1));
    const nP = rng.int(3, 10);
    const noise = Number(rng.uniform(0.1, 1).toFixed(2));
    const sensors: Array<Record<string, unknown>> = [
      { id: 'p_in', kind: 'p', x: 0, noisePct: noise },
      { id: 'q_in', kind: 'q', x: 0, noisePct: 0.5 },
      { id: 'T_in', kind: 'T', x: 0 },
      { id: 'p_out', kind: 'p', x: L, noisePct: noise },
      { id: 'q_out', kind: 'q', x: L, noisePct: 0.5 },
      { id: 'T_out', kind: 'T', x: L },
    ];
    for (let j = 1; j <= nP - 2; j++) {
      const x = Math.round((L * j) / (nP - 1) / 100) * 100;
      sensors.push({ id: `p_${j}`, kind: 'p', x, noisePct: noise });
    }
    const pipe: PipelineConfigInput = {
      schemaVersion: 1,
      meta: { name: `random-${k}` },
      geometry: { length: L, diameter: D },
      fluid: { name: 'light-crude', viscosity: { model: 'constant', nu: `${nu} сСт` } },
      sensors,
      numerics: { dx: Math.max(50, Math.round(L / 400)), frictionModel: 'swamee-jain', thermalMode: 'none' },
    };
    const seed = (o.split === 'validation' ? o.seeds.validation : o.seeds.test)[k % 5]!;
    const size = [1, 2, 5, 10][k % 4]!;
    const frac = Number(rng.uniform(0.1, 0.9).toFixed(2));
    const after = Math.max(AFTER_LEAK_SEC, Math.round((1.5 * L) / 1000));
    out.push(scenario(`rnd-${k}-s${size}`, pipe, [leak(L, frac, size, 0)], seed, o.split, LEAK_T + after, ['random', `size:${size}`]));
    if (k % 4 === 0) out.push(scenario(`rnd-${k}-noleak`, pipe, [{ t: 120, type: 'pump', changePct: 8, rampSec: 3 }], seed, o.split, 300, ['random', 'noleak']));
  }
  return out;
}

/** E7: методы места — утечки 2–10% с наблюдением 150 с после утечки (волны успевают затухнуть). */
export function suiteE7(o: SuiteOptions): Scenario[] {
  const L = lengthOf(o.pipeline);
  const seeds = (o.split === 'validation' ? o.seeds.validation : o.seeds.test).slice(0, o.quick ? 1 : 3);
  const pipe = noiseInput(o.pipeline, 0.3);
  const out: Scenario[] = [];
  for (const size of [2, 5, 10]) for (const pl of [0.1, 0.3, 0.5, 0.7, 0.9]) for (const seed of seeds) {
    out.push(scenario(`e7-s${size}-x${pl}-${seed}`, pipe, [leak(L, pl, size, 0)], seed, o.split, LEAK_T + 150, ['E7', `size:${size}`]));
  }
  return out;
}

export const SUITES = {
  e7: suiteE7,
  e3: suiteE3,
  e4: suiteE4,
  e5: suiteE5,
  e6: suiteE6,
  random: suiteRandom,
  noleak: suiteNoLeak,
} as const;

export type SuiteName = keyof typeof SUITES;
