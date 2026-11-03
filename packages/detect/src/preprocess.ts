/**
 * Предобработка (WP-B1).
 *  - Пересэмплирование на равномерную сетку binSec: детекторы не зависят от частоты опроса (T-B04).
 *  - Пропуски: удержание значения до maxGapSec, дальше датчик недостоверен (T-B05).
 *  - Одиночные выбросы: отсев с задержкой в один шаг сетки (T-B06).
 *  - Шум σ и смещение μ невязки каждого датчика: медиана и MAD на окне прогрева, затем медленное
 *    подтягивание; замораживается при подозрении на утечку, чтобы оценки не «съели» утечку.
 *  - Нормировка z = (r − μ)/σ и знак утечки по отклику twin: e = знак·z.
 *  - Здоровье датчика: нет данных, залипание, выход за шкалу — флаг, а не тревога.
 */
import type { DetectorContext, SensorFrame, SensorId, SensorSpec, TwinPrediction } from '@pipetwin/core/contracts';
import { madSigma, median } from '@pipetwin/core';
import { SUM, type PreparedSample } from './types';
import { ewmaAlpha } from './util';

export interface PreprocessOptions {
  binSec: number;
  warmupSec: number;
  maxGapSec: number;
  /** Постоянные времени подтягивания смещения и шума, с. */
  baselineTauSec: number;
  sigmaTauSec: number;
  /** Порог одиночного выброса, σ. */
  spikeSigma: number;
  /** Залипание: значение не меняется дольше, с. */
  stuckSec: number;
}

export const DEFAULT_PREPROCESS: PreprocessOptions = {
  binSec: 0.1,
  warmupSec: 60,
  maxGapSec: 2,
  baselineTauSec: 120,
  sigmaTauSec: 600,
  spikeSigma: 6,
  stuckSec: 5,
};

interface Acc {
  raw: number;
  nRaw: number;
  pred: number;
  nPred: number;
}

export class Preprocessor {
  readonly opts: PreprocessOptions;
  readonly sensors: SensorSpec[];
  readonly ctx: DetectorContext;
  warm = false;
  frozen = false;
  /** Знак отклика датчика на утечку (+1, −1, 0) и вес в суммарном канале. */
  readonly signs = new Map<SensorId, number>();
  readonly weights = new Map<SensorId, number>();
  /** Номинальный расход на входе, м³/с (оценка по прогреву). */
  nominalFlow = NaN;

  private readonly mu = new Map<SensorId, number>();
  private readonly sigma = new Map<SensorId, number>();
  private readonly rawLevel = new Map<SensorId, number>();
  private readonly rawSpread = new Map<SensorId, number>();
  private readonly rawNoiseMap = new Map<SensorId, number>();
  private readonly health = new Map<SensorId, string>();
  private readonly excluded = new Set<SensorId>();
  private readonly lastSeen = new Map<SensorId, number>();
  private readonly lastRaw = new Map<SensorId, number>();
  private readonly sameSince = new Map<SensorId, number>();
  private readonly edgeSince = new Map<SensorId, number>();
  private readonly warmR = new Map<SensorId, number[]>();
  private readonly warmRaw = new Map<SensorId, number[]>();
  private acc = new Map<SensorId, Acc>();
  private inputs = new Set<SensorId>();
  private curBin = -1;
  private tStart = NaN;
  private lastSampleT = NaN;
  private prevOut: PreparedSample | null = null;
  private pending: PreparedSample | null = null;
  private fastUntil = -Infinity;

  constructor(ctx: DetectorContext, opts: Partial<PreprocessOptions> = {}) {
    this.ctx = ctx;
    this.sensors = ctx.sensors;
    const o = { ...DEFAULT_PREPROCESS, ...opts };
    // на редком опросе (1 Гц) сетка не мельче периода опроса
    o.binSec = Math.max(o.binSec, 1 / ctx.sampleRateHz - 1e-9);
    this.opts = o;
  }

