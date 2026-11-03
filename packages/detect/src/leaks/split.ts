/**
 * Одна утечка или две одновременные — по установившемуся отклику (H-B15).
 *
 * Вклад события y (СИ, давления и расходы) сравниваем с откликами модели h_x на утечку в месте x
 * (LsqLocator.shapes, в долях шума): одна утечка y ≈ q·h_x, две — y ≈ q1·h_x1 + q2·h_x2 (оба q > 0).
 * Если пара объясняет отклик заметно лучше, событие делится на две утечки. Вклад второй — остаток,
 * чтобы сумма вкладов точно совпала с откликом события (иначе после снятия обеих осталась бы невязка).
 */

/** Две утечки — не ближе SPLIT_MIN_SEP, м (ближе модель их не различает). */
export const SPLIT_MIN_SEP = 4000;
/**
 * Пару принимаем, если она уменьшает ошибку больше SPLIT_GAIN (в долях шума²), её ошибка меньше
 * SPLIT_RATIO от ошибки одной и меньшая утечка пары — не меньше SPLIT_MIN_SHARE суммы.
 */
const SPLIT_GAIN = 1;
const SPLIT_RATIO = 0.3;
const SPLIT_MIN_SHARE = 0.15;
/** Интервал каждой утечки пары — места, где ошибка не больше минимума + SPLIT_ZONE_FRAC выигрыша. */
const SPLIT_ZONE_FRAC = 0.2;

/** Отклики модели: xs — места, м; h[j] — отклик на утечку в xs[j] по каналам (в долях шума). */
export interface Shapes {
  xs: number[];
  h: number[][];
}

export interface OneOrTwo {
  one: { j: number; q: number; cost: number };
  two: { i: number; j: number; qi: number; qj: number; cost: number } | null;
  /** |y|² — полный отклик события в долях шума. */
  yy: number;
  xs: number[];
  /** Ошибка пары при сдвиге первой (второй) утечки по сетке — для интервалов. */
  costI: number[];
  costJ: number[];
}

const dot = (a: number[], b: number[]) => a.reduce((acc, v, k) => acc + v * b[k]!, 0);

/** Отклик события в долях шума по каналам ids. */
function scaled(y: Record<string, number>, ids: string[], sigma: (id: string) => number | undefined): number[] {
  return ids.map((id) => y[id]! / (sigma(id) ?? 1));
}

/**
 * Лучшие одиночная и парная подгонки y по откликам sh (ошибки — в долях шума², q — м³/с).
 * ids — каналы y в порядке sh.h; L — длина трубы, м.
 */
export function fitOneOrTwo(y: Record<string, number>, ids: string[], sh: Shapes, sigma: (id: string) => number | undefined, L: number): OneOrTwo {
  const yv = scaled(y, ids, sigma);
  const yy = dot(yv, yv);
  const H = sh.h;
  const n = H.length;
  const hh = H.map((h) => dot(h, h));
  const hy = H.map((h) => dot(h, yv));
  let one = { j: 0, q: 0, cost: Infinity };
  for (let j = 0; j < n; j++) {
    const q = hh[j]! > 0 ? Math.max(0, hy[j]! / hh[j]!) : 0;
    const cost = yy - 2 * q * hy[j]! + q * q * hh[j]!;
    if (cost < one.cost) one = { j, q, cost };
  }
  const minSep = Math.max(2, Math.round((SPLIT_MIN_SEP * n) / L));
  let two: OneOrTwo['two'] = null;
  const pairCost = (i: number, j: number) => {
    const a = hh[i]!;
    const b = dot(H[i]!, H[j]!);
    const c = hh[j]!;
    const det = a * c - b * b;
    if (!(det > 1e-12)) return null;
    const qi = (c * hy[i]! - b * hy[j]!) / det;
    const qj = (a * hy[j]! - b * hy[i]!) / det;
    if (qi <= 0 || qj <= 0) return null;
    return { qi, qj, cost: yy - 2 * (qi * hy[i]! + qj * hy[j]!) + qi * qi * a + 2 * qi * qj * b + qj * qj * c };
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + minSep; j < n; j++) {
      const r = pairCost(i, j);
      if (r && (!two || r.cost < two.cost)) two = { i, j, ...r };
    }
  }
  const costI: number[] = [];
  const costJ: number[] = [];
  if (two) {
    for (let k = 0; k < n; k++) {
      costI.push(Math.abs(k - two.j) >= minSep ? pairCost(k, two.j)?.cost ?? Infinity : Infinity);
      costJ.push(Math.abs(k - two.i) >= minSep ? pairCost(two.i, k)?.cost ?? Infinity : Infinity);
    }
  }
  return { one, two, yy, xs: sh.xs, costI, costJ };
}

