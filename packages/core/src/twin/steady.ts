/**
 * Квазистационарный twin «как у диспетчера» (WP-A4): на каждом кадре — стационарный профиль
 * по доступным граничным замерам. Режимы: (p_вх, Q_вх), (p_вх, p_вых) — расход стрельбой, (p_вых, Q_вых).
 */
import type { PipeProfile, PipelineConfig, SensorFrame, SensorId, SensorValues, TwinBoundaryMode, TwinModel, TwinPrediction } from '../contracts';
import { PipeModel } from '../hydraulics/pipe';
import { steadyBackward, steadyForward, steadyFromPressures, type PointSink, type SteadyProfile } from '../hydraulics/steady';
import { BoundaryInput, findEndSensors, InletTemperature, PredictionLag, sampleSensors, steadyFromEnd, steadyToProfile } from './common';

type Mode = Exclude<TwinBoundaryMode, 'auto'>;

export class SteadyTwin implements TwinModel {
  private cfg!: PipelineConfig;
  private model!: PipeModel;
  private mode: Mode | null = null;
  private inputs: Partial<Record<'pIn' | 'qIn' | 'pOut' | 'qOut', BoundaryInput>> = {};
  private tin!: InletTemperature;
  private last: { t: number; s: SteadyProfile; b: Record<string, number>; Tin: number } | null = null;
  private lag!: PredictionLag;

  reset(cfg: PipelineConfig): void {
    this.cfg = cfg;
    this.model = new PipeModel(cfg);
    const e = findEndSensors(cfg);
    const want = cfg.twin.boundaryMode;
    const can: Record<Mode, boolean> = {
      'p_in+q_in': !!(e.pIn && e.qIn),
      'p_in+p_out': !!(e.pIn && e.pOut),
      'p_out+q_out': !!(e.pOut && e.qOut),
    };
    this.mode = want !== 'auto' ? (can[want] ? want : null) : (['p_in+q_in', 'p_in+p_out', 'p_out+q_out'] as Mode[]).find((m) => can[m]) ?? null;
    this.inputs = {};
    for (const k of ['pIn', 'qIn', 'pOut', 'qOut'] as const) {
      const s = e[k];
      if (s && this.mode?.includes(k === 'pIn' ? 'p_in' : k === 'qIn' ? 'q_in' : k === 'pOut' ? 'p_out' : 'q_out')) this.inputs[k] = new BoundaryInput(s);
    }
    this.tin = new InletTemperature(cfg, e.TIn);
    this.last = null;
    const ids = new Set(Object.values(this.inputs).map((i) => i!.id));
    this.lag = new PredictionLag(cfg.sensors, cfg.sensors.filter((s) => ids.has(s.id)));
  }

  get boundaryMode(): Mode | null {
    return this.mode;
  }

  private solve(b: Record<string, number>, Tin: number, sinks: PointSink[] = []): SteadyProfile {
    const m = this.model;
    switch (this.mode!) {
      case 'p_in+q_in':
        return steadyForward(m, b.pIn!, m.fluid.rho(Tin) * b.qIn!, Tin, sinks);
      case 'p_in+p_out':
        return steadyFromPressures(m, b.pIn!, b.pOut!, Tin, sinks);
      case 'p_out+q_out': {
        const T = steadyForward(m, b.pOut!, m.fluid.rho(Tin) * b.qOut!, Tin).T;
        return steadyBackward(m, b.pOut!, m.fluid.rho(T[m.N - 1]!) * b.qOut!, Tin, sinks);
      }
    }
  }

  predict(frame: SensorFrame): TwinPrediction {
    const inputIds: SensorId[] = Object.values(this.inputs).map((i) => i!.id);
    if (!this.mode) return { t: frame.t, values: {}, inputs: [], ok: false, error: 'нет граничных датчиков для стационарного twin' };
    const b: Record<string, number> = {};
    for (const [k, inp] of Object.entries(this.inputs)) {
      const v = inp!.read(frame);
      if (v === undefined) return { t: frame.t, values: {}, inputs: inputIds, ok: false, error: `нет замера ${inp!.id}` };
      b[k] = v;
    }
    const Tin = this.tin.read(frame);
    if (this.tin.sensorId) inputIds.push(this.tin.sensorId);
    try {
      const s = this.solve(b, Tin);
      this.last = { t: frame.t, s, b, Tin };
      const prof = steadyToProfile(frame.t, this.model, s);
      const values = sampleSensors(this.model, this.cfg.sensors, prof.p, prof.q, prof.T);
      return { t: frame.t, values: this.lag.apply(frame.t, values), inputs: inputIds, ok: true };
    } catch (e) {
      return { t: frame.t, values: {}, inputs: inputIds, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  leakResponse(x: number, q: number): SensorValues {
    if (!this.last) return {};
    const { b, Tin, s } = this.last;
    const rho = this.model.fluid.rho(s.T[this.model.nodeAt(x)]!);
    const withLeak = this.solve(b, Tin, [{ x, m: rho * q }]);
    const p0 = steadyToProfile(0, this.model, s);
    const p1 = steadyToProfile(0, this.model, withLeak);
    const a = sampleSensors(this.model, this.cfg.sensors, p0.p, p0.q, p0.T);
    const c = sampleSensors(this.model, this.cfg.sensors, p1.p, p1.q, p1.T);
    const out: SensorValues = {};
    for (const id of Object.keys(a)) out[id] = c[id]! - a[id]!;
    return out;
  }

  steadyProfileFrom(end: 'inlet' | 'outlet', p: number, q: number): PipeProfile {
    const Tin = this.last?.Tin ?? this.model.inletTemp(0);
    return steadyToProfile(this.last?.t ?? 0, this.model, steadyFromEnd(this.model, end, p, q, Tin));
  }

  profile(): PipeProfile | undefined {
    return this.last ? steadyToProfile(this.last.t, this.model, this.last.s) : undefined;
  }
}
