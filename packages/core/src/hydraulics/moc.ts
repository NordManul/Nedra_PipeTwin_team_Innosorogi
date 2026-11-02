/**
 * Метод характеристик (WP-A5) в переменных «давление p — массовый расход m».
 *
 *   C+:  p_P = C_P − B·m_P,  C_P = p_A + B·m_A − Δx·F(m_A) − ρ·g·(z_P − z_A)
 *   C−:  p_P = C_M + B·m_P,  C_M = p_B − B·m_B + Δx·F(m_B) + ρ·g·(z_B − z_P)
 *   B = a/A,  Δt = Δx/a,  F — градиент потерь на трение, Па/м.
 *
 * Свойства отрезка (ρ, μ) берутся в его левом узле — так же, как в стационарном расчёте,
 * поэтому стационарный профиль — точная неподвижная точка схемы.
 * Утечка в узле — истечение через отверстие q = Cd·A·√(2·p_изб/ρ), решается вместе с характеристиками.
 * Массивы — Float64Array, в горячем цикле нет объектов.
 */
import { frictionFactor, RE_LAMINAR } from '../friction';
import { G, PipeModel } from './pipe';
import type { SteadyProfile } from './steady';

/** Граничное условие на шаге (значения уже вычислены на момент t + Δt). */
export type BoundarySpec =
  | { type: 'pressure'; p: number }
  | { type: 'flow'; m: number }
  /** Насос: p = ps + ρ·g·(H − b·Q²), Q = m/ρ. */
  | { type: 'pump'; ps: number; H: number; b: number }
  /** Задвижка перед резервуаром: m = c·√(ρ·(p − pd)), c = Cv·τ. */
  | { type: 'valve'; pd: number; c: number }
  | { type: 'closed' };

/** Утечка в узле: коэффициент k = Cd·A_отв·√(2ρ), m_утечки = k·√(p − p_атм). */
export interface NodeLeak {
  node: number;
  k: number;
}

/**
 * Кэш λ по отрезкам: в окрестности ±RE_TOL закэшированного Re используется линеаризация
 * λ ≈ λ₀·(1 + s·(Re/Re₀ − 1)), s = d ln λ / d ln Re. Ошибка второго порядка (< 1e-4 относительно),
 * а точный пересчёт по формуле трения нужен только при заметной смене режима.
 */
const RE_TOL = 0.05;

export class MocSolver {
  readonly model: PipeModel;
  readonly a: number;
  readonly B: number;
  readonly dt: number;
  t = 0;
  /** Давление в узлах, Па. */
  p: Float64Array;
  /** Расход слева и справа от узла, кг/с (различаются только в узле с утечкой). */
  mL: Float64Array;
  mR: Float64Array;
  T: Float64Array;
  rhoSeg: Float64Array;
  muSeg: Float64Array;
  /** Расход каждой утечки на последнем шаге, кг/с (по порядку массива leaks). */
  leakFlows = new Float64Array(0);
  /** Сколько раз давление ограничивалось давлением насыщенных паров. */
  vaporClamps = 0;

  private pN: Float64Array;
  private mLN: Float64Array;
  private mRN: Float64Array;
  private leakAt: Int32Array;
  private thermalCounter = 0;
  /** Кэш λ по отрезкам: пересчёт только при изменении Re больше чем на RE_TOL (относительно). */
  private reCache: Float64Array;
  private lamCache: Float64Array;
  private slopeCache: Float64Array;

  constructor(model: PipeModel, waveSpeed = model.waveSpeed()) {
    this.model = model;
    this.a = waveSpeed;
    this.B = waveSpeed / model.A;
    this.dt = model.dx / waveSpeed;
    const n = model.N + 1;
    this.p = new Float64Array(n);
    this.mL = new Float64Array(n);
    this.mR = new Float64Array(n);
    this.T = new Float64Array(n);
    this.rhoSeg = new Float64Array(model.N);
    this.muSeg = new Float64Array(model.N);
    this.pN = new Float64Array(n);
    this.mLN = new Float64Array(n);
    this.mRN = new Float64Array(n);
    this.leakAt = new Int32Array(n).fill(-1);
    this.reCache = new Float64Array(model.N).fill(-1);
    this.lamCache = new Float64Array(model.N);
    this.slopeCache = new Float64Array(model.N);
  }

