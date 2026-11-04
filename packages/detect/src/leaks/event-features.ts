/**
 * Признаки события «утечка или отказ датчика» в момент перед подтверждением утечки (H-B19).
 *
 * Утечку у конца трубы почти один видит расходомер на этом конце, а отказ датчика на конце трубы
 * (скачок, дрейф) двойник принимает за смену режима или утечку. Различают их слабые, но устойчивые
 * следы: у утечки остальные каналы тоже немного отходят в её сторону, приходит волна давления,
 * отклик объясняется утечкой в одном месте; у отказа — меняется один датчик, а замеры расходов
 * не меняются, если сломался датчик давления на входе модели.
 *
 * Все признаки безразмерные и не зависят от числа и расстановки датчиков.
 */

export interface EventFeatureInput {
  /** Средние невязки за окно в долях σ по каналам давления и расхода (не граничным для двойника). */
  zMean: Record<string, number>;
  /** Знак отклика канала на утечку (+1 — отходит так же, как при утечке). */
  signs: Record<string, number>;
  /** Изменение сырых замеров с начала события, в долях шума, — граничные датчики двойника. */
  boundaryDelta: number[];
  /** Изменение замеров расходов на входе и выходе с начала события, в долях шума. */
  flowDelta: { qIn?: number; qOut?: number };
  /** Сколько датчиков давления увидели приход волны и сколько их всего. */
  arrivals: number;
  pressures: number;
  /** Доля отклика, которую объясняет одна утечка (1 − ошибка/|y|²), или undefined. */
  fitExplained: number | undefined;
}

/** Порядок признаков модели. */
export const EVENT_FEATURES = ['dominance', 'othersAgree', 'leakSum', 'boundaryJump', 'flowMoved', 'flowOpposite', 'waves', 'fitExplained'] as const;
export type EventFeatureName = (typeof EVENT_FEATURES)[number];

export function eventFeatures(inp: EventFeatureInput): Record<EventFeatureName, number> {
  const ids = Object.keys(inp.zMean);
  const abs = ids.map((id) => Math.abs(inp.zMean[id]!));
  const sumAbs = abs.reduce((a, b) => a + b, 0);
  const top = ids[abs.indexOf(Math.max(...abs))];
  const e = (id: string) => (inp.signs[id] ?? 0) * inp.zMean[id]!;
  const others = ids.filter((id) => id !== top);
  const qi = inp.flowDelta.qIn ?? 0;
  const qo = inp.flowDelta.qOut ?? 0;
  return {
    // один канал против всех — признак отказа
    dominance: sumAbs > 0 ? Math.max(...abs) / sumAbs : 0,
    // остальные каналы отходят в сторону утечки (в долях σ среднего за окно)
    othersAgree: others.length ? others.reduce((a, id) => a + e(id), 0) / others.length : 0,
    leakSum: ids.reduce((a, id) => a + e(id), 0) / Math.sqrt(Math.max(1, ids.length)),
    // скачок на датчике, который двойник берёт как граничное условие
    boundaryJump: Math.log1p(Math.max(0, ...inp.boundaryDelta.map(Math.abs))),
    // замеры расходов изменились (при отказе датчика давления на входе модели — нет)
    flowMoved: Math.log1p(Math.abs(qi) + Math.abs(qo)),
    // вход растёт, выход падает — как при утечке
    flowOpposite: Math.tanh((qi - qo) / 10),
    waves: inp.pressures ? inp.arrivals / inp.pressures : 0,
    fitExplained: inp.fitExplained ?? 0,
  };
}

/** Узел дерева решений: вопрос «признак ≤ порог?» или лист с вероятностью утечки. */
export type EventTreeNode = { p: number; n: number } | { feature: EventFeatureName; threshold: number; le: EventTreeNode; gt: EventTreeNode };

/**
 * Дерево решений «утечка или отказ датчика». Обучается скриптом scripts/train-event-classifier.ts
 * на прогонах симулятора; потерянная утечка в обучении стоит в costLeak раз дороже пропущенного отказа.
 */
export interface EventClassifierModel {
  kind: 'tree';
  version: 1;
  features: EventFeatureName[];
  root: EventTreeNode;
  /** Ниже этой вероятности утечки событие считается отказом датчика. */
  threshold: number;
  costLeak: number;
  trainedOn?: string;
}

export function leakProbability(m: EventClassifierModel, f: Record<EventFeatureName, number>): number {
  let n = m.root;
  while ('feature' in n) n = f[n.feature] <= n.threshold ? n.le : n.gt;
  return n.p;
}
