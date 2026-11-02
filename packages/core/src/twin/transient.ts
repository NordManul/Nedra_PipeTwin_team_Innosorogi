/**
 * Нестационарный twin: та же схема MOC, что у plant, но без утечки, со «своими» параметрами
 * трубы из конфига и с граничными условиями из замеров на концах (давление, а при его отсутствии — расход).
 * Twin повторяет волны от насоса и задвижки, поэтому смена режима не даёт невязки (E5),
 * а утечка — даёт: её нет в модели.
 */
import type { PipeProfile, PipelineConfig, SensorFrame, SensorId, SensorValues, TwinModel, TwinPrediction } from '../contracts';
import { MocSolver, type BoundarySpec } from '../hydraulics/moc';
import { PipeModel } from '../hydraulics/pipe';
import { steadyBackward, steadyForward, steadyFromPressures, type PointSink, type SteadyProfile } from '../hydraulics/steady';
import { interp } from '../math/stats';
import { BoundaryInput, findEndSensors, InletTemperature, sampleSensors, steadyFromEnd, steadyToProfile } from './common';

interface EndInput {
  kind: 'p' | 'q';
  input: BoundaryInput;
}

/** Если между кадрами разрыв больше этого, модель переинициализируется стационарным профилем. */
const MAX_GAP_SEC = 10;

export class TransientTwin implements TwinModel {
  private cfg!: PipelineConfig;
  private model!: PipeModel;
  private solver!: MocSolver;
  private inlet: EndInput | null = null;
  private outlet: EndInput | null = null;
  private tin!: InletTemperature;
  private prev: { t: number; bIn: number; bOut: number; Tin: number } | null = null;

  reset(cfg: PipelineConfig): void {
    this.cfg = cfg;
    this.model = new PipeModel(cfg);
    this.solver = new MocSolver(this.model);
    const e = findEndSensors(cfg);
    this.inlet = e.pIn ? { kind: 'p', input: new BoundaryInput(e.pIn) } : e.qIn ? { kind: 'q', input: new BoundaryInput(e.qIn) } : null;
    this.outlet = e.pOut ? { kind: 'p', input: new BoundaryInput(e.pOut) } : e.qOut ? { kind: 'q', input: new BoundaryInput(e.qOut) } : null;
    this.tin = new InletTemperature(cfg, e.TIn);
    this.prev = null;
  }

  get waveSpeed(): number {
    return this.solver.a;
  }

  private inputIds(): SensorId[] {
    const ids: SensorId[] = [];
    if (this.inlet) ids.push(this.inlet.input.id);
    if (this.outlet) ids.push(this.outlet.input.id);
    if (this.tin.sensorId) ids.push(this.tin.sensorId);
    return ids;
  }

  private steady(bIn: number, bOut: number, Tin: number, sinks: PointSink[] = []): SteadyProfile {
    const m = this.model;
    const rhoIn = m.fluid.rho(Tin);
    if (this.inlet!.kind === 'p' && this.outlet!.kind === 'p') return steadyFromPressures(m, bIn, bOut, Tin, sinks);
    if (this.inlet!.kind === 'p') {
      const total = sinks.reduce((s, k) => s + k.m, 0);
      return steadyForward(m, bIn, rhoIn * bOut + total, Tin, sinks);
    }
    if (this.outlet!.kind === 'p') {
      const T = steadyForward(m, bOut, rhoIn * bIn, Tin).T;
      const total = sinks.reduce((s, k) => s + k.m, 0);
      return steadyBackward(m, bOut, m.fluid.rho(T[m.N - 1]!) * bIn - total, Tin, sinks);
    }
    throw new Error('нестационарному twin нужен хотя бы один датчик давления на конце трубы');
  }

  private bc(end: EndInput, value: number): BoundarySpec {
    if (end.kind === 'p') return { type: 'pressure', p: value };
    const rho = end === this.inlet ? this.solver.rhoSeg[0]! : this.solver.rhoSeg[this.model.N - 1]!;
    return { type: 'flow', m: rho * value };
  }