  /** Градиент трения на отрезке seg при расходе m, Па/м (с кэшем λ). */
  private fg(m: number, seg: number): number {
    if (m === 0) return 0;
    const model = this.model;
    const rho = this.rhoSeg[seg]!;
    const mu = this.muSeg[seg]!;
    const D = model.D;
    const v = m / (rho * model.A);
    const av = Math.abs(v);
    const Re = (rho * av * D) / mu;
    if (Re <= RE_LAMINAR) return (32 * mu * v) / (D * D);
    const rc = this.reCache[seg]!;
    let lam: number;
    const dr = Re / rc - 1;
    if (rc > 0 && dr <= RE_TOL && dr >= -RE_TOL) lam = this.lamCache[seg]! * (1 + this.slopeCache[seg]! * dr);
    else {
      const rr = model.eps / D;
      lam = frictionFactor(Re, rr, model.friction);
      const lam2 = frictionFactor(Re * 1.01, rr, model.friction);
      this.reCache[seg] = Re;
      this.lamCache[seg] = lam;
      this.slopeCache[seg] = Math.log(lam2 / lam) / Math.log(1.01);
    }
    return (lam * rho * v * av) / (2 * D);
  }

  /** Установить состояние из стационарного профиля. */
  setState(s: SteadyProfile, t = 0): void {
    const N = this.model.N;
    this.p.set(s.p);
    this.T.set(s.T);
    this.rhoSeg.set(s.rhoSeg);
    this.muSeg.set(s.muSeg);
    for (let i = 0; i <= N; i++) {
      this.mL[i] = s.mSeg[Math.max(0, i - 1)]!;
      this.mR[i] = s.mSeg[Math.min(N - 1, i)]!;
    }
    this.t = t;
  }

  /** Расход на отрезке i (между узлами i и i+1), кг/с. */
  segFlow(i: number): number {
    return 0.5 * (this.mR[i]! + this.mL[i + 1]!);
  }

  /** Один шаг Δt. Tin — температура на входе на новом шаге. */
  step(inlet: BoundarySpec, outlet: BoundarySpec, leaks: NodeLeak[] = [], Tin?: number): void {
    const { model, B } = this;
    const N = model.N;
    const dx = model.dx;
    const z = model.z;
    const p = this.p;
    const mL = this.mL;
    const mR = this.mR;
    const rho = this.rhoSeg;
    const pN = this.pN;
    const mLN = this.mLN;
    const mRN = this.mRN;
    const pv = model.fluid.vaporPressure;
    const pAtm = model.pAtm;

    if (this.leakFlows.length !== leaks.length) this.leakFlows = new Float64Array(leaks.length);
    const leakAt = this.leakAt;
    for (let j = 0; j < leaks.length; j++) leakAt[leaks[j]!.node] = j;

    for (let i = 1; i < N; i++) {
      const sA = i - 1;
      const mA = mR[sA]!;
      const CP = p[sA]! + B * mA - dx * this.fg(mA, sA) - rho[sA]! * G * (z[i]! - z[sA]!);
      const mB = mL[i + 1]!;
      const CM = p[i + 1]! - B * mB + dx * this.fg(mB, i) + rho[i]! * G * (z[i + 1]! - z[i]!);
      const j = leakAt[i]!;
      let pp: number;
      let mUp: number;
      let mDn: number;
      if (j < 0) {
        const m = (CP - CM) / (2 * B);
        pp = 0.5 * (CP + CM);
        mUp = m;
        mDn = m;
      } else {
        const k = leaks[j]!.k;
        const S = CP + CM - 2 * pAtm;
        let y = 0;
        if (S > 0 && k > 0) {
          const bk = B * k;
          y = (-bk + Math.sqrt(bk * bk + 8 * S)) / 4;
        }
        pp = S > 0 ? pAtm + y * y : 0.5 * (CP + CM);
        mUp = (CP - pp) / B;
        mDn = (pp - CM) / B;
        this.leakFlows[j] = mUp - mDn;
      }
      if (pp < pv) {
        // Разрыв сплошности: ограничиваем давление (упрощённо, без модели каверны).
        pp = pv;
        mUp = (CP - pp) / B;
        mDn = (pp - CM) / B;
        this.vaporClamps++;
      }
      pN[i] = pp;
      mLN[i] = mUp;
      mRN[i] = mDn;
    }

    // Вход: доступна только характеристика C− от узла 1.
    {
      const mB = mL[1]!;
      const CM = p[1]! - B * mB + dx * this.fg(mB, 0) + rho[0]! * G * (z[1]! - z[0]!);
      let m0: number;
      let p0: number;
      switch (inlet.type) {
        case 'pressure':
          p0 = inlet.p;
          m0 = (p0 - CM) / B;
          break;
        case 'flow':
          m0 = inlet.m;
          p0 = CM + B * m0;
          break;
        case 'pump': {
          const r = rho[0]!;
          const a2 = (G * inlet.b) / r;
          const c0 = CM - inlet.ps - r * G * inlet.H;
          if (a2 < 1e-12) m0 = -c0 / B;
          else {
            const disc = B * B - 4 * a2 * c0;
            m0 = disc > 0 ? (-B + Math.sqrt(disc)) / (2 * a2) : -B / (2 * a2);
          }
          p0 = CM + B * m0;
          break;
        }
        case 'valve':
        case 'closed':
          m0 = 0;
          p0 = CM;
          break;
      }
      pN[0] = p0;
      mLN[0] = m0;
      mRN[0] = m0;
    }

    // Выход: доступна только характеристика C+ от узла N−1.
    {
      const sA = N - 1;
      const mA = mR[sA]!;
      const CP = p[sA]! + B * mA - dx * this.fg(mA, sA) - rho[sA]! * G * (z[N]! - z[sA]!);
      let mN: number;
      let pNv: number;
      switch (outlet.type) {
        case 'pressure':
          pNv = outlet.p;
          mN = (CP - pNv) / B;
          break;
        case 'flow':
          mN = outlet.m;
          pNv = CP - B * mN;
          break;
        case 'valve': {
          const c2 = outlet.c * outlet.c * rho[sA]!;
          const d = CP - outlet.pd;
          mN = d > 0 ? (-c2 * B + Math.sqrt(c2 * c2 * B * B + 4 * c2 * d)) / 2 : 0;
          pNv = CP - B * mN;
          break;
        }
        case 'pump':
        case 'closed':
          mN = 0;
          pNv = CP;
          break;
      }
      pN[N] = pNv;
      mLN[N] = mN;
      mRN[N] = mN;
    }

    for (let j = 0; j < leaks.length; j++) leakAt[leaks[j]!.node] = -1;
    this.pN = p;
    this.mLN = mL;
    this.mRN = mR;
    this.p = pN;
    this.mL = mLN;
    this.mR = mRN;
    this.t += this.dt;
    this.updateThermal(Tin ?? this.T[0]!);
  }

