/**
 * Автонастройка порога на новых данных (WP-B9): по записи без утечки подобрать порог так,
 * чтобы ожидаемая частота ложных тревог была не выше цели.
 *
 * Статистика детектора считается в «немом» режиме, берутся максимумы отношения score/порог
 * по блокам blockSec, к ним подгоняется распределение Гумбеля (метод моментов), и порог
 * масштабируется до квантиля, соответствующего targetFarPerDay. Короткой записи достаточно:
 * хвост экстраполируется.
 */
import type { DetectorContext, SensorFrame, StrategySpec, TwinPrediction } from '@pipetwin/core/contracts';
import { mean, std } from '@pipetwin/core';
import { createDetector } from './pipeline';
import { REGISTRY } from './registry';

export interface AutotuneOptions {
  targetFarPerDay?: number;
  blockSec?: number;
  /** Множитель запаса к найденному порогу. */
  safety?: number;
}

export interface AutotuneResult {
  spec: StrategySpec;
  /** Во сколько раз изменён порог. */
  scale: number;
  thresholdParam: string;
  blockMaxima: number[];
  observedSec: number;
}

/** Максимумы отношения score/порог по блокам blockSec в «немом» прогоне (без тревог). */
export function blockMaxima(
  spec: StrategySpec,
  stream: Iterable<{ frame: SensorFrame; pred: TwinPrediction | null }>,
  ctx: DetectorContext,
  blockSec = 60,
): { maxima: number[]; observedSec: number } {
  const det = createDetector(spec, { silent: true });
  det.reset(ctx);
  const maxima: number[] = [];
  let blockStart = NaN;
  let cur = 0;
  let observed = 0;
  let lastT = NaN;
  for (const { frame, pred } of stream) {
    const out = det.update(frame, pred);
    if (out.phase === 'warmup' || !out.threshold) continue;
    if (Number.isNaN(blockStart)) blockStart = out.t;
    if (Number.isFinite(lastT) && out.t > lastT) observed += out.t - lastT;
    lastT = out.t;
    cur = Math.max(cur, out.score / out.threshold);
    if (out.t - blockStart >= blockSec) {
      maxima.push(cur);
      cur = 0;
      blockStart = out.t;
    }
  }
  return { maxima, observedSec: observed };
}

/**
 * Во сколько раз изменить порог, чтобы ожидаемая частота ложных тревог была targetFarPerDay:
 * распределение Гумбеля по блочным максимумам (метод моментов), квантиль 1 − target·block/сутки.
 */
export function gumbelScale(maxima: number[], blockSec: number, targetFarPerDay: number, safety = 1.1): number {
  let rStar: number;
  if (maxima.length >= 3) {
    const beta = (Math.sqrt(6) * std(maxima)) / Math.PI;
    const mu = mean(maxima) - 0.5772 * beta;
    const p = Math.min(0.5, (targetFarPerDay * blockSec) / 86400);
    rStar = mu - beta * Math.log(-Math.log(1 - p));
  } else {
    rStar = (maxima.length ? Math.max(...maxima) : 1) * 1.3;
  }
  return Math.max(0.3, rStar * safety);
}

/** Применить масштаб к параметру-порогу стратегии. */
export function scaleThreshold(spec: StrategySpec, scale: number): StrategySpec {
  const meta = REGISTRY[spec.strategy]!;
  const base = { ...meta.defaults, ...spec.params };
  const param = meta.thresholdParam;
  return { ...spec, params: { ...base, [param]: Number((base[param]! * scale).toPrecision(4)) } };
}

export function autotune(
  spec: StrategySpec,
  stream: Array<{ frame: SensorFrame; pred: TwinPrediction | null }>,
  ctx: DetectorContext,
  opts: AutotuneOptions = {},
): AutotuneResult {
  const blockSec = opts.blockSec ?? 60;
  const { maxima, observedSec } = blockMaxima(spec, stream, ctx, blockSec);
  const scale = gumbelScale(maxima, blockSec, opts.targetFarPerDay ?? 1, opts.safety ?? 1.1);
  return { spec: scaleThreshold(spec, scale), scale, thresholdParam: REGISTRY[spec.strategy]!.thresholdParam, blockMaxima: maxima, observedSec };
}
