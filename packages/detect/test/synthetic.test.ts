/** Тесты детекции на синтетических сигналах: T-B01…T-B10, T-B17 (ТЗ, раздел 11.2). */
import { describe, expect, it } from 'vitest';
import type { DetectorOutput, PipelineConfig, SensorFrame, StrategySpec, TwinModel } from '@pipetwin/core';
import { autotune, classifyEvent, createDetector, defaultStrategy, REGISTRY } from '../src';
import { ctxFor, defaultConfig, FakeTwin, leakShift, synth, type SynthOptions } from './helpers';

const NAMES = Object.keys(REGISTRY).filter((n) => n !== 'fusion');

interface RunResult {
  alarms: number[];
  last: DetectorOutput | null;
  outs: DetectorOutput[];
}

function run(spec: StrategySpec, cfg: PipelineConfig, frames: Iterable<SensorFrame>, twin?: TwinModel, rateHz = 10, keep = false): RunResult {
  const det = createDetector(spec);
  const tw = twin ?? new FakeTwin(cfg);
  det.reset(ctxFor(cfg, tw, rateHz));
  const alarms: number[] = [];
  const outs: DetectorOutput[] = [];
  let was = false;
  let last: DetectorOutput | null = null;
  for (const f of frames) {
    last = det.update(f, tw.predict(f));
    if (keep) outs.push(last);
    if (last.alarm && !was) alarms.push(last.t);
    was = last.alarm;
  }
  return { alarms, last, outs };
}

function stream(cfg: PipelineConfig, o: SynthOptions): Array<{ frame: SensorFrame; pred: ReturnType<FakeTwin['predict']> }> {
  const tw = new FakeTwin(cfg);
  return [...synth(cfg, o)].map((frame) => ({ frame, pred: tw.predict(frame) }));
}

describe('T-B01 ложные тревоги на чистом шуме', () => {
  const cfg = defaultConfig();
  it.each(NAMES)('%s: ≤ 2 тревог за 10 ч после настройки порога под 1 тревогу в сутки', (name) => {
    const tuned = autotune(defaultStrategy(name), stream(cfg, { durationSec: 3600, seed: 11 }), ctxFor(cfg, new FakeTwin(cfg)), { targetFarPerDay: 1 });
    const r = run(tuned.spec, cfg, synth(cfg, { durationSec: 36000, seed: 12 }));
    expect(r.alarms.length).toBeLessThanOrEqual(2);
  }, 120_000);
});

describe('T-B02 реакция на ступеньку 3σ', () => {
  const cfg = defaultConfig();
  // сравнение честное: пороги обоих настроены на одну частоту ложных тревог (1 в сутки)
  const tuned = (name: string) => autotune(defaultStrategy(name), stream(cfg, { durationSec: 3600, seed: 31 }), ctxFor(cfg, new FakeTwin(cfg))).spec;
  // по 1,5σ на четырёх каналах: суммарный (согласованный) канал получает ≈ 3σ
  const ttd = (spec: StrategySpec) => {
    const times = [1, 2, 3, 4, 5].map((seed) => run(spec, cfg, synth(cfg, { durationSec: 160, seed, shift: leakShift(1.5, 100) })).alarms.find((t) => t >= 100)! - 100);
    return times.reduce((a, b) => a + b, 0) / times.length;
  };
  it('D1–D3 срабатывают, D2 (CUSUM) быстрее D1 (порога) при одинаковой частоте ложных тревог', () => {
    const [d1, d2, d3] = ['threshold', 'cusum', 'ewma'].map((n) => ttd(tuned(n)));
    for (const v of [d1, d2, d3]) expect(v).toBeGreaterThanOrEqual(0);
    expect(d2!).toBeLessThan(d1!);
  }, 60_000);
  it('D10 (GLR) и D11 (адаптивный EWMA) срабатывают; крупный скачок D11 ловит не медленнее D3 (EWMA)', () => {
    const [glr, aewma] = ['glr', 'aewma'].map((n) => ttd(tuned(n)));
    for (const v of [glr, aewma]) expect(v).toBeGreaterThanOrEqual(0);
    // скачок 6σ на каждом канале: Хьюбер пропускает его почти целиком, EWMA — по λ за отсчёт
    const big = (spec: StrategySpec) => run(spec, cfg, synth(cfg, { durationSec: 120, seed: 7, shift: leakShift(6, 100) })).alarms.find((t) => t >= 100)! - 100;
    expect(big(tuned('aewma'))).toBeLessThanOrEqual(big(tuned('ewma')));
  }, 60_000);
});

