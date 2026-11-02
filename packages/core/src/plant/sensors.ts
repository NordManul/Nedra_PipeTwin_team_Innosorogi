/**
 * Модель датчиков (WP-A7): датчик — точка модели, в которой «подсматривают» значение и портят его
 * как настоящий прибор: запаздывание первого порядка, смещение, дрейф, шум, выбросы, квантование,
 * насыщение шкалы, пропуски, дрожание метки времени. Плюс отказы по событиям сценария.
 */
import type { SensorFaultMode, SensorFrame, SensorSpec } from '../contracts';
import { Rng } from '../math/rng';

interface Fault {
  mode: SensorFaultMode;
  magnitude: number;
  t0: number;
  t1: number;
  stuckValue?: number;
}

export class SensorModel {
  readonly specs: SensorSpec[];
  noiseScale: number;
  private readonly rng: Rng;
  private readonly lagged = new Map<string, number>();
  private readonly faults = new Map<string, Fault>();
  private readonly lastOut = new Map<string, number>();
  private lastT = -Infinity;
  private lastFrameT = -Infinity;

  constructor(specs: SensorSpec[], rng: Rng, noiseScale = 1) {
    this.specs = specs;
    this.rng = rng;
    this.noiseScale = noiseScale;
  }

  addFault(sensorId: string, mode: SensorFaultMode, t: number, magnitude = 8, durationSec = Infinity): void {
    this.faults.set(sensorId, { mode, magnitude, t0: t, t1: t + durationSec });
  }

  clearFaults(): void {
    this.faults.clear();
  }

  /** Отсчёт всех датчиков в момент t по истинным значениям truth (id → СИ). */
  sample(t: number, truth: Record<string, number>): SensorFrame {
    const dt = Number.isFinite(this.lastT) ? t - this.lastT : 0;
    this.lastT = t;
    const values: Record<string, number> = {};
    const valid: Record<string, boolean> = {};
    let jitter = 0;
    for (const s of this.specs) {
      const u = truth[s.id]!;
      let y = this.lagged.get(s.id) ?? u;
      if (s.lagSec > 0 && dt > 0) y += (u - y) * (1 - Math.exp(-dt / s.lagSec));
      else y = u;
      this.lagged.set(s.id, y);

      const sigma = s.noiseStd * this.noiseScale;
      let v = y + (s.bias ?? 0) + (s.drift ?? 0) * t + sigma * this.rng.gauss();
      if (s.outlierProb && this.rng.next() < s.outlierProb) v += (this.rng.next() < 0.5 ? -1 : 1) * (s.outlierScale ?? 10) * s.noiseStd;

      let ok = !(s.dropoutProb && this.rng.next() < s.dropoutProb);
      const f = this.faults.get(s.id);
      if (f && t >= f.t0 && t < f.t1) {
        const sd = Math.max(s.noiseStd, 1e-12);
        switch (f.mode) {
          case 'step':
            v += f.magnitude * sd;
            break;
          case 'drift':
            v += (f.magnitude * sd * (t - f.t0)) / 60;
            break;
          case 'spike':
            if (t - f.t0 < 0.15) v += f.magnitude * sd;
            break;
          case 'stuck':
            f.stuckValue ??= this.lastOut.get(s.id) ?? v;
            v = f.stuckValue;
            break;
          case 'dropout':
            ok = false;
            break;
        }
      }
      if (s.quantum && s.quantum > 0) v = Math.round(v / s.quantum) * s.quantum;
      if (s.range) v = Math.min(s.range[1], Math.max(s.range[0], v));
      if (ok) {
        values[s.id] = v;
        this.lastOut.set(s.id, v);
      } else valid[s.id] = false;
      if (s.timeJitterSec) jitter = Math.max(jitter, s.timeJitterSec);
    }
    let ft = t + (jitter ? jitter * this.rng.gauss() : 0);
    if (ft <= this.lastFrameT) ft = this.lastFrameT + 1e-6;
    this.lastFrameT = ft;
    const frame: SensorFrame = { t: ft, values };
    if (Object.keys(valid).length) frame.valid = valid;
    return frame;
  }
}
