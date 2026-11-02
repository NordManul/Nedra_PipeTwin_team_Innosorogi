/**
 * Стационарный расчёт вдоль трубы (WP-A4). Дискретизация совпадает с методом характеристик:
 * свойства отрезка берутся в его левом узле, перепад высот — точный. Поэтому стационарный профиль —
 * неподвижная точка MOC, и plant стартует без паразитных волн (T-A11).
 *
 * dp/dx = −λ·ρ·v|v|/(2D) − ρ·g·dz/dx;  T — по Шухову на каждом отрезке.
 */
import { findRoot } from '../math/roots';
import { G, PipeModel } from './pipe';

/** Точечный отбор массы в узле (утечка с известным расходом), кг/с. */
export interface PointSink {
  x: number;
  m: number;
}

export interface SteadyProfile {
  x: Float64Array;
  /** Давление в узлах, Па (абс.). */
  p: Float64Array;
  /** Массовый расход на отрезках (N значений), кг/с; отрезок i — между узлами i и i+1. */
  mSeg: Float64Array;
  /** Температура в узлах, К. */
  T: Float64Array;
  /** Плотность и вязкость отрезков (по левому узлу). */
  rhoSeg: Float64Array;
  muSeg: Float64Array;
}

function segmentFlows(model: PipeModel, mIn: number, sinks: PointSink[]): Float64Array {
  const m = new Float64Array(model.N).fill(mIn);
  for (const s of sinks) {
    const node = model.nodeAt(s.x, true);
    for (let i = node; i < model.N; i++) m[i]! -= s.m;
  }
  return m;
}

function segmentProps(model: PipeModel, T: Float64Array): { rho: Float64Array; mu: Float64Array } {
  const rho = new Float64Array(model.N);
  const mu = new Float64Array(model.N);
  for (let i = 0; i < model.N; i++) {
    rho[i] = model.fluid.rho(T[i]!);
    mu[i] = model.fluid.mu(T[i]!);
  }
  return { rho, mu };
}

/** Интегрирование от входа: известны давление и массовый расход на входе. */
export function steadyForward(model: PipeModel, pIn: number, mIn: number, Tin: number, sinks: PointSink[] = []): SteadyProfile {
  const mSeg = segmentFlows(model, mIn, sinks);
  const T = model.thermalProfile(mSeg, Tin);
  const { rho, mu } = segmentProps(model, T);
  const p = new Float64Array(model.N + 1);
  p[0] = pIn;
  for (let i = 0; i < model.N; i++) {
    p[i + 1] = p[i]! - model.dx * model.fgrad(mSeg[i]!, rho[i]!, mu[i]!) - rho[i]! * G * (model.z[i + 1]! - model.z[i]!);
  }
  return { x: model.x, p, mSeg, T, rhoSeg: rho, muSeg: mu };
}

/** Интегрирование назад от выхода: известны давление и массовый расход на выходе. */
export function steadyBackward(model: PipeModel, pOut: number, mOut: number, Tin: number, sinks: PointSink[] = []): SteadyProfile {
  const total = sinks.reduce((s, k) => s + k.m, 0);
  const mSeg = segmentFlows(model, mOut + total, sinks);
  const T = model.thermalProfile(mSeg, Tin);
  const { rho, mu } = segmentProps(model, T);
  const p = new Float64Array(model.N + 1);
  p[model.N] = pOut;
  for (let i = model.N - 1; i >= 0; i--) {
    p[i] = p[i + 1]! + model.dx * model.fgrad(mSeg[i]!, rho[i]!, mu[i]!) + rho[i]! * G * (model.z[i + 1]! - model.z[i]!);
  }
  return { x: model.x, p, mSeg, T, rhoSeg: rho, muSeg: mu };
}

/** Начальное приближение массового расхода по перепаду давления (турбулентный режим, λ ≈ 0,02). */
export function guessMassFlow(model: PipeModel, pIn: number, pOut: number, Tin: number): number {
  const rho = model.fluid.rho(Tin);
  const dpf = pIn - pOut - rho * G * (model.z[model.N]! - model.z[0]!);
  const v = Math.sign(dpf) * Math.sqrt((2 * model.D * Math.abs(dpf)) / (0.02 * rho * model.L));
  return rho * model.A * v;
}

/**
 * Режим (p_вх, p_вых): расход методом стрельбы (Брент) так, чтобы давление на выходе совпало.
 */
export function steadyFromPressures(model: PipeModel, pIn: number, pOut: number, Tin: number, sinks: PointSink[] = []): SteadyProfile {
  const m0 = guessMassFlow(model, pIn, pOut, Tin);
  const f = (m: number) => steadyForward(model, pIn, m, Tin, sinks).p[model.N]! - pOut;
  const step = Math.max(Math.abs(m0) * 0.3, 1);
  const m = findRoot(f, m0, step, { tol: 1e-9 * Math.max(1, Math.abs(m0)) });
  return steadyForward(model, pIn, m, Tin, sinks);
}

/** Объёмный расход в узле, м³/с: по отрезку справа (для выхода — по последнему отрезку). */
export function nodeFlow(profile: SteadyProfile, node: number): number {
  const seg = Math.min(node, profile.mSeg.length - 1);
  return profile.mSeg[seg]! / profile.rhoSeg[seg]!;
}
