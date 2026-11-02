/**
 * D1–D3: детекторы по нормированной невязке. Работают по каналам «свидетельства утечки» e
 * (каждый датчик + суммарный канал); статистика — максимум по каналам.
 */
import type { DetectorParams } from '@pipetwin/core/contracts';
import type { PreparedSample, StatContext, Statistic, StatOut } from '../types';
import { ewmaAlpha, RollingWindow } from '../util';

/** Отслеживание момента начала: последний момент, когда статистика канала была около нуля. */
class OnsetTracker {
  private readonly quiet = new Map<string, number>();
  mark(ch: string, t: number, value: number, quietLevel: number): void {
    if (value <= quietLevel || !this.quiet.has(ch)) this.quiet.set(ch, t);
  }
  get(ch: string): number | undefined {
    return this.quiet.get(ch);
  }
  clear(): void {
    this.quiet.clear();
  }
}

function pickMax(values: Record<string, number>): [string, number] {
  let best = '';
  let v = -Infinity;
  for (const [k, x] of Object.entries(values)) if (x > v) [best, v] = [k, x];
  return [best, v];
}

/** D1: порог на скользящем среднем z за windowSec, нормированном на √n. */
export class ThresholdStat implements Statistic {
  private readonly win = new Map<string, RollingWindow>();
  private readonly n: number;
  private readonly onset = new OnsetTracker();
  constructor(sc: StatContext, private readonly p: DetectorParams) {
    this.n = Math.max(1, Math.round(p.windowSec! / sc.binSec));
  }
  update(s: PreparedSample): StatOut {
    const ch: Record<string, number> = {};
    for (const [id, e] of Object.entries(s.e)) {
      let w = this.win.get(id);
      if (!w) this.win.set(id, (w = new RollingWindow(this.n)));
      w.push(e);
      ch[id] = w.mean() * Math.sqrt(w.length);
      this.onset.mark(id, s.t, ch[id]!, 0.5);
    }
    const [best, score] = pickMax(ch);
    return { score: Number.isFinite(score) ? score : 0, threshold: this.p.k!, channels: ch, onset: this.onset.get(best) };
  }
  rearm(): void {
    this.win.clear();
    this.onset.clear();
  }
}

/** D2: CUSUM Пейджа; односторонний по направлению утечки для тревоги, обратная сторона — для журнала. */
export class CusumStat implements Statistic {
  private readonly S = new Map<string, number>();
  private readonly onset = new OnsetTracker();
  constructor(private readonly p: DetectorParams) {}
  update(s: PreparedSample): StatOut {
    const ch: Record<string, number> = {};
    for (const [id, e] of Object.entries(s.e)) {
      const v = Math.max(0, (this.S.get(id) ?? 0) + e - this.p.drift!);
      this.S.set(id, v);
      ch[id] = v;
      this.onset.mark(id, s.t, v, 0);
    }
    const [best, score] = pickMax(ch);
    return { score: Number.isFinite(score) ? score : 0, threshold: this.p.h!, channels: ch, onset: this.onset.get(best) };
  }
  rearm(): void {
    this.S.clear();
    this.onset.clear();
  }
}

/** D3: EWMA-карта с постоянной времени tauSec и пределом L·σ_EWMA. */
export class EwmaStat implements Statistic {
  private readonly E = new Map<string, number>();
  private readonly onset = new OnsetTracker();
  constructor(private readonly sc: StatContext, private readonly p: DetectorParams) {}
  update(s: PreparedSample): StatOut {
    const lam = ewmaAlpha(this.sc.binSec, this.p.tauSec!);
    const sd = Math.sqrt(lam / (2 - lam));
    const ch: Record<string, number> = {};
    for (const [id, e] of Object.entries(s.e)) {
      const v = (1 - lam) * (this.E.get(id) ?? 0) + lam * e;
      this.E.set(id, v);
      ch[id] = v / sd;
      this.onset.mark(id, s.t, ch[id]!, 0.5);
    }
    const [best, score] = pickMax(ch);
    return { score: Number.isFinite(score) ? score : 0, threshold: this.p.L!, channels: ch, onset: this.onset.get(best) };
  }
  rearm(): void {
    this.E.clear();
    this.onset.clear();
  }
}