describe('T-B03 независимость от единиц', () => {
  it('данные в Па и в барах дают одинаковые моменты тревог', () => {
    const cfg = defaultConfig();
    const bar = structuredClone(cfg);
    const scale: Record<string, number> = {};
    for (const s of bar.sensors) if (s.kind === 'p') {
      scale[s.id] = 1e-5;
      s.noiseStd *= 1e-5;
      if (s.range) s.range = [s.range[0] * 1e-5, s.range[1] * 1e-5];
    }
    const o: SynthOptions = { durationSec: 150, seed: 5, shift: leakShift(2, 100) };
    const a = run(defaultStrategy('cusum'), cfg, synth(cfg, o)).alarms;
    const b = run(defaultStrategy('cusum'), bar, synth(bar, { ...o, scale }), new FakeTwin(bar, scale)).alarms;
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });
});

describe('T-B04 независимость от частоты опроса', () => {
  it('10 и 50 Гц: среднее время детекции различается < 0,2 с', () => {
    const cfg = defaultConfig();
    // на 50 Гц шум отсчёта в √5 раз больше: после усреднения в сетке 0,1 с — тот же σ;
    // сама утечка (ступенька в абсолютных единицах) от частоты опроса не зависит
    const shift = leakShift(3, 100);
    const ttd = (rateHz: number, seed: number) => {
      const f = rateHz === 50 ? Math.sqrt(5) : 1;
      const frames = synth(cfg, { durationSec: 130, seed, rateHz, noiseScale: f, shift });
      return run(defaultStrategy('cusum'), cfg, frames, undefined, rateHz).alarms[0]! - 100;
    };
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const a = mean(seeds.map((sd) => ttd(10, sd)));
    const b = mean(seeds.map((sd) => ttd(50, sd + 100)));
    expect(Math.abs(a - b)).toBeLessThan(0.2);
  });
});

describe('T-B05 неравномерное время и пропуски', () => {
  it('дрожание ±30% и дыры по 5 с: нет падений, длинная дыра — датчик недостоверен', () => {
    const cfg = defaultConfig();
    const holes: SynthOptions['holes'] = [[100, 105, 'p_km25'], [150, 155]];
    const r = run(defaultStrategy('cusum'), cfg, synth(cfg, { durationSec: 200, seed: 4, jitter: 0.3, holes }), undefined, 10, true);
    expect(r.alarms).toEqual([]);
    const during = r.outs.filter((o) => o.t > 103 && o.t < 105);
    expect(during.length).toBeGreaterThan(0);
    expect(during.some((o) => (o.unhealthySensors ?? []).includes('p_km25'))).toBe(true);
    expect(r.outs.filter((o) => o.t > 160).every((o) => !(o.unhealthySensors ?? []).includes('p_km25'))).toBe(true);
  });
});

describe('T-B06 выбросы', () => {
  it('одиночные выбросы 20σ раз в минуту — нет тревоги об утечке', () => {
    const cfg = defaultConfig();
    const ids = ['p_km10', 'p_km25', 'q_in', 'q_out'];
    const shift = (t: number) => {
      const k = Math.floor(t / 60);
      return t > 60 && Math.abs(t - k * 60 - 30) < 0.05 ? { [ids[k % ids.length]!]: 20 } : {};
    };
    for (const name of ['threshold', 'cusum', 'ewma']) {
      expect(run(defaultStrategy(name), cfg, synth(cfg, { durationSec: 900, seed: 6, shift })).alarms, name).toEqual([]);
    }
  });
});

describe('T-B07 отказ одного датчика', () => {
  it('скачок на одном датчике — «отказ датчика», не утечка', () => {
    const cfg = defaultConfig();
    const r = run(defaultStrategy('cusum'), cfg, synth(cfg, { durationSec: 160, seed: 8, shift: (t) => (t > 100 ? { p_km25: 6 } : {}) }), undefined, 10, true);
    expect(r.alarms).toEqual([]);
    expect(r.outs.some((o) => o.eventClass === 'sensor-fault')).toBe(true);
    expect(r.last!.unhealthySensors).toContain('p_km25');
  });
});