/** Утечка пары: место, интервал, м; расход, м³/с; номер отклика в сетке. */
export interface SplitPart {
  x: number;
  interval: [number, number];
  q: number;
  j: number;
}

/** Пара заметно лучше одной — две утечки с интервалами по кривым ошибки; иначе null. */
export function acceptPair(fit: OneOrTwo, L: number): [SplitPart, SplitPart] | null {
  const two = fit.two;
  if (!two) return null;
  const gain = fit.one.cost - two.cost;
  if (!(gain > SPLIT_GAIN && two.cost < SPLIT_RATIO * fit.one.cost && Math.min(two.qi, two.qj) >= SPLIT_MIN_SHARE * (two.qi + two.qj))) return null;
  const half = L / fit.xs.length / 2;
  const zone = (curve: number[], at: number): [number, number] => {
    const lim = two.cost + SPLIT_ZONE_FRAC * gain;
    let lo = at;
    let hi = at;
    while (lo > 0 && curve[lo - 1]! <= lim) lo--;
    while (hi < curve.length - 1 && curve[hi + 1]! <= lim) hi++;
    return [Math.max(0, fit.xs[lo]! - half), Math.min(L, fit.xs[hi]! + half)];
  };
  return [
    { x: fit.xs[two.i]!, interval: zone(fit.costI, two.i), q: two.qi, j: two.i },
    { x: fit.xs[two.j]!, interval: zone(fit.costJ, two.j), q: two.qj, j: two.j },
  ];
}

/**
 * Расходы двух утечек в заданных местах (места уже известны — по приходу волны): подбор пары по откликам.
 * Если подбор отдал одной утечке отрицательный расход — делим поровну по откликам (обе волны видны).
 * Возвращает номера откликов и расходы; null — места совпали на сетке или отклики вырождены.
 */
export function ratesAt(
  y: Record<string, number>,
  ids: string[],
  sh: Shapes,
  sigma: (id: string) => number | undefined,
  xs: [number, number],
): { i: number; j: number; qi: number; qj: number } | null {
  const near = (x: number) => sh.xs.reduce((b, v, k) => (Math.abs(v - x) < Math.abs(sh.xs[b]! - x) ? k : b), 0);
  const [i, j] = [near(xs[0]), near(xs[1])];
  if (i === j) return null;
  const yv = scaled(y, ids, sigma);
  const hi = sh.h[i]!;
  const hj = sh.h[j]!;
  const A = dot(hi, hi);
  const B = dot(hi, hj);
  const C = dot(hj, hj);
  const det = A * C - B * B;
  if (!(det > 1e-12)) return null;
  let qi = (C * dot(hi, yv) - B * dot(hj, yv)) / det;
  let qj = (A * dot(hj, yv) - B * dot(hi, yv)) / det;
  if (!(qi > 0 && qj > 0)) {
    const q = Math.max(0, dot(hi, yv) + dot(hj, yv)) / Math.max(1e-12, A + 2 * B + C);
    qi = q;
    qj = q;
  }
  return { i, j, qi, qj };
}

/** Вклады пары: первой — q·отклик (СИ), второй — остаток, чтобы сумма точно равнялась delta. */
export function splitDelta(
  delta: Record<string, number>,
  ids: string[],
  h: number[],
  q: number,
  sigma: (id: string) => number | undefined,
): [Record<string, number>, Record<string, number>] {
  const di: Record<string, number> = {};
  const dj: Record<string, number> = {};
  ids.forEach((id, k) => {
    di[id] = q * h[k]! * (sigma(id) ?? 0);
    dj[id] = delta[id]! - di[id]!;
  });
  return [di, dj];
}
