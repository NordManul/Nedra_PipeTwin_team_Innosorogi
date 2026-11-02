/** Кандидаты турнира: все детекторы реестра с параметрами по умолчанию + слияние лучших по скорости. */
import type { StrategySpec } from '@pipetwin/core';
import { defaultStrategy, REGISTRY } from '@pipetwin/detect';

export function defaultCandidates(): StrategySpec[] {
  const list = Object.keys(REGISTRY)
    .filter((n) => n !== 'fusion')
    .map((n) => defaultStrategy(n));
  list.push({
    strategy: 'fusion',
    params: { thr: 1, minVotes: 2 },
    members: [
      { detector: 'cusum', params: { ...REGISTRY.cusum!.defaults }, weight: 1 },
      { detector: 'npw', params: { ...REGISTRY.npw!.defaults }, weight: 1 },
    ],
    fusionRule: 'weighted-sum',
    localization: 'lsq',
    signatureFilter: true,
    warmupSec: 60,
  });
  return list;
}

/** Идентификатор стратегии для runs.csv: имя и параметры через «;» (без запятых). */
export function strategyId(s: StrategySpec): string {
  const p = Object.entries(s.params)
    .map(([k, v]) => `${k}=${Number(v.toPrecision(4))}`)
    .join(';');
  const m = s.members ? `[${s.members.map((x) => x.detector).join('+')}]` : '';
  return `${s.strategy}${m}:${p}`;
}
