/**
 * Единицы измерения (WP-A1). Перевод строк вида «1,2 МПа», «60 °C», «45 сСт», «1200 м3/ч»
 * в СИ и обратно. Используется только на границе системы: загрузчик конфига, импорт, интерфейс.
 *
 * Давление в СИ — абсолютное. Избыточное отмечается в единице: «бар изб», «МПа(и)», «barg», «ати».
 */

export type Dimension =
  | 'pressure'
  | 'temperature'
  | 'length'
  | 'area'
  | 'flow'
  | 'massFlow'
  | 'kinViscosity'
  | 'dynViscosity'
  | 'density'
  | 'densityPerK'
  | 'inverseTemperature'
  | 'time'
  | 'frequency'
  | 'velocity'
  | 'heatCapacity'
  | 'heatTransfer'
  | 'fraction'
  | 'dimensionless';

interface UnitDef {
  dim: Dimension;
  /** SI = value·factor + offset. */
  factor: number;
  offset?: number;
  label: string;
}

const U = (dim: Dimension, factor: number, label: string, offset = 0): UnitDef => ({ dim, factor, offset, label });

/** Таблица единиц: псевдонимы (после нормализации) → определения. Один псевдоним может значить разное. */
const TABLE: Array<[string[], UnitDef]> = [
  // секунды — первыми: «с» без ожидаемой величины читается как время, а не как °C
  [['с', 's', 'сек', 'sec'], U('time', 1, 'с')],
  // давление
  [['па', 'pa'], U('pressure', 1, 'Па')],
  [['кпа', 'kpa'], U('pressure', 1e3, 'кПа')],
  [['мпа', 'mpa'], U('pressure', 1e6, 'МПа')],
  [['гпа', 'gpa'], U('pressure', 1e9, 'ГПа')],
  [['бар', 'bar'], U('pressure', 1e5, 'бар')],
  [['мбар', 'mbar'], U('pressure', 100, 'мбар')],
  [['атм', 'atm'], U('pressure', 101325, 'атм')],
  [['ат', 'кгс/см2', 'kgf/cm2', 'at'], U('pressure', 98066.5, 'кгс/см²')],
  [['psi'], U('pressure', 6894.757293168, 'psi')],
  [['ммрт.ст.', 'ммртст', 'mmhg'], U('pressure', 133.322387415, 'мм рт. ст.')],
  // температура
  [['k', 'к', 'kelvin'], U('temperature', 1, 'К')],
  [['°c', '°с', 'c', 'с', 'градc', 'градс', 'degc'], U('temperature', 1, '°C', 273.15)],
  [['°f', 'f', 'degf'], U('temperature', 5 / 9, '°F', 273.15 - (32 * 5) / 9)],
  // длина и площадь
  [['м', 'm'], U('length', 1, 'м')],
  [['мм', 'mm'], U('length', 1e-3, 'мм')],
  [['см', 'cm'], U('length', 1e-2, 'см')],
  [['км', 'km'], U('length', 1e3, 'км')],
  [['мкм', 'um', 'μm', 'µm'], U('length', 1e-6, 'мкм')],
  [['дюйм', 'in', '"'], U('length', 0.0254, 'дюйм')],
  [['м2', 'm2'], U('area', 1, 'м²')],
  [['см2', 'cm2'], U('area', 1e-4, 'см²')],
  [['мм2', 'mm2'], U('area', 1e-6, 'мм²')],
  // объёмный расход
  [['м3/с', 'm3/s'], U('flow', 1, 'м³/с')],
  [['м3/ч', 'm3/h', 'м3/час'], U('flow', 1 / 3600, 'м³/ч')],
  [['м3/сут', 'm3/d', 'm3/day'], U('flow', 1 / 86400, 'м³/сут')],
  [['л/с', 'l/s'], U('flow', 1e-3, 'л/с')],
  [['л/мин', 'l/min'], U('flow', 1e-3 / 60, 'л/мин')],
  [['bbl/d', 'баррель/сут'], U('flow', 0.158987294928 / 86400, 'bbl/d')],
  // массовый расход
  [['кг/с', 'kg/s'], U('massFlow', 1, 'кг/с')],
  [['т/ч', 't/h'], U('massFlow', 1000 / 3600, 'т/ч')],
  [['т/сут', 't/d'], U('massFlow', 1000 / 86400, 'т/сут')],
  // вязкость
  [['м2/с', 'm2/s'], U('kinViscosity', 1, 'м²/с')],
  [['сст', 'cst', 'мм2/с', 'mm2/s'], U('kinViscosity', 1e-6, 'сСт')],
  [['ст', 'st'], U('kinViscosity', 1e-4, 'Ст')],
  [['па*с', 'pa*s', 'па.с', 'pa.s'], U('dynViscosity', 1, 'Па·с')],
  [['мпа*с', 'mpa*s', 'мпа.с', 'mpa.s', 'сп', 'cp'], U('dynViscosity', 1e-3, 'мПа·с')],
  // плотность
  [['кг/м3', 'kg/m3'], U('density', 1, 'кг/м³')],
  [['г/см3', 'g/cm3', 'т/м3', 't/m3'], U('density', 1000, 'г/см³')],
  [['кг/м3*к', 'kg/m3*k', 'кг/м3/к', 'кг/м3*°c', 'кг/м3/°c'], U('densityPerK', 1, 'кг/(м³·К)')],
  [['1/к', '1/k', '1/°c', 'к^-1', 'k^-1'], U('inverseTemperature', 1, '1/К')],
  // время, частота, скорость
  [['мс', 'ms'], U('time', 1e-3, 'мс')],
  [['мин', 'min'], U('time', 60, 'мин')],
  [['ч', 'h', 'час', 'hr'], U('time', 3600, 'ч')],
  [['сут', 'd', 'day'], U('time', 86400, 'сут')],
  [['гц', 'hz'], U('frequency', 1, 'Гц')],
  [['кгц', 'khz'], U('frequency', 1e3, 'кГц')],
  [['м/с', 'm/s'], U('velocity', 1, 'м/с')],
  [['км/ч', 'km/h'], U('velocity', 1 / 3.6, 'км/ч')],
  // теплофизика
  [['дж/кг*к', 'j/kg*k', 'дж/кг/к', 'дж/кг*°c', 'j/kg/k'], U('heatCapacity', 1, 'Дж/(кг·К)')],
  [['кдж/кг*к', 'kj/kg*k', 'кдж/кг/к', 'кдж/кг*°c', 'kj/kg/k'], U('heatCapacity', 1e3, 'кДж/(кг·К)')],
  [['вт/м2*к', 'w/m2*k', 'вт/м2/к', 'вт/м2*°c', 'w/m2/k'], U('heatTransfer', 1, 'Вт/(м²·К)')],
  // безразмерные
  [['%'], U('fraction', 0.01, '%')],
  [[''], U('dimensionless', 1, '')],
];

