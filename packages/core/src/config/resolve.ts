/**
 * resolveConfig (WP-A1): входной конфиг (единицы строками, пропуски) → полный PipelineConfig в СИ
 * + статус каждого числа (given / default / calibrated) + список кандидатов на калибровку.
 *
 * Минимальный вход — длина и диаметр: остальное берётся из библиотеки, режим перекачки
 * подбирается под расчётную скорость, датчики расставляются по умолчанию.
 */
import type {
  Boundary,
  DensityModel,
  Fluid,
  InletBoundary,
  Numerics,
  OutletBoundary,
  ParamMeta,
  PipelineConfig,
  PipelineConfigInput,
  QuantityInput,
  ResolvedConfig,
  Schedule,
  SensorKind,
  SensorSpec,
  ThermalMode,
  TwinSettings,
  ViscosityModel,
} from '../contracts';
import { CONTRACTS_VERSION } from '../contracts';
import { PipeModel, G } from '../hydraulics/pipe';
import { steadyForward } from '../hydraulics/steady';
import { evalSchedule } from '../schedule';
import { parseQuantity, splitQuantity, toSI, UnitError, type Dimension, type UnitContext } from '../units';
import { ConfigError, validateFile } from './validate';
import { DEFAULT_FLUID, DEFAULTS, FLUIDS, HEAT_TRANSFER, ROUGHNESS, defaultGridStep } from './library';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Сборщик параметров со статусами и ошибками. */
class Resolver {
  readonly params: ParamMeta[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];
  ctx: UnitContext = {};

  /**
   * Прочитать числовое поле. raw — значение из входа; def — значение по умолчанию (SI).
   * delta = true — величина-разность (шум, смещение): без сдвига °C→К и без атмосферного давления.
   */
  num(path: string, raw: unknown, dim: Dimension, def?: { value: number; source: string }, delta = false): number {
    if (raw === undefined || raw === null) {
      if (!def) {
        this.errors.push(`${path}: нет обязательного значения`);
        return NaN;
      }
      this.params.push({ path, value: def.value, status: 'default', source: def.source });
      return def.value;
    }
    try {
      const { value, status, original, source } = this.parse(raw as QuantityInput, dim, delta);
      if (!Number.isFinite(value)) throw new UnitError('значение не число');
      this.params.push({ path, value, status, original, source });
      return value;
    } catch (e) {
      this.errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
      return NaN;
    }
  }

  private parse(raw: QuantityInput, dim: Dimension, delta: boolean) {
    const conv = (v: number | string, unit?: string) => {
      if (typeof v === 'number') {
        if (!unit) return v;
        return delta ? this.deltaSI(v, unit, dim) : toSI(v, unit, dim, this.ctx).value;
      }
      if (delta) {
        const parts = splitQuantity(v);
        if (!parts) throw new UnitError(`не удалось разобрать число в «${v}»`);
        return parts.unit ? this.deltaSI(parts.num, parts.unit, dim) : parts.num;
      }
      return parseQuantity(v, dim, this.ctx).value;
    };
    if (typeof raw === 'number') return { value: raw, status: 'given' as const, original: String(raw), source: undefined };
    if (typeof raw === 'string') return { value: conv(raw), status: 'given' as const, original: raw, source: undefined };
    const value = conv(raw.value, raw.unit);
    return {
      value,
      status: raw.status ?? ('given' as const),
      original: raw.unit ? `${raw.value} ${raw.unit}` : String(raw.value),
      source: raw.source,
    };
  }

  private deltaSI(v: number, unit: string, dim: Dimension): number {
    const a = toSI(v, unit, dim, this.ctx).value;
    const b = toSI(0, unit, dim, this.ctx).value;
    return a - b;
  }

  /** Расписание: число/строка/объект-величина или { points, interp }. */
  schedule(path: string, raw: unknown, dim: Dimension, def?: { value: number; source: string }): Schedule {
    if (isObj(raw) && Array.isArray(raw.points)) {
      const pts = (raw.points as unknown[][]).map((pt, i): [number, number] => [
        Number(pt[0]),
        this.num(`${path}.points.${i}`, pt[1], dim),
      ]);
      return { points: pts, interp: raw.interp === 'step' ? 'step' : 'linear' };
    }
    return this.num(path, raw, dim, def);
  }
}

