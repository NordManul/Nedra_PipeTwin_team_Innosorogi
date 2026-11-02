/**
 * Калибровка порогов на валидационных seed (ТЗ, раздел 14, шаг 1): статистика каждой стратегии
 * в «немом» режиме на прогонах без утечки; блочные максимумы со всех прогонов объединяются,
 * порог подбирается под целевую частоту ложных тревог (распределение Гумбеля).
 */
import { createTwin, loadScenario, type Scenario, type SensorFrame, type StrategySpec, type TwinPrediction } from '@pipetwin/core';
import { createScenarioSource } from '@pipetwin/core/plant';
import { blockMaxima, createDetector, REGISTRY, scaleThreshold } from '@pipetwin/detect';
import { strategyId } from './candidates';
import { readJsonFromRoot } from './runner';

export const BLOCK_SEC = 60;
/** Масштабы порога, которые перебираются для детекторов с тревогой по шаблону. */
export const PATTERN_SCALES = [0.8, 1, 1.25, 1.5, 2, 3];

export interface TuneJobResult {
  scenario_id: string;
  maxima: Record<string, number[]>;
  /** Для детекторов по шаблону: число тревог при каждом масштабе из PATTERN_SCALES. */
  patternAlarms: Record<string, number[]>;
  observedSec: number;
}

/** Максимумы для всех стратегий на одном прогоне без утечки. */
export function tuneScenario(sc: Scenario, strategies: StrategySpec[]): TuneJobResult {
  const loaded = loadScenario(sc, readJsonFromRoot);
  const cfg = loaded.twin.config;
  const src = createScenarioSource(loaded);
  const twin = createTwin(cfg);
  const stream: Array<{ frame: SensorFrame; pred: TwinPrediction }> = [];
  while (!src.done) for (const f of src.step(1)) stream.push({ frame: f, pred: twin.predict(f) });
  const ctx = { config: cfg, sensors: cfg.sensors, sampleRateHz: src.sampleRateHz, twin };
  const maxima: Record<string, number[]> = {};
  const patternAlarms: Record<string, number[]> = {};
  let observedSec = 0;
  for (const spec of strategies) {
    const s = { ...spec, warmupSec: sc.warmupSec ?? 60 };
    if (!createDetector(s).check(ctx).ok) continue;
    if (REGISTRY[spec.strategy]?.patternAlarm) {
      patternAlarms[strategyId(spec)] = PATTERN_SCALES.map((k) => countAlarms(scaleThreshold(s, k), stream, ctx));
    } else {
      const bm = blockMaxima(s, stream, ctx, BLOCK_SEC);
      maxima[strategyId(spec)] = bm.maxima;
      observedSec = Math.max(observedSec, bm.observedSec);
    }
  }
  return { scenario_id: sc.id, maxima, patternAlarms, observedSec };
}

function countAlarms(spec: StrategySpec, stream: Array<{ frame: SensorFrame; pred: TwinPrediction }>, ctx: Parameters<ReturnType<typeof createDetector>['reset']>[0]): number {
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