  /** Принять кадр и прогноз; вернуть готовые отсчёты сетки (с задержкой в один шаг). */
  push(frame: SensorFrame, pred: TwinPrediction | null): PreparedSample[] {
    const bin = Math.floor(frame.t / this.opts.binSec + 1e-9);
    const out: PreparedSample[] = [];
    if (this.curBin < 0) this.curBin = bin;
    if (bin > this.curBin) {
      this.emit(this.finalize(this.curBin), out);
      this.curBin = bin;
      this.acc = new Map();
    }
    for (const [id, v] of Object.entries(frame.values)) {
      if (frame.valid?.[id] === false || !Number.isFinite(v)) continue;
      const a = this.accFor(id);
      a.raw += v;
      a.nRaw++;
      this.lastSeen.set(id, frame.t);
    }
    if (pred?.ok) {
      this.inputs = new Set(pred.inputs);
      for (const [id, v] of Object.entries(pred.values)) {
        if (this.inputs.has(id) || !Number.isFinite(v)) continue;
        const a = this.accFor(id);
        a.pred += v;
        a.nPred++;
      }
    }
    return out;
  }

  private accFor(id: SensorId): Acc {
    let a = this.acc.get(id);
    if (!a) {
      a = { raw: 0, nRaw: 0, pred: 0, nPred: 0 };
      this.acc.set(id, a);
    }
    return a;
  }

  private emit(s: PreparedSample, out: PreparedSample[]): void {
    if (this.pending) {
      this.despike(this.pending, this.prevOut, s);
      out.push(this.pending);
      this.prevOut = this.pending;
    }
    this.pending = s;
  }

  /** Одиночный выброс: канал далеко от соседей по времени, а соседи спокойны. */
  private despike(s: PreparedSample, prev: PreparedSample | null, next: PreparedSample): void {
    if (!s.warm || !prev) return;
    const lim = this.opts.spikeSigma;
    let changed = false;
    for (const [id, z] of Object.entries(s.z)) {
      const a = prev.z[id];
      const b = next.z[id];
      if (a === undefined || b === undefined) continue;
      if (Math.abs(z) > lim && Math.abs(a) < 3 && Math.abs(b) < 3) {
        s.z[id] = 0.5 * (a + b);
        s.r[id] = this.mu.get(id)! + s.z[id]! * this.sigma.get(id)!;
        changed = true;
      }
    }
    if (changed) this.computeEvidence(s);
  }

  private finalize(bin: number): PreparedSample {
    const t = (bin + 1) * this.opts.binSec;
    const dt = Number.isFinite(this.lastSampleT) ? t - this.lastSampleT : this.opts.binSec;
    this.lastSampleT = t;
    if (!Number.isFinite(this.tStart)) this.tStart = t;
    const raw: Record<SensorId, number> = {};
    const r: Record<SensorId, number> = {};
    const valid = new Set<SensorId>();
    for (const s of this.sensors) {
      const a = this.acc.get(s.id);
      let v: number | undefined;
      if (a && a.nRaw > 0) v = a.raw / a.nRaw;
      else if (this.lastRaw.has(s.id) && t - (this.lastSeen.get(s.id) ?? -Infinity) <= this.opts.maxGapSec) v = this.lastRaw.get(s.id);
      this.updateHealth(s, v, t);
      if (v === undefined) continue;
      this.lastRaw.set(s.id, v);
      raw[s.id] = v;
      if (this.health.has(s.id) || this.excluded.has(s.id)) continue;
      valid.add(s.id);
      if (a && a.nPred > 0 && !this.inputs.has(s.id)) r[s.id] = v - a.pred / a.nPred;
    }
    const sample: PreparedSample = { t, dt, raw, r, z: {}, e: {}, valid, warm: this.warm };
    if (!this.warm) {
      // начало потока пропускаем: twin выходит на режим
      if (t - this.tStart >= Math.min(5, 0.2 * this.opts.warmupSec)) {
        for (const [id, v] of Object.entries(r)) pushTo(this.warmR, id, v);
        for (const [id, v] of Object.entries(raw)) pushTo(this.warmRaw, id, v);
      }
      if (t - this.tStart >= this.opts.warmupSec) this.finishWarmup();
      return sample;
    }
    for (const [id, v] of Object.entries(r)) {
      const mu = this.mu.get(id);
      const sg = this.sigma.get(id);
      if (mu === undefined || sg === undefined) continue;
      sample.z[id] = (v - mu) / sg;
    }
    this.track(sample);
    this.computeEvidence(sample);
    return sample;
  }