  /** Обновление температуры по режиму WP-A6. */
  private updateThermal(Tin: number): void {
    const model = this.model;
    const N = model.N;
    if (model.thermalMode === 'none') {
      if (this.T[0] !== Tin) {
        this.T.fill(Tin);
        this.refreshProps();
      }
      return;
    }
    if (model.thermalMode === 'quasi-steady') {
      // Профиль Шухова по текущим расходам — раз в 10 шагов (≈ 1 с при Δx = 100 м).
      if (++this.thermalCounter < 10 && this.T[0] === Tin) return;
      this.thermalCounter = 0;
      const mSeg = new Float64Array(N);
      for (let i = 0; i < N; i++) mSeg[i] = this.segFlow(i);
      model.thermalProfile(mSeg, Tin, this.T);
      this.refreshProps();
      return;
    }
    // advection: полулагранжев перенос по потоку + теплопотери за шаг.
    const T = this.T;
    const Tn = new Float64Array(N + 1);
    Tn[0] = Tin;
    const loss = model.cfg.thermal.heatTransferCoef * Math.PI * model.D;
    for (let i = 1; i <= N; i++) {
      const seg = i - 1;
      const v = this.segFlow(seg) / (this.rhoSeg[seg]! * model.A);
      const shift = (v * this.dt) / model.dx;
      const s = Math.min(1, Math.max(0, shift));
      const Tup = T[i]! + s * (T[i - 1]! - T[i]!);
      const f = Math.exp((-loss * this.dt) / (this.rhoSeg[seg]! * model.A * model.fluid.cp));
      Tn[i] = model.Tenv + (Tup - model.Tenv) * f;
    }
    this.T.set(Tn);
    this.refreshProps();
  }

  private refreshProps(): void {
    const f = this.model.fluid;
    for (let i = 0; i < this.model.N; i++) {
      this.rhoSeg[i] = f.rho(this.T[i]!);
      this.muSeg[i] = f.mu(this.T[i]!);
    }
  }

  /** Объёмный расход в узле, м³/с (справа от узла; на выходе — слева). */
  nodeQ(i: number): number {
    const N = this.model.N;
    const seg = Math.min(i, N - 1);
    const m = i >= N ? this.mL[N]! : this.mR[i]!;
    return m / this.rhoSeg[seg]!;
  }
}
