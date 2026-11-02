import type { Schedule } from './contracts';

/** Значение расписания в момент t (ТЗ: кусочно-линейное или ступенчатое). */
export function evalSchedule(s: Schedule, t: number): number {
  if (typeof s === 'number') return s;
  const pts = s.points;
  if (pts.length === 0) return NaN;
  const first = pts[0]!;
  if (t <= first[0]) return first[1];
  for (let i = 1; i < pts.length; i++) {
    const [t1, v1] = pts[i]!;
    if (t < t1) {
      const [t0, v0] = pts[i - 1]!;
      if (s.interp === 'step') return v0;
      return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
  }
  return pts[pts.length - 1]![1];
}

/** Плавный переход значения за rampSec (для управляющих воздействий). */
export class Ramp {
  private from: number;
  private to: number;
  private t0 = 0;
  private dur = 0;

  constructor(value: number) {
    this.from = value;
    this.to = value;
  }

  set(t: number, target: number, rampSec = 0): void {
    this.from = this.value(t);
    this.to = target;
    this.t0 = t;
    this.dur = Math.max(0, rampSec);
  }

  value(t: number): number {
    if (this.dur <= 0 || t >= this.t0 + this.dur) return this.to;
    if (t <= this.t0) return this.from;
    return this.from + ((this.to - this.from) * (t - this.t0)) / this.dur;
  }

  get target(): number {
    return this.to;
  }
}
