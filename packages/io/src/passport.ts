/**
 * Паспорт трубы (WP-C3): «ключ — значение» из Excel/CSV или вставленный текст
 * («Длина: 50 км, диаметр 530×8 мм, нефть 850 кг/м³») → входной конфиг PipelineConfigInput.
 * Значения не переводятся здесь — это делает resolveConfig (одна точка перевода единиц).
 */
import type { PipelineConfigInput } from '@pipetwin/core';

export interface PassportResult {
  input: PipelineConfigInput;
  /** Что нашли: путь в конфиге и исходная запись. */
  found: Array<{ path: string; raw: string }>;
  /** Фрагменты, которые не поняли. */
  unknown: string[];
}

type Obj = Record<string, unknown>;

const FLUID_NAMES: Array<[RegExp, string]> = [
  [/тяж[её]л\w* нефть|heavy (crude|oil)/i, 'heavy-crude'],
  [/нефть|crude|oil/i, 'light-crude'],
  [/дизел|diesel/i, 'diesel'],
  [/вода|water/i, 'water'],
  [/газ\b|natural gas|\bgas\b/i, 'natural-gas'],
];

interface Rule {
  re: RegExp;
  apply: (input: Obj, value: string, unit: string, raw: string) => string | null;
}

function set(obj: Obj, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Obj;
  cur[parts.at(-1)!] = value;
}

const q = (value: string, unit: string) => (unit ? `${value} ${unit}` : value);

const RULES: Rule[] = [
  { re: /^(длина|протяж[её]нность|length)/i, apply: (i, v, u) => (set(i, 'geometry.length', q(v, u || 'км')), 'geometry.length') },
  {
    re: /^(диаметр|ду|dn|diameter|od)/i,
    apply: (i, v, u) => {
      const m = /^(\d+(?:[.,]\d+)?)\s*[×xх*]\s*(\d+(?:[.,]\d+)?)$/.exec(v.replace(/\s/g, ''));
      const unit = u || 'мм';
      if (m) {
        // «530×8»: наружный диаметр × толщина стенки → внутренний диаметр
        const od = Number(m[1]!.replace(',', '.'));
        const e = Number(m[2]!.replace(',', '.'));
        set(i, 'geometry.diameter', `${String(od - 2 * e).replace('.', ',')} ${unit}`);
        set(i, 'geometry.wallThickness', `${m[2]} ${unit}`);
        return 'geometry.diameter';
      }
      set(i, 'geometry.diameter', q(v, unit));
      return 'geometry.diameter';
    },
  },
  { re: /^(толщина( стенки)?|wall)/i, apply: (i, v, u) => (set(i, 'geometry.wallThickness', q(v, u || 'мм')), 'geometry.wallThickness') },
  { re: /^(шероховат|roughness)/i, apply: (i, v, u) => (set(i, 'geometry.roughness', q(v, u || 'мм')), 'geometry.roughness') },
  { re: /^(плотность|density|нефть|oil|дизел|вода|water)/i, apply: (i, v, u) => (u && /кг|kg|г\/|g\//i.test(u) ? (set(i, 'fluid.density', { model: 'constant', rho: q(v, u) }), 'fluid.density.rho') : null) },
  { re: /^(вязкость|viscosity)/i, apply: (i, v, u) => (set(i, 'fluid.viscosity', { model: 'constant', nu: q(v, u || 'сСт') }), 'fluid.viscosity.nu') },
  { re: /^(теплоёмкость|теплоемкость|heat capacity)/i, apply: (i, v, u) => (set(i, 'fluid.heatCapacity', q(v, u)), 'fluid.heatCapacity') },
  { re: /^(давление на входе|давление вход|p ?вх|inlet pressure)/i, apply: (i, v, u) => (set(i, 'boundary.inlet', { type: 'pressure', pressure: q(v, u || 'МПа') }), 'boundary.inlet.pressure') },
  { re: /^(давление на выходе|давление выход|p ?вых|outlet pressure)/i, apply: (i, v, u) => (set(i, 'boundary.outlet', { type: 'pressure', pressure: q(v, u || 'МПа') }), 'boundary.outlet.pressure') },
  { re: /^(расход|производительность|flow)/i, apply: (i, v, u) => (set(i, 'boundary.inlet', { type: 'flow', flow: q(v, u || 'м3/ч') }), 'boundary.inlet.flow') },
  { re: /^(температура (нефти|продукта|на входе)|inlet temp|t ?вх)/i, apply: (i, v, u) => (set(i, 'boundary.inletTemp', q(v, u || '°C')), 'boundary.inletTemp') },
  { re: /^(температура (грунта|окружающей|воздуха)|ambient)/i, apply: (i, v, u) => (set(i, 'thermal.ambientTemp', q(v, u || '°C')), 'thermal.ambientTemp') },
  { re: /^(коэффициент теплопередачи|теплопередача|heat transfer)/i, apply: (i, v, u) => (set(i, 'thermal.heatTransferCoef', q(v, u)), 'thermal.heatTransferCoef') },
  { re: /^(частота опроса|sampling|rate)/i, apply: (i, v, u) => (set(i, 'sampling.rateHz', q(v, u || 'Гц')), 'sampling.rateHz') },
];

/** Разбор одного фрагмента «ключ: значение единица». */
function parseSegment(seg: string, input: Obj, res: PassportResult): void {
  const s = seg.trim().replace(/\s+/g, ' ');
  if (!s) return;
  for (const [re, name] of FLUID_NAMES) {
    if (re.test(s) && !(input.fluid as Obj | undefined)?.name) {
      set(input, 'fluid.name', name);
      res.found.push({ path: 'fluid.name', raw: s });
      break;
    }
  }
  const m = /^(.*?)[\s:=—–-]*([+-]?\d[\d\s]*(?:[.,]\d+)?(?:\s*[×xх*]\s*\d+(?:[.,]\d+)?)?)\s*(.*?)\s*\.?$/.exec(s);
  if (!m) {
    if (!FLUID_NAMES.some(([re]) => re.test(s))) res.unknown.push(s);
    return;
  }
  const key = m[1]!.replace(/[:=—–-]\s*$/, '').trim().toLowerCase();
  const value = m[2]!.trim().replace(/(\d)\s+(?=\d{3}\b)/g, '$1');
  const unit = m[3]!.replace(/^[,;]\s*/, '').trim();
  for (const r of RULES) {
    if (!r.re.test(key)) continue;
    const path = r.apply(input, value, unit, s);
    if (path) {
      res.found.push({ path, raw: s });
      return;
    }
  }
  res.unknown.push(s);
}

/** Вставленный текст паспорта. Фрагменты разделяются переводом строки, «;» или «, » перед словом. */
export function parsePassportText(text: string): PassportResult {
  const input: Obj = { schemaVersion: 1 };
  const res: PassportResult = { input: input as unknown as PipelineConfigInput, found: [], unknown: [] };
  const segments = text.split(/\n|;|,\s+(?=[A-Za-zА-Яа-яЁё])/);
  for (const seg of segments) parseSegment(seg, input, res);
  return res;
}

/** Таблица «ключ — значение [— единица]» (Excel/CSV паспорта). */
export function parsePassportRows(rows: string[][]): PassportResult {
  return parsePassportText(rows.map((r) => r.filter((c) => c.trim() !== '').join(' ')).join('\n'));
}
