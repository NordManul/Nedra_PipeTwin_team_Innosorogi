/**
 * D6: фильтр Калмана с расширенным состоянием (WP-B2) в форме банка фильтров по местам утечки.
 * Для каждого кандидата x_j — скалярное состояние «расход утечки» q (случайное блуждание),
 * измерения — нормированные невязки z, модель измерения — отклик twin на утечку в x_j.
 * Статистика — max_j q_j/σ(q_j); место — argmax; расход — q_j.
 */
import type { DetectorParams } from '@pipetwin/core/contracts';
import type { PreparedSample, StatContext, Statistic, StatOut } from '../types';

/** Период обновления откликов twin, с (рабочая точка может сместиться). */
const RESPONSE_REFRESH_SEC = 120;

export class KalmanStat implements Statistic {
  private xs: number[] = [];
  private H: Array<Record<string, number>> = [];
  private q: Float64Array = new Float64Array(0);
  private P: Float64Array = new Float64Array(0);
  private qNom = NaN;
  private builtAt = -Infinity;
  private onset: number | undefined;

  constructor(private readonly sc: StatContext, private readonly p: DetectorParams) {}

  private build(t: number): boolean {
    const twin = this.sc.ctx.twin;
    if (!twin?.leakResponse) return false;
    const L = this.sc.ctx.config.geometry.length;
    const n = Math.max(3, Math.round(this.p.positions!));
    this.qNom = Number.isFinite(this.sc.prep.nominalFlow) && this.sc.prep.nominalFlow > 0 ? this.sc.prep.nominalFlow : twin.profile?.()?.q[0] ?? 0.1;
    const qTest = 0.01 * this.qNom;
    this.xs = Array.from({ length: n }, (_, j) => (L * (j + 0.5)) / n);
    this.H = this.xs.map((x) => {
      const resp = twin.leakResponse!(x, qTest);
      const h: Record<string, number> = {};
      for (const [id, v] of Object.entries(resp)) {
        const sg = this.sc.prep.sigmaOf(id);
        if (sg && !this.sc.prep.isInput(id)) h[id] = v / qTest / sg;
      }
      return h;
    });
    if (this.q.length !== n) this.reset();
    this.builtAt = t;
    return true;
  }

  private reset(): void {
    const n = this.xs.length;
    this.q = new Float64Array(n);
    this.P = new Float64Array(n).fill((0.05 * this.qNom) ** 2);
  }

  update(s: PreparedSample): StatOut {
    const thr = this.p.k!;
    if (!s.warm) return { score: 0, threshold: thr };
    if (!this.H.length || (!this.sc.prep.frozen && s.t - this.builtAt > RESPONSE_REFRESH_SEC)) {
      if (!this.build(s.t)) return { score: 0, threshold: thr };
    }
    const Qn = (this.p.qProc! * this.qNom) ** 2 * s.dt;
    let best = 0;
    let bestScore = -Infinity;
    const scores = new Float64Array(this.xs.length);
    for (let j = 0; j < this.xs.length; j++) {
      const h = this.H[j]!;
      let info = 0;
      let hy = 0;
      for (const [id, z] of Object.entries(s.z)) {
        const hc = h[id];
        if (hc === undefined || !s.valid.has(id)) continue;
        info += hc * hc;
        hy += hc * z;
      }
      const Pp = this.P[j]! + Qn;
      const Pn = 1 / (1 / Pp + info);
      const qn = Pn * (this.q[j]! / Pp + hy);
      this.P[j] = Pn;
      this.q[j] = qn;
      scores[j] = qn / Math.sqrt(Pn);
      if (scores[j]! > bestScore) [best, bestScore] = [j, scores[j]!];
    }
    let lo = best;
    let hi = best;
    while (lo > 0 && scores[lo - 1]! >= bestScore - 1) lo--;
    while (hi < scores.length - 1 && scores[hi + 1]! >= bestScore - 1) hi++;
    const L = this.sc.ctx.config.geometry.length;
    const half = L / this.xs.length / 2;
    if (bestScore <= 0.5 || this.onset === undefined) this.onset = s.t;
    const ch: Record<string, number> = {};
    for (const [id, z] of Object.entries(s.z)) {
      const hc = this.H[best]![id];
      if (hc !== undefined) ch[id] = Math.max(0, hc * z * Math.sign(this.q[best]!));
    }
    return {
      score: bestScore,
      threshold: thr,
      location: this.xs[best]!,
      locationInterval: [Math.max(0, this.xs[lo]! - half), Math.min(L, this.xs[hi]! + half)],
      leakRate: Math.max(0, this.q[best]!),
      channels: ch,
      onset: this.onset,
    };
  }

  rearm(): void {
    if (this.xs.length) this.reset();
    this.onset = undefined;
  }
}
