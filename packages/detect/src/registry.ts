/**
 * Реестр детекторов по имени (ТЗ, раздел 5.4). Чтобы добавить детектор:
 *  1) реализовать Statistic в detectors/;
 *  2) добавить запись сюда: код, требования к датчикам, параметры по умолчанию, параметр-порог;
 *  3) имя появится в стенде, интерфейсе и select_strategy.py без других правок.
 */
import type { DetectorRequirements } from '@pipetwin/core/contracts';
import type { DetectorMeta } from './types';
import { AewmaStat, CusumStat, EwmaStat, GlrStat, ThresholdStat } from './detectors/residual';
import { MassBalanceStat } from './detectors/mass-balance';
import { NpwStat } from './detectors/npw';
import { KalmanStat } from './detectors/kalman';
import { PcaStat, RlsStat } from './detectors/datadriven';
import { FusionStat } from './detectors/fusion';

const pressures = (min = 1): DetectorRequirements['sensors'][number] => ({ kind: 'p', min });

/**
 * Значения порогов по умолчанию откалиброваны autotune на 30 мин данных без утечки
 * (pipeline.default.json, шум 0,2% шкалы, ошибка шероховатости 60%) под 1 ложную тревогу в сутки.
 * Для другой трубы стенд и autotune перенастраивают их автоматически.
 */
export const REGISTRY: Record<string, DetectorMeta> = {
  threshold: {
    code: 'D1',
    title: 'Порог на сглаженной невязке',
    requires: { sensors: [pressures()], needsTwin: true },
    defaults: { windowSec: 2, k: 8.5 },
    thresholdParam: 'k',
    simplicity: 1,
    create: (sc, p) => new ThresholdStat(sc, p),
  },
  ewma: {
    code: 'D3',
    title: 'EWMA-карта невязки',
    requires: { sensors: [pressures()], needsTwin: true },
    defaults: { tauSec: 3, L: 8.5 },
    thresholdParam: 'L',
    simplicity: 2,
    create: (sc, p) => new EwmaStat(sc, p),
  },
  cusum: {
    code: 'D2',
    title: 'CUSUM Пейджа',
    requires: { sensors: [pressures()], needsTwin: true },
    defaults: { drift: 0.5, h: 29 },
    thresholdParam: 'h',
    simplicity: 3,
    create: (_sc, p) => new CusumStat(p),
  },
  glr: {
    code: 'D10',
    title: 'GLR: сдвиг неизвестной величины',
    requires: { sensors: [pressures()], needsTwin: true },
    defaults: { minSec: 0.5, maxSec: 30, h: 12.7 },
    thresholdParam: 'h',
    simplicity: 3.5,
    create: (sc, p) => new GlrStat(sc, p),
  },
  aewma: {
    code: 'D11',
    title: 'Адаптивный EWMA (Хьюбер)',
    requires: { sensors: [pressures()], needsTwin: true },
    defaults: { tauSec: 3, kH: 4, L: 9.3 },
    thresholdParam: 'L',
    simplicity: 2.5,
    create: (sc, p) => new AewmaStat(sc, p),
  },
  'mass-balance': {
    code: 'D4',
    title: 'Баланс массы с поправкой на аккумуляцию',
    requires: { sensors: [{ kind: 'q', at: 'both-ends' }, pressures()], needsTwin: false },
    defaults: { windowSec: 10, k: 5.5 },
    thresholdParam: 'k',
    simplicity: 4,
    create: (sc, p) => new MassBalanceStat(sc, p),
  },
  rls: {
    code: 'D8',
    title: 'Взаимное предсказание датчиков (без физики)',
    requires: { sensors: [], minSensorsTotal: 3, needsTwin: false },
    defaults: { tauSec: 3, thr: 7, forgetSec: 600, relearnSec: 60 },
    thresholdParam: 'thr',
    simplicity: 5,
    create: (sc, p) => new RlsStat(sc, p),
  },
  pca: {
    code: 'D9',
    title: 'PCA и SPE (без физики)',
    requires: { sensors: [], minSensorsTotal: 3, needsTwin: false },
    defaults: { varExplained: 0.9, tauSec: 3, thr: 12, relearnSec: 60 },
    thresholdParam: 'thr',
    simplicity: 6,
    create: (sc, p) => new PcaStat(sc, p),
  },
  npw: {
    code: 'D5',
    title: 'Волна отрицательного давления',
    requires: { sensors: [pressures(2)], minSampleRateHz: 5, needsTwin: false },
    defaults: { shortSec: 1, longSec: 5, thr: 5.5, tolSec: 0.6 },
    thresholdParam: 'thr',
    simplicity: 7,
    patternAlarm: true,
    create: (sc, p) => new NpwStat(sc, p),
  },
  kalman: {
    code: 'D6',
    title: 'Фильтр Калмана с расширенным состоянием',
    requires: { sensors: [pressures(2), { kind: 'q', min: 1 }], needsTwin: true },
    defaults: { positions: 24, qProc: 0.002, k: 7 },
    thresholdParam: 'k',
    simplicity: 8,
    create: (sc, p) => new KalmanStat(sc, p),
  },
  fusion: {
    code: 'D7',
    title: 'Слияние детекторов',
    requires: { sensors: [], needsTwin: false },
    defaults: { thr: 1, minVotes: 2 },
    thresholdParam: 'thr',
    simplicity: 9,
    create: () => {
      throw new Error('fusion создаётся через createStatistic с участниками');
    },
  },
};

export { FusionStat };

/** Порядок простоты для выбора при ничьей (ТЗ, раздел 14). */
export const SIMPLICITY_ORDER = Object.entries(REGISTRY)
  .sort((a, b) => a[1].simplicity - b[1].simplicity)
  .map(([name]) => name);
