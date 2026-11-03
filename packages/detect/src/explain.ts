/**
 * Объяснение тревоги и рекомендация (WP-B10): карточка события для интерфейса.
 * Правила рекомендаций — из configs/actions.json (первое подходящее), код их не знает.
 */
import type { ActionRule, DetectorOutput, EventCard, EventClass } from '@pipetwin/core/contracts';

/** Горизонт прогноза потерь при бездействии, с. */
export const FORECAST_SEC = 1800;

export interface ExplainOptions {
  rules: ActionRule[];
  /** Номинальный расход на входе, м³/с — для доли утечки. */
  nominalFlow?: number;
  detector: string;
  id?: string;
  /** Подпись датчика для текста рекомендации. */
  sensorLabel?: (id: string) => string;
}

/**
 * Уверенность 0..1 по запасу над порогом и согласованности сигнала.
 * Калибруется по стенду: доля настоящих утечек среди тревог с таким запасом.
 */
export function confidenceOf(out: DetectorOutput, cls: EventClass): number {
  // отказ датчика и смена режима подтверждаются своими правилами (монитор отказов, скачок на конце трубы)
  if (cls === 'sensor-fault' || cls === 'pump-change' || cls === 'valve-change') return 0.8;
  const ratio = out.threshold && out.threshold > 0 ? out.score / out.threshold : 1;
  let c = 0.5 + 0.45 * Math.tanh(1.2 * (ratio - 0.8));
  const strong = (out.contributions ?? []).filter((x) => x.share > 0.15).length;
  if (cls === 'leak' && strong >= 2) c += 0.1;
  if (cls === 'unknown') c -= 0.15;
  return Math.min(0.99, Math.max(0.05, c));
}

export function matchRule(rules: ActionRule[], cls: EventClass, fraction: number | undefined, confidence: number): ActionRule | undefined {
  return rules.find((r) => {
    const w = r.when;
    if (w.eventClass !== undefined) {
      const list = Array.isArray(w.eventClass) ? w.eventClass : [w.eventClass];
      if (!list.includes(cls)) return false;
    }
    // размер ещё не оценён — правила с условием на размер не применяются
    if ((w.leakFractionMin !== undefined || w.leakFractionMax !== undefined) && fraction === undefined) return false;
    if (w.leakFractionMin !== undefined && !(fraction! >= w.leakFractionMin)) return false;
    if (w.leakFractionMax !== undefined && !(fraction! < w.leakFractionMax)) return false;
    if (w.confidenceMin !== undefined && !(confidence >= w.confidenceMin)) return false;
    if (w.confidenceMax !== undefined && !(confidence < w.confidenceMax)) return false;
    return true;
  });
}

export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

/** Число для текста рекомендации: десятичная запятая, «?» — если значения нет. */
const fmt = (v: number | undefined, digits: number) => (v === undefined || !Number.isFinite(v) ? '?' : v.toFixed(digits).replace('.', ','));

export function buildEventCard(out: DetectorOutput, opts: ExplainOptions): EventCard {
  const cls: EventClass = out.eventClass ?? (out.alarm ? 'leak' : 'unknown');
  const confidence = confidenceOf(out, cls);
  const rate = out.leakRate;
  const fraction = rate !== undefined && opts.nominalFlow ? rate / opts.nominalFlow : undefined;
  const onset = out.onsetTime ?? out.t;
  const vLoss = rate !== undefined ? rate * Math.max(0, out.t - onset) : undefined;
  // для отказа датчика «вклад» — сам неисправный датчик
  const faulty = cls === 'sensor-fault' ? out.unhealthySensors?.at(-1) : undefined;
  const contributions = faulty ? [{ sensorId: faulty, share: 1 }] : out.contributions ?? [];
  const top = contributions[0]?.sensorId;
  const rule = matchRule(opts.rules, cls, fraction, confidence);
  const errKm = out.locationInterval ? (out.locationInterval[1] - out.locationInterval[0]) / 2000 : undefined;
  const text = rule
    ? renderTemplate(rule.text, {
        place: out.locationInterval
          ? `на участке км ${fmt(out.locationInterval[0] / 1000, 1)}–${fmt(out.locationInterval[1] / 1000, 1)}`
          : out.location !== undefined
            ? `у км ${fmt(out.location / 1000, 1)}`
            : 'место уточняется',
        x_lo_km: fmt(out.locationInterval ? out.locationInterval[0] / 1000 : undefined, 1),
        x_hi_km: fmt(out.locationInterval ? out.locationInterval[1] / 1000 : undefined, 1),
        x_km: fmt(out.location !== undefined ? out.location / 1000 : undefined, 1),
        x_err_km: fmt(errKm, 1),
        rate_m3h: fmt(rate !== undefined ? rate * 3600 : undefined, 1),
        frac_pct: fmt(fraction !== undefined ? fraction * 100 : undefined, 1),
        sensor: top ? opts.sensorLabel?.(top) ?? top : '?',
        confidence_pct: fmt(confidence * 100, 0),
      })
    : 'Нет подходящего правила в actions.json.';
  const card: EventCard = {
    id: opts.id ?? `ev-${out.t.toFixed(1)}`,
    tAlarm: out.t,
    eventClass: cls,
    confidence,
    detector: opts.detector,
    contributions,
    action: { ruleId: rule?.id ?? 'none', severity: rule?.severity ?? 'warning', text },
  };
  if (out.location !== undefined) {
    card.location = { x: out.location, ...(out.locationInterval ? { interval: out.locationInterval } : {}), ...(out.locationStage ? { stage: out.locationStage } : {}) };
  }
  if (rate !== undefined) card.leakRate = rate;
  if (fraction !== undefined) card.leakFraction = fraction;
  if (vLoss !== undefined) {
    card.vLoss = vLoss;
    card.vLossForecast30min = vLoss + (rate ?? 0) * FORECAST_SEC;
  }
  return card;
}
