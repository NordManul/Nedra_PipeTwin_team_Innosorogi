/**
 * Коэффициент гидравлического трения λ (WP-A3).
 * Ламинарный 64/Re до Re = 2300, турбулентный — по выбранной формуле от Re = 4000,
 * между ними — гладкое смешивание (smoothstep), чтобы невязка не скакала при смене режима (T-A04).
 */
import type { FrictionModel } from './contracts';

export const RE_LAMINAR = 2300;
export const RE_TURBULENT = 4000;
const LN10 = Math.LN10;

export function haaland(Re: number, relRough: number): number {
  const x = -1.8 * Math.log10((relRough / 3.7) ** 1.11 + 6.9 / Re);
  return 1 / (x * x);
}

export function swameeJain(Re: number, relRough: number): number {
  const l = Math.log10(relRough / 3.7 + 5.74 / Re ** 0.9);
  return 0.25 / (l * l);
}

/** Коулбрук–Уайт: метод Ньютона по x = 1/√λ от приближения Хааланда. */
export function colebrook(Re: number, relRough: number, maxIter = 8): number {
  let x = 1 / Math.sqrt(haaland(Re, relRough));
  const a = relRough / 3.7;
  const b = 2.51 / Re;
  for (let i = 0; i < maxIter; i++) {
    const arg = a + b * x;
    const F = x + 2 * Math.log10(arg);
    const dF = 1 + (2 * b) / (LN10 * arg);
    const dx = F / dF;
    x -= dx;
    if (Math.abs(dx) < 1e-12 * x) break;
  }
  return 1 / (x * x);
}

export function turbulentFriction(Re: number, relRough: number, model: FrictionModel): number {
  switch (model) {
    case 'colebrook':
      return colebrook(Re, relRough);
    case 'swamee-jain':
      return swameeJain(Re, relRough);
    case 'haaland':
      return haaland(Re, relRough);
  }
}

/** λ(Re, ε/D) во всём диапазоне Re > 0. */
export function frictionFactor(Re: number, relRough: number, model: FrictionModel = 'colebrook'): number {
  if (!(Re > 0)) return 0;
  if (Re <= RE_LAMINAR) return 64 / Re;
  if (Re >= RE_TURBULENT) return turbulentFriction(Re, relRough, model);
  const s = (Re - RE_LAMINAR) / (RE_TURBULENT - RE_LAMINAR);
  const w = s * s * (3 - 2 * s);
  return (1 - w) * (64 / Re) + w * turbulentFriction(Re, relRough, model);
}

/**
 * Градиент потерь на трение, Па/м, со знаком потока: λ·ρ·v|v|/(2D).
 * m — массовый расход, кг/с; rho — кг/м³; mu — Па·с; D — м; A — м²; eps — м.
 */
export function frictionGradient(
  m: number,
  rho: number,
  mu: number,
  D: number,
  A: number,
  eps: number,
  model: FrictionModel,
): number {
  if (m === 0) return 0;
  const v = m / (rho * A);
  const Re = (rho * Math.abs(v) * D) / mu;
  if (Re <= RE_LAMINAR) return (32 * mu * v) / (D * D);
  const lambda = frictionFactor(Re, eps / D, model);
  return (lambda * rho * v * Math.abs(v)) / (2 * D);
}
