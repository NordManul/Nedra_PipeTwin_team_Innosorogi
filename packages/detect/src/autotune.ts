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

export function autotune(
  spec: StrategySpec,
  stream: Array<{ frame: SensorFrame; pred: TwinPrediction | null }>,
  ctx: DetectorContext,
  opts: AutotuneOptions = {},
): AutotuneResult {
  const target = opts.targetFarPerDay ?? 1;
  const blockSec = opts.blockSec ?? 60;
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
  const meta = REGISTRY[spec.strategy]!;
  const param = meta.thresholdParam;
  let rStar: number;
  if (maxima.length >= 3) {
    const beta = (Math.sqrt(6) * std(maxima)) / Math.PI;
    const mu = mean(maxima) - 0.5772 * beta;
    const p = Math.min(0.5, (target * blockSec) / 86400);
    rStar = mu - beta * Math.log(-Math.log(1 - p));
  } else {
    rStar = (maxima.length ? Math.max(...maxima, cur) : cur) * 1.3;
  }
  const scale = Math.max(0.3, rStar * (opts.safety ?? 1.1));
  const base = { ...meta.defaults, ...spec.params };
  const tuned: StrategySpec = { ...spec, params: { ...base, [param]: Number((base[param]! * scale).toPrecision(4)) } };
  return { spec: tuned, scale, thresholdParam: param, blockMaxima: maxima, observedSec: observed };
}
