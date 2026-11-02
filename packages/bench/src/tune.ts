/**
 * Калибровка порогов на валидационных seed (ТЗ, раздел 14, шаг 1).
 * На прогонах без утечки для каждой стратегии перебираются масштабы порога и считаются настоящие
 * тревоги (детектор работает как в бою: со сбросом после тревоги, защитой режима, сигнатурами).
 * Выбирается наименьший масштаб, при котором ложных тревог не больше target × сутки наблюдения,
 * плюс запас. Подсчёт тревог честнее, чем максимумы «немой» статистики: у CUSUM без сброса
 * максимумы растут неограниченно и порог получался завышенным в 1,5–2 раза.
 */
import { createTwin, loadScenario, type DetectorContext, type Scenario, type SensorFrame, type StrategySpec, type TwinPrediction } from '@pipetwin/core';
import { createScenarioSource } from '@pipetwin/core/plant';
import { createDetector, scaleThreshold } from '@pipetwin/detect';
import { strategyId } from './candidates';
import { readJsonFromRoot } from './runner';

/** Масштабы порога относительно значения по умолчанию, которые перебираются. */
export const TUNE_SCALES = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3, 4];
/** Запас над найденным масштабом. */
export const TUNE_SAFETY = 1.05;

export interface TuneJobResult {
  scenario_id: string;
  /** Число ложных тревог при каждом масштабе из TUNE_SCALES. */
  alarms: Record<string, number[]>;
  /** Время наблюдения после прогрева, с. */
  observedSec: number;
}

type Stream = Array<{ frame: SensorFrame; pred: TwinPrediction }>;

export function tuneScenario(sc: Scenario, strategies: StrategySpec[]): TuneJobResult {
  const loaded = loadScenario(sc, readJsonFromRoot);
  const cfg = loaded.twin.config;
  const src = createScenarioSource(loaded);
  const twin = createTwin(cfg);
  const stream: Stream = [];
  while (!src.done) for (const f of src.step(1)) stream.push({ frame: f, pred: twin.predict(f) });
  const ctx: DetectorContext = { config: cfg, sensors: cfg.sensors, sampleRateHz: src.sampleRateHz, twin };
  const warmup = sc.warmupSec ?? 60;
  const alarms: Record<string, number[]> = {};
  for (const spec of strategies) {
    const s = { ...spec, warmupSec: warmup };
    if (!createDetector(s).check(ctx).ok) continue;
    alarms[strategyId(spec)] = TUNE_SCALES.map((k) => countAlarms(scaleThreshold(s, k), stream, ctx));
  }
  return { scenario_id: sc.id, alarms, observedSec: Math.max(0, sc.durationSec - warmup) };
}

function countAlarms(spec: StrategySpec, stream: Stream, ctx: DetectorContext): number {
  const det = createDetector(spec);
  det.reset(ctx);
  let was = false;
  let n = 0;
  for (const { frame, pred } of stream) {
    const o = det.update(frame, pred);
    if (o.alarm && !was) n++;
    was = o.alarm;
  }
  return n;
}

/**
 * Масштаб порога под targetFarPerDay. Число тревог при разных масштабах k приближается
 * зависимостью ln N = a − b·k² (частота выбросов гауссова процесса, формула Райса) по точкам,
 * где тревоги были; из неё — k, при котором за время наблюдения ожидается target·сутки тревог.
 * Не меньше наименьшего масштаба без тревог; итог × запас TUNE_SAFETY.
 */
export function pickScale(counts: number[], observedSec: number, targetFarPerDay: number): number {
  const target = (targetFarPerDay * observedSec) / 86400;
  const firstZero = counts.findIndex((c, i) => c <= Math.floor(target) && counts.slice(i).every((v) => v <= Math.floor(target)));
  const kZero = firstZero < 0 ? TUNE_SCALES.at(-1)! : TUNE_SCALES[firstZero]!;
  const pts = TUNE_SCALES.map((k, i) => [k * k, Math.log(counts[i]!)] as const).filter((_, i) => counts[i]! > 0);
  let k = kZero;
  if (pts.length >= 2) {
    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p[0], 0) / n;
    const my = pts.reduce((a, p) => a + p[1], 0) / n;
    const sxx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
    const slope = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / sxx;
    if (slope < 0) {
      const k2 = mx + (Math.log(target) - my) / slope;
      if (k2 > 0) k = Math.max(kZero, Math.sqrt(k2));
    }
  }
  return Number((k * TUNE_SAFETY).toFixed(3));
}