  private updateHealth(s: SensorSpec, v: number | undefined, t: number): void {
    const reasons: string[] = [];
    if (v === undefined) {
      if (t - (this.lastSeen.get(s.id) ?? (Number.isFinite(this.tStart) ? this.tStart : t)) > this.opts.maxGapSec) reasons.push('нет данных');
    } else {
      const prev = this.lastRaw.get(s.id);
      if (prev !== undefined && v === prev && (this.acc.get(s.id)?.nRaw ?? 0) > 0) {
        if (!this.sameSince.has(s.id)) this.sameSince.set(s.id, t);
        if (this.warm && t - this.sameSince.get(s.id)! >= this.opts.stuckSec && (this.rawNoiseMap.get(s.id) ?? 0) > (s.quantum ?? 0)) reasons.push('залипание');
      } else this.sameSince.delete(s.id);
      if (s.range) {
        const span = s.range[1] - s.range[0];
        const atEdge = v >= s.range[1] - 1e-9 * span || v <= s.range[0] + 1e-9 * span;
        if (atEdge) {
          if (!this.edgeSince.has(s.id)) this.edgeSince.set(s.id, t);
          if (t - this.edgeSince.get(s.id)! >= 1) reasons.push('вне шкалы');
        } else this.edgeSince.delete(s.id);
      }
    }
    if (reasons.length) this.health.set(s.id, reasons.join(', '));
    else this.health.delete(s.id);
  }

  private finishWarmup(): void {
    for (const s of this.sensors) {
      const rs = this.warmR.get(s.id);
      if (rs && rs.length >= 10) {
        this.mu.set(s.id, median(rs));
        this.sigma.set(s.id, Math.max(madSigma(rs), 0.05 * s.noiseStd, 1e-12));
      }
      const xs = this.warmRaw.get(s.id);
      if (xs && xs.length >= 10) {
        this.rawLevel.set(s.id, median(xs));
        this.rawSpread.set(s.id, Math.max(madSigma(xs), 0.05 * s.noiseStd, 1e-12));
        const d: number[] = [];
        for (let i = 1; i < xs.length; i++) d.push(xs[i]! - xs[i - 1]!);
        this.rawNoiseMap.set(s.id, Math.max(madSigma(d) / Math.SQRT2, 0.05 * s.noiseStd, 1e-12));
      }
    }
    const qIn = this.sensors.find((s) => s.kind === 'q' && s.x === 0) ?? this.sensors.find((s) => s.kind === 'q');
    this.nominalFlow = qIn && this.rawLevel.has(qIn.id) ? Math.abs(this.rawLevel.get(qIn.id)!) : NaN;
    this.computeSigns();
    this.warmR.clear();
    this.warmRaw.clear();
    this.warm = true;
  }

