/**
 * D4: баланс массы с поправкой на аккумуляцию (ТЗ, WP-B2).
 *   I = Q_вх − Q_вых·ρ_вых/ρ_вх − (V/K_эфф)·dp̄/dt,
 * сглаженное за windowSec; базовая линия и σ — по прогреву. Работает по замерам, без twin.
 * Оценка расхода утечки (WP-B5) — отклонение I от базовой линии.
 */
import type { DetectorParams, SensorSpec } from '@pipetwin/core/contracts';
import { madSigma, median, PipeModel } from '@pipetwin/core';
import type { PreparedSample, StatContext, Statistic, StatOut } from '../types';
import { ewmaAlpha, RollingWindow } from '../util';

export class MassBalanceStat implements Statistic {
  private readonly qIn: SensorSpec;
  private readonly qOut: SensorSpec;
  private readonly tIn?: SensorSpec;
  private readonly tOut?: SensorSpec;
  private readonly ps: SensorSpec[];
  private readonly C: number;
  private readonly model: PipeModel;
  private readonly n: number;
  private readonly flow: RollingWindow;
  private readonly pbar: RollingWindow;
  private readonly warmI: number[] = [];
  private mu = 0;
  private sigma = NaN;
  private onset: number | undefined;

  constructor(private readonly sc: StatContext, private readonly p: DetectorParams) {
    const cfg = sc.ctx.config;
    const L = cfg.geometry.length;
    const ss = sc.ctx.sensors;
    this.qIn = ss.find((s) => s.kind === 'q' && s.x === 0)!;
    this.qOut = ss.find((s) => s.kind === 'q' && s.x === L)!;
    this.tIn = ss.find((s) => s.kind === 'T' && s.x === 0);
    this.tOut = ss.find((s) => s.kind === 'T' && s.x === L);
    this.ps = ss.filter((s) => s.kind === 'p').sort((a, b) => a.x - b.x);
    this.model = new PipeModel(cfg);
    this.C = (this.model.A * L) / this.model.effectiveBulkModulus();
    this.n = Math.max(2, Math.round(p.windowSec! / sc.binSec));
    this.flow = new RollingWindow(this.n);
    this.pbar = new RollingWindow(this.n + 1);
  }

  /** Средневзвешенное по длине давление по доступным датчикам (трапеции). */
  private meanPressure(raw: Record<string, number>): number | undefined {
    const pts = this.ps.filter((s) => raw[s.id] !== undefined).map((s) => [s.x, raw[s.id]!] as const);
    if (!pts.length) return undefined;
    if (pts.length === 1) return pts[0]![1];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) acc += 0.5 * (pts[i]![1] + pts[i - 1]![1]) * (pts[i]![0] - pts[i - 1]![0]);
    return acc / (pts[pts.length - 1]![0] - pts[0]![0]);
  }

  update(s: PreparedSample): StatOut {
    const thr = this.p.k!;
    const qi = s.raw[this.qIn.id];
    const qo = s.raw[this.qOut.id];
    const pm = this.meanPressure(s.raw);
    if (qi === undefined || qo === undefined || pm === undefined) return { score: 0, threshold: thr };
    const f = this.model.fluid;
    const ratio = this.tIn && this.tOut && s.raw[this.tIn.id] !== undefined && s.raw[this.tOut.id] !== undefined ? f.rho(s.raw[this.tOut.id]!) / f.rho(s.raw[this.tIn.id]!) : 1;
    this.flow.push(qi - qo * ratio);
    this.pbar.push(pm);
    if (!this.pbar.full) return { score: 0, threshold: thr };
    const dpdt = (this.pbar.back(0) - this.pbar.back(this.n)) / (this.n * this.sc.binSec);
    const I = this.flow.mean() - this.C * dpdt;
    if (!s.warm) {
      this.warmI.push(I);
      return { score: 0, threshold: thr };
    }
    if (!Number.isFinite(this.sigma)) {
      this.mu = this.warmI.length ? median(this.warmI) : I;
      this.sigma = Math.max(this.warmI.length > 5 ? madSigma(this.warmI) : 0, 1e-3 * Math.max(Math.abs(qi), 1e-6));
    }
    const z = (I - this.mu) / this.sigma;
    if (!this.sc.prep.frozen && Math.abs(z) < 3) this.mu += ewmaAlpha(this.sc.binSec, 600) * (I - this.mu);
    if (z <= 0.5 || this.onset === undefined) this.onset = s.t;
    return {
      score: z,
      threshold: thr,
      leakRate: Math.max(0, I - this.mu),
      channels: { [this.qIn.id]: Math.max(0, z / 2), [this.qOut.id]: Math.max(0, z / 2) },
      onset: this.onset,
    };
  }

  rearm(): void {
    this.onset = undefined;
  }
}
