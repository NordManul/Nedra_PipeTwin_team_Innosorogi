/** Внутренние типы пакета detect. Внешний контракт — Detector из @pipetwin/core/contracts. */
import type { DetectorContext, DetectorParams, DetectorRequirements, SensorId } from '@pipetwin/core/contracts';
import type { Preprocessor } from './preprocess';

/** Подготовленный отсчёт на равномерной внутренней сетке (WP-B1). */
export interface PreparedSample {
  t: number;
  dt: number;
  /** Средние замеры за интервал сетки, СИ (только достоверные датчики). */
  raw: Record<SensorId, number>;
  /** Невязка r = замер − прогноз (датчики, не являющиеся граничными для twin). */
  r: Record<SensorId, number>;
  /** Нормированная невязка z = (r − μ)/σ. */
  z: Record<SensorId, number>;
  /**
   * «Свидетельство утечки» e = знак·z: положительно, когда датчик отклоняется так, как при утечке.
   * Канал SUM — взвешенная сумма по всем каналам (согласованный фильтр).
   */
  e: Record<string, number>;
  /** Достоверные (здоровые и присутствующие) датчики. */
  valid: Set<SensorId>;
  /** Оценки шума готовы (прогрев закончен). */
  warm: boolean;
}

export const SUM = '__sum';

/** Результат статистики на одном отсчёте. */
export interface StatOut {
  /** Статистика (в долях σ или безразмерная). */
  score: number;
  /** Порог, с которым сравнивается score. */
  threshold: number;
  /** Явное решение статистики (для детекторов по шаблону, например волна давления). */
  alarm?: boolean;
  /** Вклад каналов в score (для объяснения). */
  channels?: Record<string, number>;
  location?: number;
  locationInterval?: [number, number];
  /** Расход утечки, м³/с. */
  leakRate?: number;
  /** Оценка момента начала события, с. */
  onset?: number;
}

export interface Statistic {
  update(s: PreparedSample): StatOut;
  /** Сбросить накопленное после обработанной тревоги. */
  rearm(): void;
}

export interface StatContext {
  ctx: DetectorContext;
  prep: Preprocessor;
  binSec: number;
  /** Скорость волны давления, м/с. */
  waveSpeed: number;
}

export interface DetectorMeta {
  /** Код из ТЗ: D1…D9. */
  code: string;
  title: string;
  requires: DetectorRequirements;
  defaults: DetectorParams;
  /** Параметр-порог: его масштабирует autotune. */
  thresholdParam: string;
  /** Ранг простоты для выбора при ничьей (меньше — проще). */
  simplicity: number;
  create(sc: StatContext, params: DetectorParams, members?: Array<{ detector: string; params: DetectorParams; weight?: number }>): Statistic;
}
