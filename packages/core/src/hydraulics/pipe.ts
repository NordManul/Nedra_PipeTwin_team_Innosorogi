/**
 * Модель трубы на расчётной сетке: геометрия, профиль высот, свойства среды, скорость волны.
 * Общая для стационарного расчёта (twin) и метода характеристик (plant и нестационарный twin).
 */
import type { FrictionModel, PipelineConfig, ThermalMode } from '../contracts';
import { createFluid, type FluidModel } from '../fluid';
import { frictionGradient } from '../friction';
import { evalSchedule } from '../schedule';
import { interp } from '../math/stats';

export const G = 9.80665;

export class PipeModel {
  readonly cfg: PipelineConfig;
  readonly L: number;
  readonly D: number;
  readonly A: number;
  readonly eps: number;
  /** Число отрезков сетки; узлов N + 1. */
  readonly N: number;
  readonly dx: number;
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly fluid: FluidModel;
  readonly friction: FrictionModel;
  readonly thermalMode: ThermalMode;
  /** Множитель экспоненты Шухова на один отрезок без деления на G·cp: k·π·D·dx. */
  readonly heatLossPerSegment: number;
  readonly Tenv: number;
  readonly pAtm: number;

  constructor(cfg: PipelineConfig) {
    this.cfg = cfg;
    const g = cfg.geometry;
    this.L = g.length;
    this.D = g.diameter;
    this.A = (Math.PI * g.diameter * g.diameter) / 4;
    this.eps = g.roughness;
    this.N = Math.max(2, Math.round(g.length / cfg.numerics.dx));
    this.dx = g.length / this.N;
    this.x = new Float64Array(this.N + 1);
    this.z = new Float64Array(this.N + 1);
    const ex = g.elevation.map((p) => p[0]);
    const ez = g.elevation.map((p) => p[1]);
    for (let i = 0; i <= this.N; i++) {
      this.x[i] = i * this.dx;
      this.z[i] = interp(this.x[i]!, ex, ez);
    }
    this.fluid = createFluid(cfg.fluid);
    this.friction = cfg.numerics.frictionModel;
    this.thermalMode = cfg.numerics.thermalMode;
    this.heatLossPerSegment = cfg.thermal.heatTransferCoef * Math.PI * this.D * this.dx;
    this.Tenv = cfg.thermal.ambientTemp;
    this.pAtm = cfg.ambientPressure;
  }

  /** Градиент потерь на трение, Па/м, на отрезке со свойствами rho, mu. */
  fgrad(m: number, rho: number, mu: number): number {
    return frictionGradient(m, rho, mu, this.D, this.A, this.eps, this.friction);
  }

  /** Скорость волны давления (Жуковский–Кортевег), м/с. */
  waveSpeed(T = this.inletTemp(0)): number {
    if (this.cfg.numerics.waveSpeed) return this.cfg.numerics.waveSpeed;
    const g = this.cfg.geometry;
    const K = this.fluid.bulkModulus;
    const rho = this.fluid.rho(T);
    return Math.sqrt(K / rho / (1 + (K * g.diameter) / (g.wallModulus * g.wallThickness)));
  }

  /** Эффективный модуль упругости системы «жидкость + стенка», Па (для аккумуляции в D4). */
  effectiveBulkModulus(): number {
    const g = this.cfg.geometry;
    const K = this.fluid.bulkModulus;
    return K / (1 + (K * g.diameter) / (g.wallModulus * g.wallThickness));
  }

  inletTemp(t: number): number {
    return evalSchedule(this.cfg.boundary.inletTemp, t);
  }

  /** Ближайший узел к координате x (для утечек — только внутренние узлы). */
  nodeAt(x: number, interior = false): number {
    const i = Math.round(x / this.dx);
    const lo = interior ? 1 : 0;
    const hi = interior ? this.N - 1 : this.N;
    return Math.min(hi, Math.max(lo, i));
  }

  /**
   * Температурный профиль по Шухову для расходов по отрезкам (точное решение на каждом отрезке
   * при постоянной cp). При thermalMode = 'none' — температура входа по всей длине.
   */
  thermalProfile(mSeg: ArrayLike<number>, Tin: number, out = new Float64Array(this.N + 1)): Float64Array {
    out[0] = Tin;
    if (this.thermalMode === 'none') {
      out.fill(Tin);
      return out;
    }
    const cp = this.fluid.cp;
    for (let i = 0; i < this.N; i++) {
      const m = Math.abs(mSeg[i]!);
      const f = m > 1e-9 ? Math.exp(-this.heatLossPerSegment / (m * cp)) : 0;
      out[i + 1] = this.Tenv + (out[i]! - this.Tenv) * f;
    }
    return out;
  }
}
