/**
 * D8, D9: детекторы без физики (WP-B2) — страховка, если параметров трубы нет или twin не откалиброван.
 * Обучаются на окне прогрева (без утечки) по стандартизованным замерам всех датчиков.
 *  D8 — каждый датчик предсказывается по остальным (рекурсивные МНК с забыванием).
 *  D9 — PCA и статистика SPE (квадрат ошибки восстановления).
 */
import type { DetectorParams, SensorId } from '@pipetwin/core/contracts';
import { madSigma, mean, std, symEig } from '@pipetwin/core';
import type { PreparedSample, StatContext, Statistic, StatOut } from '../types';
import { ewmaAlpha } from '../util';

/** Общая часть: стандартизация по прогреву и сбор обучающих векторов. */
abstract class DataDriven implements Statistic {
  protected ids: SensorId[] = [];
  protected level: number[] = [];
  protected scale: number[] = [];
  protected trained = false;
  private readonly buffer: Array<Record<string, number>> = [];
  /** После rearm (принятая смена режима или снятая тревога) — переобучение на свежем окне. */
  private relearnUntil = -Infinity;
  private pendingRelearn = false;

  constructor(protected readonly sc: StatContext, protected readonly p: DetectorParams) {}

  protected vector(s: PreparedSample): number[] | null {
    const out: number[] = [];
    for (let i = 0; i < this.ids.length; i++) {
      const v = s.raw[this.ids[i]!];
      if (v === undefined || !s.valid.has(this.ids[i]!)) return null;
      out.push((v - this.level[i]!) / this.scale[i]!);
    }
    return out;
  }

  update(s: PreparedSample): StatOut {
    if (this.pendingRelearn) {
      this.pendingRelearn = false;
      this.relearnUntil = s.t + (this.p.relearnSec ?? 60);
      this.buffer.length = 0;
    }
    if (!s.warm || s.t < this.relearnUntil) {
      this.buffer.push({ ...s.raw });
      if (s.warm) this.trained = false;
      return { score: 0, threshold: this.p.thr! };
    }
    if (!this.trained) {
      this.ids = this.sc.ctx.sensors.map((x) => x.id).filter((id) => this.sc.prep.rawStats(id) && s.valid.has(id));
      this.level = this.ids.map((id) => this.sc.prep.rawStats(id)!.level);
      // масштаб — шум датчика: так «нормальный» разброс одинаков для всех каналов
      this.scale = this.ids.map((id) => this.sc.prep.rawStats(id)!.noise);
      const X = this.buffer
        .map((r) => this.ids.map((id, i) => (r[id] === undefined ? NaN : (r[id]! - this.level[i]!) / this.scale[i]!)))
        .filter((row) => row.every(Number.isFinite));
      this.train(X);
      this.buffer.length = 0;
      this.trained = true;
    }
    const x = this.vector(s);
    if (!x) return { score: 0, threshold: this.p.thr! };
    return this.score(x);
  }

  protected abstract train(X: number[][]): void;
  protected abstract score(x: number[]): StatOut;

  rearm(): void {
    this.pendingRelearn = true;
  }
}

/** D8: RLS-предсказание каждого датчика по остальным. */
export class RlsStat extends DataDriven {
  private W: number[][] = [];
  private Pm: number[][][] = [];
  private errSigma: number[] = [];
  private E: number[] = [];

  protected train(X: number[][]): void {
    const m = this.ids.length;
    this.W = [];
    this.Pm = [];
    this.errSigma = [];
    for (let i = 0; i < m; i++) {
      const w = new Array(m).fill(0);
      const P = Array.from({ length: m }, (_, a) => Array.from({ length: m }, (_, b) => (a === b ? 100 : 0)));
      const errs: number[] = [];
      for (const row of X) {
        const phi = this.phi(row, i);
        const e = row[i]! - dot(w, phi);
        errs.push(e);
        rlsStep(w, P, phi, e, 1);
      }
      this.W.push(w);
      this.Pm.push(P);
      const tail = errs.slice(Math.floor(errs.length / 3));
      this.errSigma.push(Math.max(tail.length > 5 ? madSigma(tail) : 1, 0.05));
    }
    this.E = new Array(m).fill(0);
  }