function round(v: number, step: number): number {
  return Math.round(v / step) * step;
}

function sensorIdFor(kind: SensorKind, x: number, L: number): string {
  if (x <= 0) return `${kind}_in`;
  if (x >= L) return `${kind}_out`;
  const km = round(x / 1000, 0.1);
  return `${kind}_km${String(Number(km.toFixed(1))).replace('.', '_')}`;
}

function resolveFluid(r: Resolver, input: Obj | undefined): Fluid {
  const f = input ?? {};
  const name = typeof f.name === 'string' ? f.name : DEFAULT_FLUID;
  let preset = FLUIDS[name];
  if (!preset) {
    preset = FLUIDS[DEFAULT_FLUID]!;
    r.warnings.push(`fluid.name: «${name}» нет в библиотеке, недостающие свойства взяты от «${DEFAULT_FLUID}»`);
  }
  const src = `library:${preset.name}`;
  const phase = f.phase === 'gas' || f.phase === 'liquid' ? f.phase : preset.phase;

  let density: DensityModel;
  const dIn = isObj(f.density) ? f.density : undefined;
  const dBase = preset.density;
  if (dIn?.model === 'constant') {
    density = { model: 'constant', rho: r.num('fluid.density.rho', dIn.rho, 'density') };
  } else if (dIn?.model === 'linear') {
    density = {
      model: 'linear',
      rho20: r.num('fluid.density.rho20', dIn.rho20, 'density'),
      xi: r.num('fluid.density.xi', dIn.xi, 'densityPerK', undefined, true),
    };
  } else if (dBase.model === 'linear') {
    density = {
      model: 'linear',
      rho20: r.num('fluid.density.rho20', undefined, 'density', { value: dBase.rho20, source: src }),
      xi: r.num('fluid.density.xi', undefined, 'densityPerK', { value: dBase.xi, source: src }),
    };
  } else {
    density = { model: 'constant', rho: r.num('fluid.density.rho', undefined, 'density', { value: dBase.rho, source: src }) };
  }
  r.ctx = { ...r.ctx, density: density.model === 'constant' ? density.rho : density.rho20 };

  let viscosity: ViscosityModel;
  const vIn = isObj(f.viscosity) ? f.viscosity : undefined;
  if (vIn?.model === 'constant') {
    viscosity = { model: 'constant', nu: r.num('fluid.viscosity.nu', vIn.nu, 'kinViscosity') };
  } else if (vIn?.model === 'filonov-reynolds') {
    viscosity = {
      model: 'filonov-reynolds',
      nu0: r.num('fluid.viscosity.nu0', vIn.nu0, 'kinViscosity'),
      T0: r.num('fluid.viscosity.T0', vIn.T0, 'temperature'),
      u: r.num('fluid.viscosity.u', vIn.u, 'inverseTemperature'),
    };
  } else if (vIn?.model === 'walther') {
    const pts = (vIn.points as unknown[][]) ?? [];
    viscosity = {
      model: 'walther',
      points: [0, 1].map((i) => [
        r.num(`fluid.viscosity.points.${i}.T`, pts[i]?.[0], 'temperature'),
        r.num(`fluid.viscosity.points.${i}.nu`, pts[i]?.[1], 'kinViscosity'),
      ]) as [[number, number], [number, number]],
    };
  } else {
    const b = preset.viscosity;
    if (b.model === 'filonov-reynolds') {
      viscosity = {
        model: 'filonov-reynolds',
        nu0: r.num('fluid.viscosity.nu0', undefined, 'kinViscosity', { value: b.nu0, source: src }),
        T0: r.num('fluid.viscosity.T0', undefined, 'temperature', { value: b.T0, source: src }),
        u: r.num('fluid.viscosity.u', undefined, 'inverseTemperature', { value: b.u, source: src }),
      };
    } else if (b.model === 'constant') {
      viscosity = { model: 'constant', nu: r.num('fluid.viscosity.nu', undefined, 'kinViscosity', { value: b.nu, source: src }) };
    } else {
      viscosity = b;
    }
  }

  return {
    name,
    phase,
    density,
    viscosity,
    heatCapacity: r.num('fluid.heatCapacity', f.heatCapacity, 'heatCapacity', { value: preset.heatCapacity, source: src }),
    bulkModulus: r.num('fluid.bulkModulus', f.bulkModulus, 'pressure', { value: preset.bulkModulus, source: src }, true),
    vaporPressure: r.num('fluid.vaporPressure', f.vaporPressure, 'pressure', { value: preset.vaporPressure, source: src }),
  };
}

