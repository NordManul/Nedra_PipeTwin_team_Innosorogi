/** Проверка требований детектора к датчикам (ТЗ, раздел 8, правило 4): выбывает с причиной, а не падает. */
import type { DetectorContext, DetectorRequirements, RequirementCheck, SensorKind } from '@pipetwin/core/contracts';

const KIND_NAMES: Record<SensorKind, string> = { p: 'давления', q: 'расхода', T: 'температуры' };

export function checkRequirements(req: DetectorRequirements, ctx: DetectorContext): RequirementCheck {
  const reasons: string[] = [];
  const L = ctx.config.geometry.length;
  const tol = Math.max(ctx.config.numerics.dx / 2, 1e-6);
  for (const r of req.sensors) {
    const ofKind = ctx.sensors.filter((s) => s.kind === r.kind);
    const atIn = ofKind.filter((s) => Math.abs(s.x) <= tol).length;
    const atOut = ofKind.filter((s) => Math.abs(s.x - L) <= tol).length;
    const name = KIND_NAMES[r.kind];
    switch (r.at ?? 'any') {
      case 'inlet':
        if (!atIn) reasons.push(`нет датчика ${name} на входе`);
        break;
      case 'outlet':
        if (!atOut) reasons.push(`нет датчика ${name} на выходе`);
        break;
      case 'both-ends':
        if (!atIn) reasons.push(`нет датчика ${name} на входе`);
        if (!atOut) reasons.push(`нет датчика ${name} на выходе`);
        break;
      default:
        break;
    }
    const min = r.min ?? 1;
    if (ofKind.length < min) reasons.push(`нужно датчиков ${name}: не меньше ${min}, есть ${ofKind.length}`);
  }
  if (req.minSensorsTotal && ctx.sensors.length < req.minSensorsTotal) {
    reasons.push(`нужно датчиков всего: не меньше ${req.minSensorsTotal}, есть ${ctx.sensors.length}`);
  }
  if (req.minSampleRateHz && ctx.sampleRateHz < req.minSampleRateHz) {
    reasons.push(`нужна частота опроса от ${req.minSampleRateHz} Гц, есть ${ctx.sampleRateHz} Гц`);
  }
  if (req.needsTwin && !ctx.twin) reasons.push('нужен twin (модель трубы)');
  return { ok: reasons.length === 0, reasons };
}

/** Объединение требований (для слияния D7). */
export function mergeRequirements(list: DetectorRequirements[]): DetectorRequirements {
  return {
    sensors: list.flatMap((r) => r.sensors),
    minSensorsTotal: Math.max(0, ...list.map((r) => r.minSensorsTotal ?? 0)) || undefined,
    minSampleRateHz: Math.max(0, ...list.map((r) => r.minSampleRateHz ?? 0)) || undefined,
    needsTwin: list.some((r) => r.needsTwin),
  };
}