  /** Знак и вес каждого датчика по отклику twin на утечку в трёх точках трассы. */
  computeSigns(): void {
    this.signs.clear();
    this.weights.clear();
    const twin = this.ctx.twin;
    if (!twin?.leakResponse) return;
    const L = this.ctx.config.geometry.length;
    let q = Number.isFinite(this.nominalFlow) && this.nominalFlow > 0 ? this.nominalFlow : twin.profile?.()?.q[0];
    if (!q || !Number.isFinite(q)) q = 0.1;
    const qTest = 0.01 * Math.abs(q);
    const acc = new Map<SensorId, number>();
    for (const f of [0.2, 0.5, 0.8]) {
      const resp = twin.leakResponse(f * L, qTest);
      for (const [id, v] of Object.entries(resp)) {
        const sg = this.sigma.get(id);
        if (sg) acc.set(id, (acc.get(id) ?? 0) + v / sg / 3);
      }
    }
    let maxW = 0;
    for (const v of acc.values()) maxW = Math.max(maxW, Math.abs(v));
    for (const [id, v] of acc) {
      const sensor = this.sensors.find((s) => s.id === id);
      if (sensor?.kind === 'T') continue;
      if (Math.abs(v) >= 0.02 * maxW && maxW > 0) {
        this.signs.set(id, Math.sign(v));
        this.weights.set(id, Math.abs(v));
      }
    }
  }

  private track(s: PreparedSample): void {
    if (this.frozen) return;
    const fast = s.t < this.fastUntil;
    const aMu = ewmaAlpha(s.dt, fast ? 1 : this.opts.baselineTauSec);
    const aSg = ewmaAlpha(s.dt, this.opts.sigmaTauSec);
    for (const [id, z] of Object.entries(s.z)) {
      if (!fast && Math.abs(z) > 3) continue;
      const mu = this.mu.get(id)!;
      const sg = this.sigma.get(id)!;
      const r = s.r[id]!;
      this.mu.set(id, mu + aMu * (r - mu));
      if (!fast) {
        const sensor = this.sensors.find((x) => x.id === id)!;
        const v = sg * sg + aSg * ((r - mu) ** 2 - sg * sg);
        this.sigma.set(id, Math.max(Math.sqrt(Math.max(v, 0)), 0.05 * sensor.noiseStd, 1e-12));
      }
    }
  }

  computeEvidence(s: PreparedSample): void {
    s.e = {};
    let num = 0;
    let den = 0;
    for (const [id, z] of Object.entries(s.z)) {
      const sign = this.signs.get(id);
      if (!sign) continue;
      const e = sign * z;
      s.e[id] = e;
      const w = this.weights.get(id)!;
      num += w * e;
      den += w * w;
    }
    if (den > 0) s.e[SUM] = num / Math.sqrt(den);
  }

  freeze(on: boolean): void {
    this.frozen = on;
  }

  /** Быстро перенастроить смещения после принятого события смены режима (5 с). */
  rebaseline(t: number): void {
    this.fastUntil = t + 5;
  }

  /**
   * Сдвинуть норму невязок: + вклад подтверждённой утечки (она теперь часть «нормы»),
   * − тот же вклад, когда утечку устранили.
   */
  shiftBaseline(delta: Record<SensorId, number>, sign = 1): void {
    for (const [id, d] of Object.entries(delta)) {
      const mu = this.mu.get(id);
      if (mu !== undefined) this.mu.set(id, mu + sign * d);
    }
  }

  /** Исключить датчик (признан неисправным). */
  exclude(id: SensorId, reason = 'отказ датчика'): void {
    this.excluded.add(id);
    this.health.set(id, reason);
  }

  isInput(id: SensorId): boolean {
    return this.inputs.has(id);
  }

  unhealthy(): SensorId[] {
    return [...new Set([...this.health.keys(), ...this.excluded])];
  }

  sigmaOf(id: SensorId): number | undefined {
    return this.sigma.get(id);
  }

  muOf(id: SensorId): number | undefined {
    return this.mu.get(id);
  }

  /** Уровень замера на прогреве и его разброс (для детекторов без физики). */
  rawStats(id: SensorId): { level: number; spread: number; noise: number } | undefined {
    const level = this.rawLevel.get(id);
    if (level === undefined) return undefined;
    return { level, spread: this.rawSpread.get(id)!, noise: this.rawNoiseMap.get(id)! };
  }
}

function pushTo(m: Map<SensorId, number[]>, id: SensorId, v: number): void {
  const a = m.get(id);
  if (a) a.push(v);
  else m.set(id, [v]);
}
