/**
 * Библиотека значений по умолчанию (WP-A1). Значения — типовые справочные, не норматив:
 * всё, что взято отсюда, получает статус default и становится кандидатом на калибровку.
 */
import type { Fluid } from '../contracts';

export interface FluidPreset extends Fluid {
  /** Типичная температура продукта на входе, К. */
  typicalInletTemp: number;
}

export const FLUIDS: Record<string, FluidPreset> = {
  'light-crude': {
    name: 'light-crude',
    phase: 'liquid',
    density: { model: 'linear', rho20: 850, xi: 0.7 },
    viscosity: { model: 'filonov-reynolds', nu0: 10e-6, T0: 293.15, u: 0.03 },
    heatCapacity: 2000,
    bulkModulus: 1.5e9,
    vaporPressure: 30e3,
    typicalInletTemp: 313.15,
  },
  'heavy-crude': {
    name: 'heavy-crude',
    phase: 'liquid',
    density: { model: 'linear', rho20: 930, xi: 0.6 },
    viscosity: { model: 'filonov-reynolds', nu0: 300e-6, T0: 293.15, u: 0.05 },
    heatCapacity: 1900,
    bulkModulus: 1.7e9,
    vaporPressure: 10e3,
    typicalInletTemp: 333.15,
  },
  diesel: {
    name: 'diesel',
    phase: 'liquid',
    density: { model: 'linear', rho20: 840, xi: 0.72 },
    viscosity: { model: 'filonov-reynolds', nu0: 4e-6, T0: 293.15, u: 0.02 },
    heatCapacity: 2000,
    bulkModulus: 1.4e9,
    vaporPressure: 1e3,
    typicalInletTemp: 288.15,
  },
  water: {
    name: 'water',
    phase: 'liquid',
    density: { model: 'linear', rho20: 998.2, xi: 0.21 },
    viscosity: { model: 'filonov-reynolds', nu0: 1.004e-6, T0: 293.15, u: 0.021 },
    heatCapacity: 4182,
    bulkModulus: 2.2e9,
    vaporPressure: 2339,
    typicalInletTemp: 288.15,
  },
  'natural-gas': {
    name: 'natural-gas',
    phase: 'gas',
    density: { model: 'constant', rho: 0.75 },
    viscosity: { model: 'constant', nu: 1.4e-5 },
    heatCapacity: 2200,
    bulkModulus: 1.0e5,
    vaporPressure: 0,
    typicalInletTemp: 288.15,
  },
};

export const DEFAULT_FLUID = 'light-crude';

/** Эквивалентная шероховатость, м. */
export const ROUGHNESS = {
  'steel-new': 0.05e-3,
  'steel-old': 0.2e-3,
} as const;

/** Коэффициент теплопередачи, Вт/(м²·К). */
export const HEAT_TRANSFER = {
  underground: 2,
  aboveground: 5,
} as const;

export const DEFAULTS = {
  wallModulus: 2.1e11,
  /** Толщина стенки по умолчанию как доля диаметра (не меньше 5 мм). */
  wallThicknessFraction: 1 / 64,
  ambientTemp: 278.15,
  ambientPressure: 101325,
  rateHz: 10,
  /** Расчётная скорость потока для подбора режима по умолчанию, м/с. */
  designVelocity: 1.5,
  /** Давление на всасе насоса и за задвижкой по умолчанию, Па (абс.). */
  suctionPressure: 0.3e6,
  downstreamPressure: 0.5e6,
  /** Запас давления над давлением паров по всей трассе, Па. */
  lineMarginPressure: 0.3e6,
  /** Перепад на задвижке в расчётном режиме, Па, и её открытие. */
  valveDrop: 0.3e6,
  valveOpening: 0.8,
  /** Напор насоса при нулевой подаче относительно рабочего. */
  pumpShutoffRatio: 1.25,
  /** Интервал промежуточных датчиков давления по умолчанию, м. */
  sensorSpacing: 15000,
  sensors: {
    p: { noisePctOfRange: 0.2, lagSec: 0.5 },
    q: { noisePctOfRange: 0.5, lagSec: 1.0 },
    T: { noiseK: 0.1, lagSec: 5.0 },
  },
} as const;

/** Сетка по умолчанию: Δx ≈ 100 м, от 50 до 1000 отрезков (H-A7). */
export function defaultGridStep(length: number): number {
  const n = Math.min(1000, Math.max(50, Math.round(length / 100)));
  return length / n;
}