function resolveInlet(r: Resolver, raw: Obj): InletBoundary {
  switch (raw.type) {
    case 'pressure':
      return { type: 'pressure', pressure: r.schedule('boundary.inlet.pressure', raw.pressure, 'pressure') };
    case 'flow':
      return { type: 'flow', flow: r.schedule('boundary.inlet.flow', raw.flow, 'flow') };
    default: {
      const b: InletBoundary = {
        type: 'pump',
        suctionPressure: r.schedule('boundary.inlet.suctionPressure', raw.suctionPressure, 'pressure'),
        H0: r.num('boundary.inlet.H0', raw.H0, 'length'),
        b: r.num('boundary.inlet.b', raw.b, 'dimensionless'),
      };
      if (raw.speed !== undefined) b.speed = r.schedule('boundary.inlet.speed', raw.speed, 'dimensionless');
      return b;
    }
  }
}

function resolveOutlet(r: Resolver, raw: Obj): OutletBoundary {
  switch (raw.type) {
    case 'pressure':
      return { type: 'pressure', pressure: r.schedule('boundary.outlet.pressure', raw.pressure, 'pressure') };
    case 'flow':
      return { type: 'flow', flow: r.schedule('boundary.outlet.flow', raw.flow, 'flow') };
    case 'closed':
      return { type: 'closed' };
    default:
      return {
        type: 'valve',
        downstreamPressure: r.schedule('boundary.outlet.downstreamPressure', raw.downstreamPressure, 'pressure'),
        cv: r.num('boundary.outlet.cv', raw.cv, 'area'),
        opening: r.schedule('boundary.outlet.opening', raw.opening, 'dimensionless'),
      };
  }
}

/**
 * Режим по умолчанию: насос на входе и задвижка на выходе, подобранные под расчётную скорость.
 * Давление по всей трассе держится выше давления паров с запасом.
 */