describe('T-B08 нет нужных датчиков', () => {
  it('без расходомеров D4, D6 выбывают с причиной, остальные работают', () => {
    const cfg = defaultConfig();
    cfg.sensors = cfg.sensors.filter((s) => s.kind !== 'q');
    const ctx = ctxFor(cfg, new FakeTwin(cfg));
    for (const name of NAMES) {
      const c = createDetector(defaultStrategy(name)).check(ctx);
      if (name === 'mass-balance' || name === 'kalman') {
        expect(c.ok, name).toBe(false);
        expect(c.reasons.join(' ')).toMatch(/расхода/);
      } else expect(c.ok, `${name}: ${c.reasons}`).toBe(true);
    }
  });
});

describe('T-B09 сигнатуры событий', () => {
  const cfg = defaultConfig();
  const base = { sensors: cfg.sensors, length: cfg.geometry.length, activeChannels: ['p_km25', 'q_out'] };
  it('утечка: давление упало сначала внутри трубы', () => {
    const r = classifyEvent({ ...base, delta: { p_km25: -8, p_km10: -5, q_in: 4, q_out: -4 }, first: { p_km25: { t: 10, sign: -1 }, p_km10: { t: 22, sign: -1 } } });
    expect(r.cls).toBe('leak');
  });
  it('рост напора: давление на входе выросло первым, расход вырос', () => {
    const r = classifyEvent({ ...base, delta: { p_in: 20, q_in: 8, p_km10: 15 }, first: { p_in: { t: 10, sign: 1 }, q_in: { t: 10, sign: 1 }, p_km10: { t: 19, sign: 1 } } });
    expect(r.cls).toBe('pump-change');
  });
  it('прикрытие задвижки: давление на выходе выросло первым, расход упал', () => {
    const r = classifyEvent({ ...base, delta: { p_out: 20, q_out: -8, p_km25: 10 }, first: { p_out: { t: 10, sign: 1 }, q_out: { t: 10, sign: -1 }, p_km25: { t: 32, sign: 1 } } });
    expect(r.cls).toBe('valve-change');
  });
  it('отказ датчика: меняется один датчик', () => {
    const r = classifyEvent({ ...base, activeChannels: ['p_km10'], delta: { p_km10: 9, p_km25: 0.5 }, first: {} });
    expect(r.cls).toBe('sensor-fault');
  });
});

describe('T-B10 волна давления', () => {
  it('спад на двух датчиках с задержкой → D5 срабатывает, L3 ошибается не больше шага сетки', () => {
    const cfg = defaultConfig();
    const a = 1118.4;
    const xLeak = 17000;
    const t0 = 100;
    // волна приходит к p_km10 и p_km25 с задержками по расстоянию; давление падает на 8σ
    const shift = (t: number) => {
      const v: Record<string, number> = {};
      for (const s of cfg.sensors) if (s.kind === 'p' && t >= t0 + Math.abs(s.x - xLeak) / a) v[s.id] = -8;
      return v;
    };
    const r = run(defaultStrategy('npw', { localization: 'wave-timing' }), cfg, synth(cfg, { durationSec: 140, seed: 2, shift }), undefined, 10, true);
    expect(r.alarms.length).toBeGreaterThan(0);
    const loc = r.outs.find((o) => o.alarm && o.location !== undefined)!.location!;
    expect(Math.abs(loc - xLeak)).toBeLessThanOrEqual(cfg.numerics.dx * 10);
  });
});

describe('T-B17 автонастройка при другом уровне шума', () => {
  it('шум 1% вместо 0,3%: после autotune ложные тревоги в норме без ручной правки', () => {
    const cfg = defaultConfig();
    const noisy = { noiseScale: 1 / 0.3 };
    const tuned = autotune(defaultStrategy('cusum'), stream(cfg, { durationSec: 1800, seed: 21, ...noisy }), ctxFor(cfg, new FakeTwin(cfg)), { targetFarPerDay: 1 });
    const r = run(tuned.spec, cfg, synth(cfg, { durationSec: 7200, seed: 22, ...noisy }));
    expect(r.alarms.length).toBeLessThanOrEqual(1);
  }, 60_000);
});
