/**
 * D5: волна отрицательного давления (WP-B2) и локализация L3 по времени прихода волны (WP-B4).
 *
 * На каждом датчике давления — «перепад» d = (среднее за shortSec − среднее за предыдущие longSec)/σ_d.
 * Резкий спад (d < −thr) фиксирует момент прихода волны. Источник внутри трубы, если пара соседних
 * датчиков увидела спад с разницей времён меньше времени пробега волны между ними:
 *   x = (x₁ + x₂ + a·(t₁ − t₂)) / 2.
 * Волна, пришедшая с конца трубы (насос, задвижка), даёт разницу ≈ времени пробега — это не утечка.
 */
import type { DetectorParams, SensorSpec } from '@pipetwin/core/contracts';
import type { PreparedSample, StatContext, Statistic, StatOut } from '../types';
import { RollingWindow } from '../util';

interface Drop {
  t: number;
  depth: number;
}

export interface WaveSource {
  x: number;
  interval: [number, number];
  /** Время прихода к первому датчику. */
  t: number;
  /** Глубина спада, σ. */
  depth: number;
  sensors: string[];
}

/** Следит за резкими спадами давления на всех датчиках и ищет источник волны. */
export class DropTracker {
  readonly ps: SensorSpec[];
  private readonly win = new Map<string, RollingWindow>();
  private readonly drops = new Map<string, Drop>();
  private readonly armed = new Map<string, boolean>();
  private readonly nS: number;
  private readonly nL: number;
  readonly d: Record<string, number> = {};

  constructor(
    private readonly sc: StatContext,
    private readonly shortSec: number,
    longSec: number,
    private readonly thr: number,
    private readonly tolSec: number,
  ) {
    this.ps = sc.ctx.sensors.filter((s) => s.kind === 'p').sort((a, b) => a.x - b.x);
    this.nS = Math.max(1, Math.round(shortSec / sc.binSec));
    this.nL = Math.max(2, Math.round(longSec / sc.binSec));
  }

  /** Время пробега волны через всю трубу + запас: дольше события не помним. */
  private get memorySec(): number {
    return this.sc.ctx.config.geometry.length / this.sc.waveSpeed + 5;
  }

  update(s: PreparedSample): void {
    for (const sp of this.ps) {
      const v = s.raw[sp.id];
      if (v === undefined || !s.valid.has(sp.id)) continue;
      let w = this.win.get(sp.id);
      if (!w) this.win.set(sp.id, (w = new RollingWindow(this.nS + this.nL)));
      w.push(v);
      if (!w.full || !s.warm) continue;
      const noise = this.sc.prep.rawStats(sp.id)?.noise ?? sp.noiseStd;
      const sd = noise * Math.sqrt(1 / this.nS + 1 / this.nL);
      const d = (w.meanRange(0, this.nS) - w.meanRange(this.nS, this.nS + this.nL)) / sd;
      this.d[sp.id] = d;
      if (d < -this.thr && this.armed.get(sp.id) !== false) {
        this.drops.set(sp.id, { t: s.t - this.shortSec / 2, depth: -d });
        this.armed.set(sp.id, false);
      }
      if (d > -0.5 * this.thr) this.armed.set(sp.id, true);
    }
    for (const [id, dr] of this.drops) if (s.t - dr.t > this.memorySec) this.drops.delete(id);
  }

  /** Источник волны внутри трубы, если он подтверждён парой датчиков. */
  source(): WaveSource | null {
    const a = this.sc.waveSpeed;
    const L = this.sc.ctx.config.geometry.length;
    const tol = this.tolSec;
    let best: WaveSource | null = null;
    for (let i = 0; i + 1 < this.ps.length; i++) {
      const s1 = this.ps[i]!;
      const s2 = this.ps[i + 1]!;
      const d1 = this.drops.get(s1.id);
      const d2 = this.drops.get(s2.id);
      if (!d1 || !d2) continue;
      const travel = (s2.x - s1.x) / a;
      const dt = d1.t - d2.t;
      let x: number | null = null;
      if (Math.abs(dt) <= travel - tol) {
        x = (s1.x + s2.x + a * dt) / 2;
      } else if (Math.abs(dt) <= travel + tol) {
        // источник у одного из датчиков пары: подтверждаем третьим датчиком с другой стороны
        const k = dt < 0 ? i : i + 1;
        const sk = this.ps[k]!;
        const other = this.ps[dt < 0 ? i - 1 : i + 2];
        const dk = this.drops.get(sk.id)!;
        const dOther = other ? this.drops.get(other.id) : undefined;
        const interior = sk.x > 0 && sk.x < L;
        if (interior && other && dOther && Math.abs(dOther.t - dk.t - Math.abs(other.x - sk.x) / a) <= tol) x = sk.x;
      }
      if (x === null) continue;
      const err = (a * tol) / 2;
      const cand: WaveSource = {
        x: Math.min(L, Math.max(0, x)),
        interval: [Math.max(0, x - err), Math.min(L, x + err)],
        t: Math.min(d1.t, d2.t),
        depth: Math.min(d1.depth, d2.depth),
        sensors: [s1.id, s2.id],
      };
      if (!best || cand.depth > best.depth) best = cand;
    }
    return best;
  }

  clear(): void {
    this.drops.clear();
  }
}

export class NpwStat implements Statistic {
  readonly tracker: DropTracker;
  constructor(private readonly sc: StatContext, private readonly p: DetectorParams) {
    this.tracker = new DropTracker(sc, p.shortSec!, p.longSec!, p.thr!, p.tolSec!);
  }
  update(s: PreparedSample): StatOut {
    this.tracker.update(s);
    const ch: Record<string, number> = {};
    let score = 0;
    for (const [id, d] of Object.entries(this.tracker.d)) {
      ch[id] = Math.max(0, -d);
      score = Math.max(score, -d);
    }
    const src = this.tracker.source();
    if (!src) return { score, threshold: this.p.thr!, alarm: false, channels: ch };
    // момент утечки: приход волны к ближайшему датчику минус время пробега до него
    const xs = this.tracker.ps.filter((sp) => src.sensors.includes(sp.id)).map((sp) => Math.abs(sp.x - src.x));
    const onset = src.t - Math.min(...xs) / this.sc.waveSpeed;
    return { score, threshold: this.p.thr!, alarm: true, channels: ch, location: src.x, locationInterval: src.interval, onset };
  }
  rearm(): void {
    this.tracker.clear();
  }
}