  /** Регрессоры для датчика i: остальные датчики и свободный член. */
  private phi(row: number[], i: number): number[] {
    const out = row.filter((_, k) => k !== i);
    out.push(1);
    return out;
  }

  protected score(x: number[]): StatOut {
    const lam = ewmaAlpha(this.sc.binSec, this.p.tauSec!);
    const sd = Math.sqrt(lam / (2 - lam));
    const forget = Math.exp(-this.sc.binSec / this.p.forgetSec!);
    const ch: Record<string, number> = {};
    let score = 0;
    for (let i = 0; i < x.length; i++) {
      const phi = this.phi(x, i);
      const e = (x[i]! - dot(this.W[i]!, phi)) / this.errSigma[i]!;
      this.E[i] = (1 - lam) * this.E[i]! + lam * e;
      const v = Math.abs(this.E[i]!) / sd;
      ch[this.ids[i]!] = v;
      score = Math.max(score, v);
      if (!this.sc.prep.frozen && Math.abs(e) < 3) rlsStep(this.W[i]!, this.Pm[i]!, phi, e * this.errSigma[i]!, forget);
    }
    return { score, threshold: this.p.thr!, channels: ch };
  }

}

/** D9: PCA по прогреву, статистика SPE. */
export class PcaStat extends DataDriven {
  private residualBasis: number[][] = [];
  private speMean = 1;
  private speStd = 1;
  private E = 0;

  protected train(X: number[][]): void {
    const m = this.ids.length;
    const C = Array.from({ length: m }, () => new Array(m).fill(0));
    for (const row of X) for (let a = 0; a < m; a++) for (let b = 0; b < m; b++) C[a]![b]! += (row[a]! * row[b]!) / Math.max(1, X.length - 1);
    const { values, vectors } = symEig(C);
    const total = values.reduce((acc, v) => acc + Math.max(v, 0), 0) || 1;
    let k = 0;
    let cum = 0;
    while (k < m - 1 && cum / total < this.p.varExplained!) cum += Math.max(values[k++]!, 0);
    k = Math.max(1, Math.min(k, m - 1));
    this.residualBasis = vectors.slice(k);
    const lam = ewmaAlpha(this.sc.binSec, this.p.tauSec!);
    let E = this.spe(X[0] ?? new Array(m).fill(0));
    const series: number[] = [];
    for (const row of X) {
      E = (1 - lam) * E + lam * this.spe(row);
      series.push(E);
    }
    const tail = series.slice(Math.floor(series.length / 3));
    this.speMean = tail.length ? mean(tail) : 1;
    this.speStd = Math.max(tail.length > 5 ? std(tail) : 1, 1e-6);
    this.E = this.speMean;
  }

  private spe(x: number[]): number {
    let s = 0;
    for (const v of this.residualBasis) {
      const c = dot(v, x);
      s += c * c;
    }
    return s;
  }

  protected score(x: number[]): StatOut {
    const lam = ewmaAlpha(this.sc.binSec, this.p.tauSec!);
    this.E = (1 - lam) * this.E + lam * this.spe(x);
    const ch: Record<string, number> = {};
    // вклад датчика — квадрат его компоненты в остаточном подпространстве
    const res = new Array(x.length).fill(0);
    for (const v of this.residualBasis) {
      const c = dot(v, x);
      for (let i = 0; i < x.length; i++) res[i] += c * v[i]!;
    }
    this.ids.forEach((id, i) => (ch[id] = res[i]! * res[i]!));
    return { score: (this.E - this.speMean) / this.speStd, threshold: this.p.thr!, channels: ch };
  }

}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Шаг рекурсивного МНК с забыванием: w += K·e, P = (P − K·φᵀP)/λ. */
function rlsStep(w: number[], P: number[][], phi: number[], e: number, lambda: number): void {
  const n = phi.length;
  const Pphi = P.map((row) => dot(row, phi));
  const denom = lambda + dot(phi, Pphi);
  const K = Pphi.map((v) => v / denom);
  for (let i = 0; i < n; i++) w[i]! += K[i]! * e;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) P[i]![j] = (P[i]![j]! - K[i]! * Pphi[j]!) / lambda;
}