function designBoundary(r: Resolver, cfg: PipelineConfig, inlet?: InletBoundary, outlet?: OutletBoundary): { inlet: InletBoundary; outlet: OutletBoundary; pMax: number; q0: number } {
  const model = new PipeModel(cfg);
  const Tin = evalSchedule(cfg.boundary.inletTemp, 0);
  const rhoIn = model.fluid.rho(Tin);
  const src = `design:v=${DEFAULTS.designVelocity} м/с`;
  let q0 = DEFAULTS.designVelocity * model.A;
  if (inlet?.type === 'flow') q0 = evalSchedule(inlet.flow, 0);
  if (outlet?.type === 'flow') q0 = evalSchedule(outlet.flow, 0);
  const m0 = rhoIn * q0;
  const rel = steadyForward(model, 0, m0, Tin).p;
  const rN = rel[model.N]!;
  let rMin = 0;
  for (const v of rel) rMin = Math.min(rMin, v);
  const pMinLine = Math.max(model.fluid.vaporPressure, cfg.ambientPressure) + DEFAULTS.lineMarginPressure;
  const pd = DEFAULTS.downstreamPressure;
  let p0 = Math.max(pd + DEFAULTS.valveDrop - rN, pMinLine - rMin);
  if (inlet?.type === 'pressure') p0 = evalSchedule(inlet.pressure, 0);
  const pN = p0 + rN;
  const rhoN = model.fluid.rho(steadyForward(model, p0, m0, Tin).T[model.N - 1]!);

  let outletB = outlet;
  if (!outletB) {
    const drop = Math.max(pN - pd, 0.05e6);
    const cv = q0 / (DEFAULTS.valveOpening * Math.sqrt(drop / rhoN));
    if (pN - pd < 0.05e6) r.warnings.push('boundary.outlet: при заданном давлении на входе перепад на задвижке мал — режим подобран условно');
    outletB = {
      type: 'valve',
      downstreamPressure: r.num('boundary.outlet.downstreamPressure', undefined, 'pressure', { value: pd, source: src }),
      cv: r.num('boundary.outlet.cv', undefined, 'area', { value: cv, source: src }),
      opening: r.num('boundary.outlet.opening', undefined, 'dimensionless', { value: DEFAULTS.valveOpening, source: src }),
    };
  }
  let inletB = inlet;
  if (!inletB) {
    const ps = DEFAULTS.suctionPressure;
    const Hop = (p0 - ps) / (rhoIn * G);
    if (Hop > 1) {
      const H0 = Hop * DEFAULTS.pumpShutoffRatio;
      inletB = {
        type: 'pump',
        suctionPressure: r.num('boundary.inlet.suctionPressure', undefined, 'pressure', { value: ps, source: src }),
        H0: r.num('boundary.inlet.H0', undefined, 'length', { value: H0, source: src }),
        b: r.num('boundary.inlet.b', undefined, 'dimensionless', { value: (H0 - Hop) / (q0 * q0), source: src }),
      };
    } else {
      inletB = { type: 'pressure', pressure: r.num('boundary.inlet.pressure', undefined, 'pressure', { value: p0, source: src }) };
    }
  }
  return { inlet: inletB, outlet: outletB, pMax: Math.max(p0, pN), q0 };
}

function resolveSensor(r: Resolver, raw: Obj, idx: number, L: number, ranges: Record<SensorKind, [number, number]>): SensorSpec | null {
  const kind = raw.kind as SensorKind;
  const id = typeof raw.id === 'string' ? raw.id : `sensor${idx}`;
  const base = `sensors.${id}`;
  const x = r.num(`${base}.x`, raw.x, 'length');
  if (x < 0 || x > L + 1e-6) r.errors.push(`${base}.x: датчик за пределами трубы (${x} м при длине ${L} м)`);
  const dim: Dimension = kind === 'p' ? 'pressure' : kind === 'T' ? 'temperature' : 'flow';
  let range: [number, number];
  if (Array.isArray(raw.range)) {
    range = [r.num(`${base}.range.0`, raw.range[0], dim), r.num(`${base}.range.1`, raw.range[1], dim)];
  } else {
    range = ranges[kind];
  }
  const width = range[1] - range[0];
  const d = DEFAULTS.sensors;
  let noiseStd: number;
  if (raw.noiseStd !== undefined) noiseStd = r.num(`${base}.noiseStd`, raw.noiseStd, dim, undefined, true);
  else if (typeof raw.noisePct === 'number') {
    noiseStd = (raw.noisePct / 100) * width;
    r.params.push({ path: `${base}.noiseStd`, value: noiseStd, status: 'given', original: `${raw.noisePct}% шкалы` });
  } else if (typeof raw.noiseK === 'number') {
    noiseStd = raw.noiseK;
    r.params.push({ path: `${base}.noiseStd`, value: noiseStd, status: 'given', original: `${raw.noiseK} К` });
  } else {
    const def = kind === 'T' ? d.T.noiseK : ((kind === 'p' ? d.p.noisePctOfRange : d.q.noisePctOfRange) / 100) * width;
    noiseStd = r.num(`${base}.noiseStd`, undefined, dim, { value: def, source: 'library:sensor' }, true);
  }
  const s: SensorSpec = {
    id,
    kind,
    x: Math.min(Math.max(x, 0), L),
    noiseStd,
    lagSec: r.num(`${base}.lagSec`, raw.lagSec, 'time', { value: d[kind].lagSec, source: 'library:sensor' }),
    range,
    bias: r.num(`${base}.bias`, raw.bias, dim, { value: 0, source: 'library:sensor' }, true),
  };
  if (typeof raw.label === 'string') s.label = raw.label;
  if (raw.drift !== undefined) s.drift = r.num(`${base}.drift`, raw.drift, dim, undefined, true);
  if (raw.quantum !== undefined) s.quantum = r.num(`${base}.quantum`, raw.quantum, dim, undefined, true);
  for (const k of ['dropoutProb', 'outlierProb', 'outlierScale', 'timeJitterSec'] as const) {
    if (typeof raw[k] === 'number') s[k] = raw[k] as number;
  }
  return s;
}

