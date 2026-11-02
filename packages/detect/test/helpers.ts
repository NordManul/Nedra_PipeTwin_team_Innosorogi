/**
 * Синтетические сигналы для тестов детекции (T-B01…T-B12 не ждут ядра A): гауссов шум вокруг
 * номинала, «прогноз twin» = номинал, отклик на утечку — простой линейный шаблон.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveConfig, Rng, type DetectorContext, type PipelineConfig, type SensorFrame, type SensorValues, type TwinModel, type TwinPrediction } from '@pipetwin/core';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export function readJson<T = unknown>(rel: string): T {
  return JSON.parse(readFileSync(ROOT + rel, 'utf8')) as T;
}

export function defaultConfig(): PipelineConfig {
  return resolveConfig(readJson('configs/pipeline.default.json')).config;
}

/** Номинальные значения и шум датчиков конфига по умолчанию. */
export const NOMINAL: SensorValues = { p_in: 4.0e6, q_in: 0.31, T_in: 333.15, p_km10: 3.5e6, p_km25: 2.9e6, p_out: 2.39e6, q_out: 0.31, T_out: 318.6 };

/** Отклик на утечку 1% расхода (для фальшивого twin): давления падают, Q_вх растёт, Q_вых падает. */
export function leakPattern(cfg: PipelineConfig, x: number, q: number): SensorValues {
  const L = cfg.geometry.length;
  const out: SensorValues = {};
  for (const s of cfg.sensors) {
    if (s.kind === 'p') out[s.id] = s.x === 0 || s.x === L ? 0 : (-1.2e6 * q * (s.x < x ? s.x / x : (L - s.x) / (L - x)));
    else if (s.kind === 'q') out[s.id] = s.x === 0 ? q * (1 - x / L) : -q * (x / L);
    else out[s.id] = 0;
  }
  return out;
}

/** Фальшивый twin: прогноз — номинал (с масштабом), граничные датчики — p_in и p_out. */
export class FakeTwin implements TwinModel {
  constructor(private readonly cfg: PipelineConfig, private readonly scale: Record<string, number> = {}) {}
  reset(): void {}
  predict(frame: SensorFrame): TwinPrediction {
    const values: SensorValues = {};
    for (const s of this.cfg.sensors) values[s.id] = NOMINAL[s.id]! * (this.scale[s.id] ?? 1);
    return { t: frame.t, values, inputs: ['p_in', 'p_out', 'T_in'], ok: true };
  }
  leakResponse(x: number, q: number): SensorValues {
    const r = leakPattern(this.cfg, x, q);
    for (const k of Object.keys(r)) r[k]! *= this.scale[k] ?? 1;
    return r;
  }
}

export interface SynthOptions {
  durationSec: number;
  rateHz?: number;
  seed?: number;
  /** Шум датчика в долях его noiseStd из конфига. */
  noiseScale?: number;
  /** Дополнительное смещение по датчикам в момент t (σ датчика). */
  shift?: (t: number) => Record<string, number>;
  /** Масштаб единиц (например, Па → бар). */
  scale?: Record<string, number>;
  /** Дрожание метки времени, доля периода. */
  jitter?: number;
  /** Пропуски: [t0, t1] — нет кадров; [t0, t1, id] — нет отсчётов одного датчика. */
  holes?: Array<[number, number] | [number, number, string]>;
}

export function* synth(cfg: PipelineConfig, o: SynthOptions): Generator<SensorFrame> {
  const rng = new Rng(o.seed ?? 1);
  const rate = o.rateHz ?? 10;
  const n = Math.round(o.durationSec * rate);
  let last = -Infinity;
  for (let k = 0; k < n; k++) {
    let t = k / rate;
    if (o.jitter) t += o.jitter * (rng.next() - 0.5) * (2 / rate);
    if (t <= last) t = last + 1e-4;
    last = t;
    if (o.holes?.some((h) => h.length === 2 && t >= h[0] && t < h[1])) continue;
    const missing = new Set(o.holes?.filter((h): h is [number, number, string] => h.length === 3 && t >= h[0] && t < h[1]).map((h) => h[2]));
    const shift = o.shift?.(t) ?? {};
    const values: SensorValues = {};
    for (const s of cfg.sensors) {
      if (missing.has(s.id)) continue;
      // номинал — в единицах масштаба, шум — из конфига (он задан в тех же единицах)
      values[s.id] = NOMINAL[s.id]! * (o.scale?.[s.id] ?? 1) + s.noiseStd * ((o.noiseScale ?? 1) * rng.gauss() + (shift[s.id] ?? 0));
    }
    yield { t, values };
  }
}

export function ctxFor(cfg: PipelineConfig, twin?: TwinModel, rateHz = 10): DetectorContext {
  return { config: cfg, sensors: cfg.sensors, sampleRateHz: rateHz, twin };
}

/** Утечка-шаблон в долях σ: давления −a, Q_вх +a, Q_вых −a. */
export function leakShift(a: number, t0: number): (t: number) => Record<string, number> {
  return (t) => (t < t0 ? {} : { p_km10: -a, p_km25: -a, q_in: a, q_out: -a });
}
