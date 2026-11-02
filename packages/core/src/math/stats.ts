/** Простые статистики без зависимостей. */

export function mean(xs: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return xs.length ? s / xs.length : NaN;
}

export function variance(xs: ArrayLike<number>): number {
  const m = mean(xs);
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += (xs[i]! - m) ** 2;
  return xs.length > 1 ? s / (xs.length - 1) : 0;
}

export function std(xs: ArrayLike<number>): number {
  return Math.sqrt(variance(xs));
}

export function quantile(xs: ArrayLike<number>, q: number): number {
  if (!xs.length) return NaN;
  const a = Array.from(xs).sort((x, y) => x - y);
  const pos = (a.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return a[lo]! + (a[hi]! - a[lo]!) * (pos - lo);
}

export function median(xs: ArrayLike<number>): number {
  return quantile(xs, 0.5);
}

/** Масштабированное медианное абсолютное отклонение: оценка σ, устойчивая к выбросам. */
export function madSigma(xs: ArrayLike<number>): number {
  const m = median(xs);
  const dev = Array.from(xs, (x) => Math.abs(x - m));
  return 1.4826 * median(dev);
}

/** Линейная интерполяция по возрастающей сетке xs. За пределами — крайние значения. */
export function interp(x: number, xs: ArrayLike<number>, ys: ArrayLike<number>): number {
  const n = xs.length;
  if (n === 0) return NaN;
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const t = (x - xs[lo]!) / (xs[hi]! - xs[lo]!);
  return ys[lo]! + t * (ys[hi]! - ys[lo]!);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
