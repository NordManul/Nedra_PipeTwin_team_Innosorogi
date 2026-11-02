/** Общее для обеих моделей twin: выбор граничных датчиков, отбор значений из профиля, очистка входов. */
import type { PipeProfile, PipelineConfig, SensorFrame, SensorId, SensorSpec, SensorValues } from '../contracts';
import { PipeModel } from '../hydraulics/pipe';
import { nodeFlow, steadyBackward, steadyForward, type SteadyProfile } from '../hydraulics/steady';
import { evalSchedule } from '../schedule';
import { interp, median } from '../math/stats';

export interface EndSensors {
  pIn?: SensorSpec;
  qIn?: SensorSpec;
  pOut?: SensorSpec;
  qOut?: SensorSpec;
  TIn?: SensorSpec;
}

/** Датчики на концах трубы (с учётом явного выбора в config.twin). */
export function findEndSensors(cfg: PipelineConfig): EndSensors {
  const L = cfg.geometry.length;
  const tol = Math.max(cfg.numerics.dx * 0.5, 1e-6);
  const byId = new Map(cfg.sensors.map((s) => [s.id, s]));
  const at = (kind: SensorSpec['kind'], x: number) => cfg.sensors.find((s) => s.kind === kind && Math.abs(s.x - x) <= tol);
  const t = cfg.twin;
  return {
    pIn: (t.inletPressureSensor && byId.get(t.inletPressureSensor)) || at('p', 0),
    pOut: (t.outletPressureSensor && byId.get(t.outletPressureSensor)) || at('p', L),
    qIn: (t.flowSensor && byId.get(t.flowSensor)?.x === 0 ? byId.get(t.flowSensor) : undefined) || at('q', 0),
    qOut: (t.flowSensor && byId.get(t.flowSensor)?.x === L ? byId.get(t.flowSensor) : undefined) || at('q', L),
    TIn: (t.inletTempSensor && byId.get(t.inletTempSensor)) || at('T', 0),
  };
}

/** Значения на датчиках по профилю в узлах. */
export function sampleSensors(
  model: PipeModel,
  sensors: SensorSpec[],
  p: ArrayLike<number>,
  q: ArrayLike<number>,
  T: ArrayLike<number>,
): SensorValues {
  const out: SensorValues = {};
  for (const s of sensors) {
    if (s.kind === 'p') out[s.id] = interp(s.x, model.x, p);
    else if (s.kind === 'T') out[s.id] = interp(s.x, model.x, T);
    else out[s.id] = q[model.nodeAt(s.x)]!;
  }
  return out;
}

export function steadyToProfile(t: number, model: PipeModel, s: SteadyProfile): PipeProfile {
  const q = new Float64Array(model.N + 1);
  for (let i = 0; i <= model.N; i++) q[i] = nodeFlow(s, i);
  return { t, x: model.x, p: s.p, q, T: s.T };
}

/** Стационарный профиль от конца трубы (для локализации L1). */
export function steadyFromEnd(model: PipeModel, end: 'inlet' | 'outlet', p: number, q: number, Tin: number): SteadyProfile {
  const rho = model.fluid.rho(Tin);
  if (end === 'inlet') return steadyForward(model, p, rho * q, Tin);
  const T = steadyForward(model, p, rho * q, Tin).T;
  const rhoOut = model.fluid.rho(T[model.N - 1]!);
  return steadyBackward(model, p, rhoOut * q, Tin);
}

/**
 * Удержание и очистка граничных замеров: пропуск — держим последнее значение,
 * одиночный выброс (дальше 6σ от медианы последних 5 отсчётов) — заменяем медианой.
 * Без этого выброс на входном датчике ушёл бы волной в прогноз и выглядел бы как событие.
 */
export class BoundaryInput {
  private hist: number[] = [];
  private last: number | undefined;

  constructor(private readonly spec: SensorSpec) {}

  get id(): SensorId {
    return this.spec.id;
  }

  read(frame: SensorFrame): number | undefined {
    const v = frame.values[this.spec.id];
    const ok = v !== undefined && Number.isFinite(v) && frame.valid?.[this.spec.id] !== false;
    if (ok) {
      let val = v;
      if (this.hist.length >= 3) {
        const med = median(this.hist);
        if (Math.abs(v - med) > 6 * Math.max(this.spec.noiseStd, 1e-12)) val = med;
      }
      this.hist.push(v);
      if (this.hist.length > 5) this.hist.shift();
      this.last = val;
    }
    return this.last;
  }

  peek(): number | undefined {
    return this.last;
  }
}

/** Температура на входе: замер, если есть, иначе расписание из конфига. */
export class InletTemperature {
  private input: BoundaryInput | undefined;
  constructor(private readonly cfg: PipelineConfig, spec?: SensorSpec) {
    this.input = spec ? new BoundaryInput(spec) : undefined;
  }
  get sensorId(): SensorId | undefined {
    return this.input?.id;
  }
  read(frame: SensorFrame): number {
    return this.input?.read(frame) ?? evalSchedule(this.cfg.boundary.inletTemp, frame.t);
  }
}

/**
 * Запаздывание прогноза под инерцию датчиков. Граничные замеры уже запаздывают на свой lagSec,
 * поэтому прогноз датчика сглаживается фильтром первого порядка с τ = lag_датчика − lag_входов.
 * Иначе при волне от насоса инерционный расходомер «отстаёт» от прогноза и это похоже на утечку.
 */
export class PredictionLag {
  private readonly tau = new Map<SensorId, number>();
  private readonly state = new Map<SensorId, number>();
  private lastT = NaN;

  constructor(sensors: SensorSpec[], inputs: SensorSpec[]) {
    const inLag = inputs.length ? inputs.reduce((a, s) => a + s.lagSec, 0) / inputs.length : 0;
    for (const s of sensors) this.tau.set(s.id, Math.max(0, s.lagSec - inLag));
  }

  apply(t: number, values: SensorValues): SensorValues {
    const dt = Number.isFinite(this.lastT) ? t - this.lastT : 0;
    this.lastT = t;
    const out: SensorValues = {};
    for (const [id, v] of Object.entries(values)) {
      const tau = this.tau.get(id) ?? 0;
      const prev = this.state.get(id);
      const y = prev === undefined || tau <= 0 || dt <= 0 ? (prev === undefined || tau <= 0 ? v : prev) : prev + (v - prev) * (1 - Math.exp(-dt / tau));
      this.state.set(id, y);
      out[id] = y;
    }
    return out;
  }

  reset(): void {
    this.state.clear();
    this.lastT = NaN;
  }
}
