/**
 * SimulatedSource — DataSource поверх plant и модели датчиков. Проигрывает события сценария,
 * принимает утечки и управление от интерфейса, знает правду (truth) для стенда и секундомера.
 */
import type {
  ControlAction,
  DataSource,
  GroundTruth,
  LeakEvent,
  PipeProfile,
  PipelineConfig,
  ScenarioEvent,
  SensorFrame,
  SensorSpec,
} from '../contracts';
import { Rng } from '../math/rng';
import { Plant } from './plant';
import { SensorModel } from './sensors';

export interface SimulatedSourceOptions {
  seed: number;
  /** Множитель шума всех датчиков. */
  noiseScale?: number;
  /** События сценария (утечки, режим, отказы датчиков). */
  events?: ScenarioEvent[];
  /** Длительность; после неё done = true. */
  durationSec?: number;
}

export const DEFAULT_LEAK_CD = 0.62;

export class SimulatedSource implements DataSource {
  readonly kind = 'simulated' as const;
  readonly sensors: SensorSpec[];
  readonly sampleRateHz: number;
  readonly plant: Plant;
  private readonly sensorModel: SensorModel;
  private readonly baseNoise: number;
  private readonly events: ScenarioEvent[];
  private readonly duration: number;
  private readonly regime: GroundTruth['regimeEvents'] = [];
  private sourceT = 0;
  private nextSample = 0;
  private leakCounter = 0;
  private prevTruth: Record<string, number>;
  private prevT: number;

  constructor(truthCfg: PipelineConfig, opts: SimulatedSourceOptions) {
    this.plant = new Plant(truthCfg);
    this.sensors = truthCfg.sensors;
    this.sampleRateHz = truthCfg.sampling.rateHz;
    this.baseNoise = opts.noiseScale ?? 1;
    this.sensorModel = new SensorModel(truthCfg.sensors, new Rng(opts.seed), this.baseNoise);
    this.events = [...(opts.events ?? [])].sort((a, b) => a.t - b.t);
    this.duration = opts.durationSec ?? Infinity;
    this.prevTruth = this.truthValues();
    this.prevT = this.plant.t;
  }

  get t(): number {
    return this.sourceT;
  }

  get done(): boolean {
    return this.sourceT >= this.duration - 1e-9;
  }

  get waveSpeed(): number {
    return this.plant.waveSpeed;
  }

  get warnings(): string[] {
    return this.plant.warnings;
  }

  private truthValues(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.sensors) out[s.id] = this.plant.valueAt(s.kind, s.x);
    return out;
  }

  private applyDueEvents(): void {
    while (this.events.length && this.events[0]!.t <= this.plant.t + 1e-9) this.applyEvent(this.events.shift()!);
  }

  private applyEvent(e: ScenarioEvent): void {
    if (e.type === 'leak') {
      const cd = 'cd' in e && e.cd ? e.cd : DEFAULT_LEAK_CD;
      const area = 'area' in e ? e.area : this.plant.leakAreaForFraction(e.x, e.sizePct / 100, cd);
      this.plant.injectLeak({ id: e.id ?? `leak${++this.leakCounter}`, x: e.x, area, cd, tStart: e.t, rampSec: e.rampSec ?? 0 });
      return;
    }
    const { t, ...action } = e;
    this.applyControlAt(action as ControlAction, t);
  }

  private applyControlAt(a: ControlAction, t: number): void {
    switch (a.type) {
      case 'pump':
      case 'valve':
        this.plant.applyControl(a);
        this.regime.push({ t, type: a.type });
        break;
      case 'noise':
        this.sensorModel.noiseScale = this.baseNoise * a.scale;
        break;
      case 'sensor-fault':
        this.sensorModel.addFault(a.sensorId, a.mode, t, a.magnitude, a.durationSec);
        this.regime.push({ t, type: a.type });
        break;
    }
  }

  step(dt: number): SensorFrame[] {
    const target = Math.min(this.sourceT + dt, this.duration);
    const frames: SensorFrame[] = [];
    const period = 1 / this.sampleRateHz;
    while (this.nextSample <= target + 1e-9) {
      const ts = this.nextSample;
      while (this.plant.t < ts - 1e-9) {
        this.applyDueEvents();
        this.prevTruth = this.truthValues();
        this.prevT = this.plant.t;
        this.plant.step();
      }
      this.applyDueEvents();
      const cur = this.truthValues();
      const span = this.plant.t - this.prevT;
      const w = span > 0 ? Math.min(1, Math.max(0, (ts - this.prevT) / span)) : 1;
      const truth: Record<string, number> = {};
      for (const id of Object.keys(cur)) truth[id] = this.prevTruth[id]! + w * (cur[id]! - this.prevTruth[id]!);
      frames.push(this.sensorModel.sample(ts, truth));
      this.nextSample = Math.round((ts + period) * 1e6) / 1e6;
    }
    this.sourceT = target;
    return frames;
  }

  /** Событие утечки размером sizePct % от текущего расхода на входе (для клика в интерфейсе). */
  leakEventForFraction(x: number, sizePct: number, rampSec = 0, id?: string): LeakEvent {
    const area = this.plant.leakAreaForFraction(x, sizePct / 100, DEFAULT_LEAK_CD);
    return { id: id ?? `leak${++this.leakCounter}`, x, area, cd: DEFAULT_LEAK_CD, tStart: this.plant.t, rampSec };
  }

  injectLeak(e: LeakEvent): void {
    this.plant.injectLeak(e);
  }

  removeLeak(id: string): void {
    this.plant.removeLeak(id);
  }

  applyControl(a: ControlAction): void {
    this.applyControlAt(a, this.plant.t);
  }

  truth(): GroundTruth {
    return {
      leaks: this.plant.leaks.map((l) => ({
        id: l.event.id,
        x: l.event.x,
        tStart: l.event.tStart,
        rate: l.rate,
        fraction: l.baseInletFlow > 0 ? l.rate / l.baseInletFlow : undefined,
      })),
      regimeEvents: [...this.regime],
    };
  }

  profile(): PipeProfile {
    return this.plant.profile();
  }
}