  predict(frame: SensorFrame): TwinPrediction {
    const inputs = this.inputIds();
    if (!this.inlet || !this.outlet) {
      return { t: frame.t, values: {}, inputs, ok: false, error: 'нестационарному twin нужны датчики давления или расхода на обоих концах' };
    }
    const bIn = this.inlet.input.read(frame);
    const bOut = this.outlet.input.read(frame);
    const Tin = this.tin.read(frame);
    if (bIn === undefined || bOut === undefined) return { t: frame.t, values: {}, inputs, ok: false, error: 'нет граничных замеров' };
    try {
      if (!this.prev || frame.t - this.prev.t > MAX_GAP_SEC || frame.t < this.prev.t) {
        this.solver.setState(this.steady(bIn, bOut, Tin), frame.t);
      } else {
        const p = this.prev;
        const span = frame.t - p.t;
        const s = this.solver;
        while (s.t + 0.5 * s.dt <= frame.t) {
          const tau = span > 0 ? Math.min(1, Math.max(0, (s.t + s.dt - p.t) / span)) : 1;
          const vin = p.bIn + tau * (bIn - p.bIn);
          const vout = p.bOut + tau * (bOut - p.bOut);
          s.step(this.bc(this.inlet, vin), this.bc(this.outlet, vout), [], p.Tin + tau * (Tin - p.Tin));
        }
      }
      this.prev = { t: frame.t, bIn, bOut, Tin };
      return { t: frame.t, values: this.sampleNow(), inputs, ok: true };
    } catch (e) {
      this.prev = null;
      return { t: frame.t, values: {}, inputs, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Значения на датчиках прямо из массивов решателя (без копирования профиля). */
  private sampleNow(): SensorValues {
    const s = this.solver;
    const out: SensorValues = {};
    for (const sp of this.cfg.sensors) {
      if (sp.kind === 'p') out[sp.id] = interp(sp.x, this.model.x, s.p);
      else if (sp.kind === 'T') out[sp.id] = interp(sp.x, this.model.x, s.T);
      else out[sp.id] = s.nodeQ(this.model.nodeAt(sp.x));
    }
    return out;
  }

  /** Отклик датчиков на утечку q в точке x в установившемся режиме при текущих граничных замерах. */
  leakResponse(x: number, q: number): SensorValues {
    if (!this.prev) return {};
    const { bIn, bOut, Tin } = this.prev;
    const node = this.model.nodeAt(x, true);
    const rho = this.model.fluid.rho(interp(x, this.model.x, this.solver.T));
    const base = steadyToProfile(0, this.model, this.steady(bIn, bOut, Tin));
    const leak = steadyToProfile(0, this.model, this.steady(bIn, bOut, Tin, [{ x: node * this.model.dx, m: rho * q }]));
    const a = sampleSensors(this.model, this.cfg.sensors, base.p, base.q, base.T);
    const c = sampleSensors(this.model, this.cfg.sensors, leak.p, leak.q, leak.T);
    const out: SensorValues = {};
    for (const id of Object.keys(a)) out[id] = c[id]! - a[id]!;
    return out;
  }

  steadyProfileFrom(end: 'inlet' | 'outlet', p: number, q: number): PipeProfile {
    const Tin = this.prev?.Tin ?? this.model.inletTemp(0);
    return steadyToProfile(this.solver.t, this.model, steadyFromEnd(this.model, end, p, q, Tin));
  }

  profile(): PipeProfile {
    const s = this.solver;
    const q = new Float64Array(this.model.N + 1);
    for (let i = 0; i <= this.model.N; i++) q[i] = s.nodeQ(i);
    return { t: s.t, x: this.model.x, p: Float64Array.from(s.p), q, T: Float64Array.from(s.T) };
  }
}