const ALIASES = new Map<string, UnitDef[]>();
for (const [aliases, def] of TABLE) {
  for (const a of aliases) {
    const list = ALIASES.get(a) ?? [];
    list.push(def);
    ALIASES.set(a, list);
  }
}

export class UnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnitError';
  }
}

export interface ParsedQuantity {
  /** Значение в СИ; давление — абсолютное. */
  value: number;
  dim: Dimension;
  /** Единица, как её поняли (для логов и интерфейса). */
  unit: string;
  /** Давление было задано как избыточное. */
  gauge: boolean;
}

export interface UnitContext {
  /** Плотность, кг/м³ — для перевода т/ч ↔ м³/с и сП ↔ сСт. */
  density?: number;
  /** Атмосферное давление, Па — для перевода избыточного в абсолютное. */
  ambientPressure?: number;
}

export const STANDARD_ATMOSPHERE = 101325;

/** Число из строки: десятичная запятая, пробелы между разрядами, экспонента. */
export function parseNumber(s: string): number | null {
  const m = /^\s*([+-]?(?:\d{1,3}(?:[   ]\d{3})+|\d+)?(?:[.,]\d+)?(?:[eE][+-]?\d+)?)\s*$/.exec(s);
  if (!m || !m[1] || !/\d/.test(m[1])) return null;
  const v = Number(m[1].replace(/[   ]/g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

/** Разделить «1,2 МПа» на число и единицу. */
export function splitQuantity(s: string): { num: number; unit: string } | null {
  const m = /^\s*([+-]?(?:\d{1,3}(?:[   ]\d{3})+|\d+)?(?:[.,]\d+)?(?:[eE][+-]?\d+)?)\s*(.*?)\s*$/.exec(s);
  if (!m || !m[1] || !/\d/.test(m[1])) return null;
  const num = parseNumber(m[1]);
  return num === null ? null : { num, unit: m[2] ?? '' };
}

interface NormalizedUnit {
  key: string;
  gauge: boolean;
  absolute: boolean;
}

/** Нормализовать запись единицы: регистр, надстрочные знаки, разделители, отметки «изб»/«абс». */
export function normalizeUnit(raw: string): NormalizedUnit {
  let s = raw.trim().toLowerCase();
  s = s
    .replace(/³/g, '3')
    .replace(/²/g, '2')
    .replace(/[·⋅•×]/g, '*')
    .replace(/[º˚]/g, '°')
    .replace(/℃/g, '°c')
    .replace(/градус(ов|а)?\s*(цельсия)?/g, '°c')
    .replace(/[\[\]]/g, '');
  let gauge = false;
  let absolute = false;
  const gaugeRe = /(\s*\(изб\.?\)|\s*\(и\)|\s*изб\.?|\s*\(g\)|\s*gauge)$/;
  const absRe = /(\s*\(абс\.?\)|\s*\(а\)|\s*абс\.?|\s*\(a\)|\s*abs)$/;
  if (gaugeRe.test(s)) {
    gauge = true;
    s = s.replace(gaugeRe, '');
  } else if (absRe.test(s)) {
    absolute = true;
    s = s.replace(absRe, '');
  } else if (/^ати$/.test(s)) {
    gauge = true;
    s = 'ат';
  } else if (/^(bar|psi|kpa|mpa)g$/.test(s)) {
    gauge = true;
    s = s.slice(0, -1);
  } else if (/^(bar|psi|kpa|mpa)a$/.test(s)) {
    absolute = true;
    s = s.slice(0, -1);
  }
  s = s.replace(/\s+/g, '').replace(/[()]/g, '');
  return { key: s, gauge, absolute };
}

function lookup(raw: string, expected?: Dimension): { def: UnitDef; gauge: boolean } {
  const n = normalizeUnit(raw);
  const defs = ALIASES.get(n.key);
  if (!defs) throw new UnitError(`неизвестная единица «${raw}»`);
  let def: UnitDef | undefined;
  if (expected) {
    def =
      defs.find((d) => d.dim === expected) ??
      // величина, которую можно перевести через плотность
      defs.find(
        (d) =>
          (expected === 'flow' && d.dim === 'massFlow') ||
          (expected === 'kinViscosity' && d.dim === 'dynViscosity') ||
          (expected === 'dimensionless' && d.dim === 'fraction') ||
          (expected === 'fraction' && d.dim === 'dimensionless'),
      );
    if (!def) throw new UnitError(`единица «${raw}» не подходит: ожидалась единица величины «${DIM_NAMES[expected]}»`);
  } else {
    def = defs[0]!;
  }
  if ((n.gauge || n.absolute) && def.dim !== 'pressure') {
    throw new UnitError(`отметка «изб/абс» допустима только для давления: «${raw}»`);
  }
  return { def, gauge: n.gauge };
}

/** Перевести число в заданной единице в СИ. */
export function toSI(value: number, unit: string, expected?: Dimension, ctx: UnitContext = {}): ParsedQuantity {
  const { def, gauge } = lookup(unit, expected);
  let v = value * def.factor + (def.offset ?? 0);
  let dim = def.dim;
  if (expected === 'flow' && dim === 'massFlow') {
    if (!ctx.density) throw new UnitError(`для перевода «${unit}» в м³/с нужна плотность`);
    v /= ctx.density;
    dim = 'flow';
  }
  if (expected === 'kinViscosity' && dim === 'dynViscosity') {
    if (!ctx.density) throw new UnitError(`для перевода «${unit}» в м²/с нужна плотность`);
    v /= ctx.density;
    dim = 'kinViscosity';
  }
  if (expected === 'dimensionless' && dim === 'fraction') dim = 'dimensionless';
  if (dim === 'pressure' && gauge) v += ctx.ambientPressure ?? STANDARD_ATMOSPHERE;
  return { value: v, dim, unit: def.label + (gauge ? ' изб' : ''), gauge };
}

/** Разобрать строку «число единица». Строка без единицы — число в СИ. */
export function parseQuantity(input: string, expected?: Dimension, ctx: UnitContext = {}): ParsedQuantity {
  const parts = splitQuantity(input);
  if (!parts) throw new UnitError(`не удалось разобрать число в «${input}»`);
  if (!parts.unit) {
    return { value: parts.num, dim: expected ?? 'dimensionless', unit: '', gauge: false };
  }
  return toSI(parts.num, parts.unit, expected, ctx);
}

/** Перевести значение из СИ в заданную единицу (для интерфейса). */
export function fromSI(valueSI: number, unit: string, expected?: Dimension, ctx: UnitContext = {}): number {
  const { def, gauge } = lookup(unit, expected);
  let v = valueSI;
  if (def.dim === 'pressure' && gauge) v -= ctx.ambientPressure ?? STANDARD_ATMOSPHERE;
  if (expected === 'flow' && def.dim === 'massFlow') v *= ctx.density ?? NaN;
  if (expected === 'kinViscosity' && def.dim === 'dynViscosity') v *= ctx.density ?? NaN;
  return (v - (def.offset ?? 0)) / def.factor;
}

/** Известна ли единица (с учётом ожидаемой величины). */
export function isKnownUnit(unit: string, expected?: Dimension): boolean {
  try {
    lookup(unit, expected);
    return true;
  } catch {
    return false;
  }
}

/** Величина, которую обозначает единица (первая подходящая). */
export function unitDimension(unit: string): Dimension | null {
  try {
    return lookup(unit).def.dim;
  } catch {
    return null;
  }
}

export const DIM_NAMES: Record<Dimension, string> = {
  pressure: 'давление',
  temperature: 'температура',
  length: 'длина',
  area: 'площадь',
  flow: 'объёмный расход',
  massFlow: 'массовый расход',
  kinViscosity: 'кинематическая вязкость',
  dynViscosity: 'динамическая вязкость',
  density: 'плотность',
  densityPerK: 'температурная поправка плотности',
  inverseTemperature: 'обратная температура',
  time: 'время',
  frequency: 'частота',
  velocity: 'скорость',
  heatCapacity: 'теплоёмкость',
  heatTransfer: 'коэффициент теплопередачи',
  fraction: 'доля',
  dimensionless: 'безразмерная',
};

/** Единицы СИ для подписи величин. */
export const SI_LABELS: Record<Dimension, string> = {
  pressure: 'Па',
  temperature: 'К',
  length: 'м',
  area: 'м²',
  flow: 'м³/с',
  massFlow: 'кг/с',
  kinViscosity: 'м²/с',
  dynViscosity: 'Па·с',
  density: 'кг/м³',
  densityPerK: 'кг/(м³·К)',
  inverseTemperature: '1/К',
  time: 'с',
  frequency: 'Гц',
  velocity: 'м/с',
  heatCapacity: 'Дж/(кг·К)',
  heatTransfer: 'Вт/(м²·К)',
  fraction: '',
  dimensionless: '',
};
