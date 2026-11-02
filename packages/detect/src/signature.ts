/**
 * Классификатор событий по сигнатуре (WP-B3). Основной признак — какой датчик давления изменился
 * ПЕРВЫМ (волна идёт от источника): вход — насос, выход — задвижка, середина — утечка.
 * Знаки изменений расходов уточняют класс:
 *
 * | Событие                      | Q_вх    | Q_вых   | Давления                         |
 * | Утечка                       | растёт  | падает  | падают, первым — ближайший датчик |
 * | Рост напора насоса           | растёт  | растёт  | растут, первым — вход             |
 * | Прикрытие задвижки на выходе | падает  | падает  | растут, первым — выход            |
 * | Отказ датчика                | —       | —       | меняется только один датчик       |
 */
import type { EventClass, SensorSpec } from '@pipetwin/core/contracts';

export interface FirstChange {
  /** Момент первого значимого изменения, с. */
  t: number;
  /** Знак изменения: +1 рост, −1 спад. */
  sign: number;
}

export interface SignatureInput {
  sensors: SensorSpec[];
  length: number;
  /** Изменение замера «сейчас − до события» в долях шума изменения. */
  delta: Record<string, number>;
  /** Первое значимое изменение по датчикам (если было). */
  first: Record<string, FirstChange>;
  /** Каналы, отклонившиеся от модели. */
  activeChannels: string[];
  /** Допуск одновременности, с. */
  tolSec?: number;
}

export interface Signature {
  cls: EventClass;
  confidence: number;
  reason: string;
}

const SIG = 3;

export function classifyEvent(inp: SignatureInput): Signature {
  const { sensors, length: L, delta, first } = inp;
  const tol = inp.tolSec ?? 0.5;
  const at = (kind: SensorSpec['kind'], x: number) => sensors.find((s) => s.kind === kind && Math.abs(s.x - x) < 1e-6);
  const qIn = at('q', 0);
  const qOut = at('q', L);
  const ps = sensors.filter((s) => s.kind === 'p').sort((a, b) => a.x - b.x);

  // 1. Отказ датчика: от модели отклонился ровно один датчик, остальные давления не изменились.
  const sensorChannels = inp.activeChannels.filter((c) => sensors.some((s) => s.id === c));
  if (sensorChannels.length === 1 && ps.length >= 2) {
    const only = sensorChannels[0]!;
    const quiet = ps.filter((s) => s.id !== only).every((s) => Math.abs(delta[s.id] ?? 0) < SIG && !first[s.id]);
    if (quiet) return { cls: 'sensor-fault', confidence: 0.8, reason: `меняется только ${only}` };
  }

  const flowSign = (s?: SensorSpec) => (s ? first[s.id]?.sign ?? (Math.abs(delta[s.id] ?? 0) > SIG ? Math.sign(delta[s.id]!) : 0) : 0);
  const fqIn = flowSign(qIn);
  const fqOut = flowSign(qOut);

  // 2. Кто изменился первым среди датчиков давления.
  const changed = ps.filter((s) => first[s.id]).sort((a, b) => first[a.id]!.t - first[b.id]!.t);
  if (changed.length) {
    const lead = changed[0]!;
    const t0 = first[lead.id]!.t;
    const group = changed.filter((s) => first[s.id]!.t <= t0 + tol);
    const interiorLead = group.find((s) => s.x > 0 && s.x < L);
    const sign = first[lead.id]!.sign;
    if (interiorLead || (lead.x > 0 && lead.x < L)) {
      const s = interiorLead ?? lead;
      if (first[s.id]!.sign < 0) return { cls: 'leak', confidence: 0.85, reason: `давление упало сначала у ${s.id}` };
      return { cls: 'unknown', confidence: 0.4, reason: `давление выросло сначала у ${s.id}` };
    }
    if (lead.x === 0) {
      if (sign < 0 && fqIn > 0) return { cls: 'leak', confidence: 0.75, reason: 'у входа: давление упало, расход вырос' };
      return { cls: 'pump-change', confidence: 0.8, reason: `давление на входе ${sign > 0 ? 'выросло' : 'упало'} первым` };
    }
    if (lead.x === L) {
      if (sign < 0 && fqOut < 0) return { cls: 'leak', confidence: 0.75, reason: 'у выхода: давление и расход упали' };
      return { cls: 'valve-change', confidence: 0.8, reason: `давление на выходе ${sign > 0 ? 'выросло' : 'упало'} первым` };
    }
  }

  // 3. Давления заметно не менялись (малая утечка или расходный детектор): по знакам расходов.
  if (qIn && qOut) {
    if (fqIn > 0 && fqOut > 0) return { cls: 'pump-change', confidence: 0.6, reason: 'оба расхода выросли' };
    if (fqIn < 0 && fqOut < 0) return { cls: 'valve-change', confidence: 0.6, reason: 'оба расхода упали' };
    if (fqIn > 0 || fqOut < 0) return { cls: 'leak', confidence: 0.7, reason: 'расход на входе вырос / на выходе упал' };
  }
  return { cls: 'unknown', confidence: 0.4, reason: 'сигнатура не распознана' };
}
