/**
 * Свойства среды (WP-A2). Модель выбирается строкой в конфиге, параметры — из конфига.
 */
import type { DensityModel, Fluid, ViscosityModel } from './contracts';

export interface FluidModel {
  readonly name: string;
  readonly phase: 'liquid' | 'gas';
  /** Плотность, кг/м³, при температуре T (К) и давлении p (Па, абс.). Для жидкости от p не зависит. */
  rho(T: number, p?: number): number;
  /** Кинематическая вязкость, м²/с. */
  nu(T: number): number;
  /** Динамическая вязкость, Па·с. */
  mu(T: number, p?: number): number;
  /** Теплоёмкость, Дж/(кг·К). */
  readonly cp: number;
  /** Объёмный модуль упругости, Па. */
  readonly bulkModulus: number;
  /** Давление насыщенных паров, Па (абс.). */
  readonly vaporPressure: number;
}

const T20 = 293.15;
/** Нормальные условия для газа: плотность в конфиге задана при них. */
const P_STD = 101325;

export function densityFn(m: DensityModel): (T: number) => number {
  switch (m.model) {
    case 'constant':
      return () => m.rho;
    case 'linear':
      return (T) => m.rho20 - m.xi * (T - T20);
  }
}

/** Параметры Вальтера (ASTM D341) по двум точкам: lg lg(ν_сСт + 0,7) = A − B·lg T. */
export function waltherCoefficients(points: [[number, number], [number, number]]): { A: number; B: number } {
  const [[T1, nu1], [T2, nu2]] = points;
  const w = (nu: number) => Math.log10(Math.log10(nu * 1e6 + 0.7));
  const B = (w(nu1) - w(nu2)) / (Math.log10(T2) - Math.log10(T1));
  const A = w(nu1) + B * Math.log10(T1);
  return { A, B };
}

export function viscosityFn(m: ViscosityModel): (T: number) => number {
  switch (m.model) {
    case 'constant':
      return () => m.nu;
    case 'filonov-reynolds':
      return (T) => m.nu0 * Math.exp(-m.u * (T - m.T0));
    case 'walther': {
      const { A, B } = waltherCoefficients(m.points);
      return (T) => (10 ** (10 ** (A - B * Math.log10(T))) - 0.7) * 1e-6;
    }
  }
}

export function createFluid(f: Fluid): FluidModel {
  const rhoT = densityFn(f.density);
  const nuT = viscosityFn(f.viscosity);
  if (f.phase === 'gas') {
    // Заготовка WP-A9: идеальный газ, плотность в конфиге — при нормальных условиях.
    return {
      name: f.name,
      phase: 'gas',
      rho: (T, p = P_STD) => (rhoT(T20) * (p / P_STD) * T20) / T,
      nu: nuT,
      mu: (T, p = P_STD) => nuT(T) * ((rhoT(T20) * (p / P_STD) * T20) / T),
      cp: f.heatCapacity,
      bulkModulus: f.bulkModulus,
      vaporPressure: f.vaporPressure,
    };
  }
  return {
    name: f.name,
    phase: 'liquid',
    rho: (T) => rhoT(T),
    nu: nuT,
    mu: (T) => nuT(T) * rhoT(T),
    cp: f.heatCapacity,
    bulkModulus: f.bulkModulus,
    vaporPressure: f.vaporPressure,
  };
}