function defaultSensors(L: number): Obj[] {
  const list: Obj[] = [
    { id: 'p_in', kind: 'p', x: 0, label: 'Давление, вход' },
    { id: 'q_in', kind: 'q', x: 0, label: 'Расход, вход' },
    { id: 'T_in', kind: 'T', x: 0, label: 'Температура, вход' },
  ];
  const n = Math.max(1, Math.floor(L / DEFAULTS.sensorSpacing));
  for (let k = 1; k <= n; k++) {
    const x = round((L * k) / (n + 1), 100);
    list.push({ id: sensorIdFor('p', x, L), kind: 'p', x, label: `Давление, км ${(x / 1000).toFixed(1)}` });
  }
  list.push(
    { id: 'p_out', kind: 'p', x: L, label: 'Давление, выход' },
    { id: 'q_out', kind: 'q', x: L, label: 'Расход, выход' },
    { id: 'T_out', kind: 'T', x: L, label: 'Температура, выход' },
  );
  return list;
}

/** Есть ли на конце трубы датчик давления или расхода. */
function hasEndSensor(sensors: SensorSpec[], x: number): boolean {
  return sensors.some((s) => (s.kind === 'p' || s.kind === 'q') && Math.abs(s.x - x) < 1e-6);
}

export interface ResolveOptions {
  /** Подпись источника для параметров со статусом given (имя файла). */
  source?: string;
}

