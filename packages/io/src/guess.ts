/**
 * Автоугадывание колонок (WP-C2): род величины по имени (рус/англ, тэги КИП), единица из заголовка,
 * положение датчика из имени, эвристика по величине. Неоднозначное — в список вопросов к человеку.
 */
import { isKnownUnit, unitDimension, type Dimension, type SensorKind } from '@pipetwin/core';

export interface ColumnGuess {
  name: string;
  kind?: SensorKind;
  unit?: string;
  /** Положение, м; 'in'/'out' — вход/выход (длина трубы может быть ещё неизвестна). */
  x?: number | 'in' | 'out';
  /** 0..1 — насколько уверены. */
  confidence: number;
  /** Что спросить у человека. */
  questions: string[];
}

const KIND_PATTERNS: Array<[SensorKind, RegExp]> = [
  ['p', /(давлен|pressure|напор|^p(?![a-zа-я])|^p[_\s-]|^pt[-_ ]?\d|^pi[-_ ]?\d|^pit[-_ ]?\d|^pdt)/i],
  ['T', /(температур|temperature|temp|^t(?![a-zа-яi])[_\s-]?\w|^tt[-_ ]?\d|^ti[-_ ]?\d|^te[-_ ]?\d)/i],
  ['q', /(расход|flow|^q(?![a-zа-я])|^q[_\s-]|^ft[-_ ]?\d|^fi[-_ ]?\d|^fit[-_ ]?\d|^fq[-_ ]?\d|^f(?![a-zа-я])[_\s-]?\w)/i],
];

const DIM_TO_KIND: Partial<Record<Dimension, SensorKind>> = { pressure: 'p', temperature: 'T', flow: 'q', massFlow: 'q' };

export function guessKind(name: string): SensorKind | undefined {
  const n = name.trim();
  for (const [kind, re] of KIND_PATTERNS) if (re.test(n)) return kind;
  return undefined;
}

/** Единица из заголовка: «P_вх, МПа», «Q [м3/ч]», «T (°C)». */
export function unitFromHeader(name: string): string | undefined {
  const m = /(?:,\s*|\[\s*|\(\s*)([^,()[\]]+?)\s*[\])]?\s*$/.exec(name);
  if (m && isKnownUnit(m[1]!)) return m[1]!.trim();
  return undefined;
}

/** Положение из имени: «км 12,5», «KP12», «km_25», «вход», «out». */
export function positionFromName(name: string): number | 'in' | 'out' | undefined {
  const m = /(?:км|km|kp|кп)\s*[_.\s-]?\s*(\d+(?:[.,_]\d+)?)/i.exec(name);
  if (m) return Number(m[1]!.replace(/[,_]/, '.')) * 1000;
  if (/(вход|вх\b|вх[_\s.,]|\bin\b|_in\b|inlet)/i.test(name)) return 'in';
  if (/(выход|вых\b|вых[_\s.,]|\bout\b|_out\b|outlet)/i.test(name)) return 'out';
  return undefined;
}

/** Единица по величине значений, если в заголовке её нет. */
export function unitFromMagnitude(kind: SensorKind, median: number): { unit: string; ambiguous?: string } {
  const a = Math.abs(median);
  if (kind === 'p') {
    if (a > 2e4) return { unit: 'Па' };
    if (a > 300) return { unit: 'кПа' };
    if (a > 15) return { unit: 'бар', ambiguous: 'бар или кгс/см²?' };
    return { unit: 'МПа', ambiguous: 'МПа или бар?' };
  }
  if (kind === 'T') return a > 150 ? { unit: 'K' } : { unit: '°C' };
  if (a > 5) return { unit: 'м3/ч' };
  return { unit: 'м3/с', ambiguous: 'м³/с или другая единица?' };
}

export function guessColumn(name: string, values: Float64Array, unitsRowValue?: string): ColumnGuess {
  const questions: string[] = [];
  let unit = unitFromHeader(name) ?? (unitsRowValue && isKnownUnit(unitsRowValue) ? unitsRowValue.trim() : undefined);
  let kind = guessKind(name);
  let confidence = kind ? 0.8 : 0.3;
  if (unit) {
    const dim = unitDimension(unit);
    const byUnit = dim ? DIM_TO_KIND[dim] : undefined;
    if (byUnit && !kind) {
      kind = byUnit;
      confidence = 0.7;
    } else if (byUnit && kind && byUnit !== kind) {
      questions.push(`имя похоже на «${kind}», а единица «${unit}» — на «${byUnit}»`);
      confidence = 0.4;
    } else if (byUnit) confidence = 0.95;
  }
  if (kind && !unit) {
    const finite = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b);
    const med = finite.length ? finite[Math.floor(finite.length / 2)]! : NaN;
    const g = unitFromMagnitude(kind, med);
    unit = g.unit;
    if (g.ambiguous) {
      questions.push(`единица не указана: ${g.ambiguous}`);
      confidence = Math.min(confidence, 0.5);
    }
  }
  if (!kind) questions.push('не удалось понять, что это за величина');
  const x = positionFromName(name);
  if (kind && x === undefined) questions.push('положение датчика не найдено в имени');
  return { name, kind, unit, x, confidence, questions };
}
