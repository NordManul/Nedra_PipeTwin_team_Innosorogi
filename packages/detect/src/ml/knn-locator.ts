/**
 * ML-оценка места утечки: k ближайших соседей по «форме» отклика датчиков (WP-B4, H-B12).
 *
 * Обучающие примеры — прогоны симулятора с утечками в случайных местах, размерах и шуме
 * (scripts/train-ml-locator.ts). Признаки считаются только из того, что видит детектор:
 *  - форма отклонений невязок давления и расхода (вектор средних z за 2 с, нормированный на длину) —
 *    не зависит от размера утечки;
 *  - времена первого изменения на датчиках давления относительно самого раннего, в долях пробега волны;
 *  - время с начала тревоги, в долях пробега волны.
 * Ответ — медиана и квантили места у k ближайших примеров: интервал получается сам, из разброса соседей.
 *
 * Модель привязана к трубе и набору датчиков (sensorIds, length): для другой трубы её нужно переобучить.
 */

export interface KnnLocatorModel {
  kind: 'knn-locator';
  version: 1;
  /** Описание трубы, на которой обучена модель. */
  pipeline: { name: string; length: number; sensorIds: string[]; pressureIds: string[] };
  /** Веса групп признаков (подобраны на валидации). */
  weights: { shape: number; arrival: number; time: number };
  k: number;
  /** Квантили интервала (подобраны так, чтобы покрытие на валидации было ≈ coverage). */
  quantiles: [lo: number, hi: number];
  coverage: number;
  /** Признаки примеров, построчно; длина строки = sensorIds.length + pressureIds.length + 1. */
  X: number[][];
  /** Место утечки, доли длины. */
  y: number[];
}

export interface LocatorFeatures {
  /** Средние z за последние 2 с по датчикам (id → z). */
  z: Record<string, number>;
  /** Момент первого изменения датчиков давления, с (нет — датчик ещё не видел волну). */
  first: Record<string, number | undefined>;
  /** Время с начала тревоги, с. */
  sinceAlarm: number;
  /** Время пробега волны через трубу, с. */
  transit: number;
}

/** Вектор признаков в порядке модели. */
export function featureVector(m: Pick<KnnLocatorModel, 'pipeline'>, f: LocatorFeatures): number[] | null {
  const shape = m.pipeline.sensorIds.map((id) => f.z[id] ?? 0);
  const norm = Math.hypot(...shape);
  if (!(norm > 0)) return null;
  const times = m.pipeline.pressureIds.map((id) => f.first[id]);
  const known = times.filter((t): t is number => t !== undefined);
  const t0 = known.length ? Math.min(...known) : 0;
  // датчик ещё не видел волну — как будто пришла через полтора пробега
  const arrival = times.map((t) => (t === undefined ? 1.5 : Math.min(1.5, (t - t0) / f.transit)));
  return [...shape.map((v) => v / norm), ...arrival, Math.min(3, f.sinceAlarm / f.transit)];
}

export class KnnLocator {
  private readonly nShape: number;
  private readonly nArr: number;

  constructor(readonly model: KnnLocatorModel) {
    this.nShape = model.pipeline.sensorIds.length;
    this.nArr = model.pipeline.pressureIds.length;
  }

  /** Подходит ли модель к трубе (те же датчики и длина). */
  static fits(model: KnnLocatorModel, length: number, sensorIds: string[]): boolean {
    return Math.abs(model.pipeline.length - length) < 1 && model.pipeline.sensorIds.every((id) => sensorIds.includes(id));
  }

  private dist(a: number[], b: number[]): number {
    const w = this.model.weights;
    let s = 0;
    for (let i = 0; i < a.length; i++) {
      const d = a[i]! - b[i]!;
      const wi = i < this.nShape ? w.shape : i < this.nShape + this.nArr ? w.arrival : w.time;
      s += wi * d * d;
    }
    return s;
  }

  /** Места (доли длины) k ближайших примеров, от ближнего к дальнему. */
  neighbors(v: number[], k = this.model.k): number[] {
    const { X, y } = this.model;
    const best: Array<[number, number]> = [];
    for (let i = 0; i < X.length; i++) {
      const d = this.dist(v, X[i]!);
      if (best.length < k) {
        best.push([d, y[i]!]);
        if (best.length === k) best.sort((a, b) => a[0] - b[0]);
      } else if (d < best[k - 1]![0]) {
        let j = k - 1;
        while (j > 0 && best[j - 1]![0] > d) {
          best[j] = best[j - 1]!;
          j--;
        }
        best[j] = [d, y[i]!];
      }
    }
    if (best.length < k) best.sort((a, b) => a[0] - b[0]);
    return best.map((b) => b[1]);
  }

  /** Место (м) и интервал по квантилям соседей. */
  locate(f: LocatorFeatures): { x: number; interval: [number, number] } | null {
    const v = featureVector(this.model, f);
    if (!v) return null;
    const ys = this.neighbors(v);
    if (!ys.length) return null;
    const L = this.model.pipeline.length;
    const [lo, hi] = this.model.quantiles;
    return { x: quantile(ys, 0.5) * L, interval: [quantile(ys, lo) * L, quantile(ys, hi) * L] };
  }
}

/** Квантиль (линейная интерполяция); сортирует копию. */
export function quantile(values: number[], p: number): number {
  const ys = [...values].sort((a, b) => a - b);
  const pos = p * (ys.length - 1);
  const i = Math.floor(pos);
  return ys[i]! + (ys[Math.min(ys.length - 1, i + 1)]! - ys[i]!) * (pos - i);
}