/** Главная функция: см. описание модуля. Бросает ConfigError с перечнем «поле: причина». */
export function resolveConfig(inputRaw: unknown, opts: ResolveOptions = {}): ResolvedConfig {
  const schemaIssues = validateFile('pipeline', inputRaw);
  if (schemaIssues.length) throw new ConfigError(schemaIssues, opts.source ?? 'конфиг трубы');
  const input = inputRaw as PipelineConfigInput;
  const r = new Resolver();

  const ambientPressure = r.num('ambientPressure', input.ambientPressure, 'pressure', {
    value: DEFAULTS.ambientPressure,
    source: 'library:standard-atmosphere',
  });
  r.ctx = { ambientPressure };

  const fluid = resolveFluid(r, input.fluid as Obj | undefined);

  // геометрия
  const g = (input.geometry ?? {}) as Obj;
  const length = r.num('geometry.length', g.length, 'length');
  const diameter = r.num('geometry.diameter', g.diameter, 'length');
  if (length <= 0) r.errors.push(`geometry.length: значение должно быть > 0, получено ${length} м`);
  if (diameter <= 0) r.errors.push(`geometry.diameter: значение должно быть > 0, получено ${diameter} м`);
  const wallThickness = r.num('geometry.wallThickness', g.wallThickness, 'length', {
    value: Math.max(0.005, diameter * DEFAULTS.wallThicknessFraction),
    source: 'library:steel',
  });
  if (wallThickness <= 0 || wallThickness >= diameter / 2) r.errors.push(`geometry.wallThickness: должно быть в (0, D/2), получено ${wallThickness} м`);
  const wallModulus = r.num('geometry.wallModulus', g.wallModulus, 'pressure', { value: DEFAULTS.wallModulus, source: 'library:steel' }, true);
  const roughness = r.num('geometry.roughness', g.roughness, 'length', { value: ROUGHNESS['steel-new'], source: 'library:steel-new' });
  if (roughness < 0) r.errors.push('geometry.roughness: не может быть отрицательной');
  let elevation: Array<[number, number]>;
  if (Array.isArray(g.elevation)) {
    elevation = (g.elevation as unknown[][]).map((pt, i): [number, number] => [
      r.num(`geometry.elevation.${i}.x`, pt[0], 'length'),
      r.num(`geometry.elevation.${i}.z`, pt[1], 'length'),
    ]);
    for (let i = 1; i < elevation.length; i++) {
      if (!(elevation[i]![0] > elevation[i - 1]![0])) r.errors.push(`geometry.elevation: координаты x должны возрастать (точка ${i})`);
    }
    if (elevation.length && elevation[0]![0] > 0) elevation.unshift([0, elevation[0]![1]]);
    const last = elevation[elevation.length - 1];
    if (last && last[0] < length) elevation.push([length, last[1]]);
    if (elevation.some((p) => p[0] > length + 1e-6)) {
      r.warnings.push('geometry.elevation: точки за пределами длины трубы отброшены');
      elevation = elevation.filter((p) => p[0] <= length + 1e-6);
    }
  } else {
    elevation = [[0, 0], [length, 0]];
    r.params.push({ path: 'geometry.elevation', value: 0, status: 'default', source: 'library:flat' });
  }

  const th = (input.thermal ?? {}) as Obj;
  const thermal = {
    ambientTemp: r.num('thermal.ambientTemp', th.ambientTemp, 'temperature', { value: DEFAULTS.ambientTemp, source: 'library:climate' }),
    heatTransferCoef: r.num('thermal.heatTransferCoef', th.heatTransferCoef, 'heatTransfer', {
      value: HEAT_TRANSFER.underground,
      source: 'library:underground',
    }),
  };

  const sp = (input.sampling ?? {}) as Obj;
  const rateHz = r.num('sampling.rateHz', sp.rateHz, 'frequency', { value: DEFAULTS.rateHz, source: 'library:scada' });
  if (rateHz <= 0) r.errors.push('sampling.rateHz: должно быть > 0');

  const nIn = (input.numerics ?? {}) as Obj;
  const numerics: Numerics = {
    dx: r.num('numerics.dx', nIn.dx, 'length', { value: defaultGridStep(length), source: 'library:grid' }),
    frictionModel: (nIn.frictionModel as Numerics['frictionModel']) ?? 'colebrook',
    thermalMode: (nIn.thermalMode as ThermalMode) ?? 'quasi-steady',
  };
  if (nIn.waveSpeed !== undefined) numerics.waveSpeed = r.num('numerics.waveSpeed', nIn.waveSpeed, 'velocity');
  if (numerics.dx <= 0 || numerics.dx > length / 2) r.errors.push(`numerics.dx: должно быть в (0, L/2], получено ${numerics.dx} м`);

  if (r.errors.length) throw new ConfigError(r.errors, opts.source ?? 'конфиг трубы');

  // граничные условия
  const bIn = (input.boundary ?? {}) as Obj;
  const preset = FLUIDS[fluid.name] ?? FLUIDS[DEFAULT_FLUID]!;
  const inletTemp = r.schedule('boundary.inletTemp', bIn.inletTemp, 'temperature', {
    value: preset.typicalInletTemp,
    source: `library:${preset.name}`,
  });
  let inlet = isObj(bIn.inlet) ? resolveInlet(r, bIn.inlet) : undefined;
  let outlet = isObj(bIn.outlet) ? resolveOutlet(r, bIn.outlet) : undefined;
  if (r.errors.length) throw new ConfigError(r.errors, opts.source ?? 'конфиг трубы');

  const twinIn = (input.twin ?? {}) as Partial<TwinSettings>;
  const draft: PipelineConfig = {
    schemaVersion: CONTRACTS_VERSION,
    meta: { name: input.meta?.name ?? 'pipeline', ...(input.meta?.description ? { description: input.meta.description } : {}) },
    geometry: { length, diameter, wallThickness, wallModulus, roughness, elevation },
    fluid,
    thermal,
    boundary: {
      inlet: inlet ?? { type: 'pressure', pressure: 1e6 },
      outlet: outlet ?? { type: 'pressure', pressure: 1e5 },
      inletTemp,
    },
    sensors: [],
    sampling: { rateHz },
    ambientPressure,
    twin: { boundaryMode: twinIn.boundaryMode ?? 'auto' },
    numerics,
  };

  // Диапазоны шкал по умолчанию — от расчётного режима.
  const design = designBoundary(r, draft, inlet, outlet);
  if (!inlet || !outlet) {
    inlet = design.inlet;
    outlet = design.outlet;
  }
  const boundary: Boundary = { inlet, outlet, inletTemp };
  const pTop = Math.ceil((design.pMax * 1.3) / 0.5e6) * 0.5e6;
  const ranges: Record<SensorKind, [number, number]> = {
    p: [ambientPressure, Math.max(pTop, 1e6)],
    q: [0, Number((design.q0 * 2).toPrecision(2))],
    T: [233.15, 373.15],
  };

  const sensorInputs = Array.isArray(input.sensors) ? (input.sensors as Obj[]) : defaultSensors(length);
  if (!Array.isArray(input.sensors)) r.warnings.push('sensors: не заданы — расстановка по умолчанию (вход, выход, каждые ~15 км)');
  const sensors = sensorInputs.map((s, i) => resolveSensor(r, s, i, length, ranges)).filter((s): s is SensorSpec => !!s);
  const ids = new Set<string>();
  for (const s of sensors) {
    if (ids.has(s.id)) r.errors.push(`sensors: повторяется id «${s.id}»`);
    ids.add(s.id);
  }

  const twin: TwinSettings = {
    model: twinIn.model ?? (hasEndSensor(sensors, 0) && hasEndSensor(sensors, length) ? 'transient' : 'steady'),
    boundaryMode: twinIn.boundaryMode ?? 'auto',
    ...(twinIn.inputFilterSec !== undefined ? { inputFilterSec: twinIn.inputFilterSec } : {}),
    ...(twinIn.inputFilter !== undefined ? { inputFilter: twinIn.inputFilter } : {}),
  };
  for (const k of ['inletPressureSensor', 'outletPressureSensor', 'flowSensor', 'inletTempSensor'] as const) {
    const id = twinIn[k];
    if (id !== undefined) {
      if (!ids.has(id)) r.errors.push(`twin.${k}: нет датчика «${id}»`);
      twin[k] = id;
    }
  }
  if (r.errors.length) throw new ConfigError(r.errors, opts.source ?? 'конфиг трубы');

  const config: PipelineConfig = { ...draft, boundary, sensors, twin };

  if (opts.source) for (const p of r.params) if (p.status === 'given' && !p.source) p.source = opts.source;
  const candidatePaths = ['geometry.roughness', 'thermal.heatTransferCoef', 'fluid.viscosity.nu', 'fluid.viscosity.nu0'];
  const calibrationCandidates = r.params.filter((p) => p.status === 'default' && candidatePaths.includes(p.path)).map((p) => p.path);
  return { config, params: r.params, calibrationCandidates, warnings: r.warnings };
}

/** Объединить входные конфиги: объекты рекурсивно, датчики — по id, прочие массивы — заменой. */
export function mergeConfigInput<T extends object>(base: T, over: object | undefined): T {
  if (!over) return structuredClone(base);
  const out = structuredClone(base) as Obj;
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k];
    if (k === 'sensors' && Array.isArray(cur) && Array.isArray(v)) {
      const list = cur as Obj[];
      for (const s of v as Obj[]) {
        const i = list.findIndex((c) => c.id === s.id);
        if (i >= 0) list[i] = { ...list[i], ...s };
        else list.push(s);
      }
    } else if (isObj(cur) && isObj(v)) {
      out[k] = mergeConfigInput(cur, v);
    } else {
      out[k] = structuredClone(v);
    }
  }
  return out as T;
}
