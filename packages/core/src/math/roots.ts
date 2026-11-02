/** Поиск корня методом Брента на отрезке [a, b], где f(a) и f(b) разных знаков. */
export function brent(
  f: (x: number) => number,
  a: number,
  b: number,
  opts: { tol?: number; maxIter?: number } = {},
): number {
  const tol = opts.tol ?? 1e-12;
  const maxIter = opts.maxIter ?? 100;
  let fa = f(a);
  let fb = f(b);
  if (fa === 0) return a;
  if (fb === 0) return b;
  if (fa * fb > 0) throw new RangeError(`brent: корень не отделён на [${a}, ${b}]`);
  let c = a;
  let fc = fa;
  let d = b - a;
  let e = d;
  for (let i = 0; i < maxIter; i++) {
    if (fb * fc > 0) {
      c = a;
      fc = fa;
      d = e = b - a;
    }
    if (Math.abs(fc) < Math.abs(fb)) {
      a = b;
      b = c;
      c = a;
      fa = fb;
      fb = fc;
      fc = fa;
    }
    const tol1 = 2 * Number.EPSILON * Math.abs(b) + 0.5 * tol;
    const xm = 0.5 * (c - b);
    if (Math.abs(xm) <= tol1 || fb === 0) return b;
    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      const s = fb / fa;
      let p: number;
      let q: number;
      if (a === c) {
        p = 2 * xm * s;
        q = 1 - s;
      } else {
        const qq = fa / fc;
        const r = fb / fc;
        p = s * (2 * xm * qq * (qq - r) - (b - a) * (r - 1));
        q = (qq - 1) * (r - 1) * (s - 1);
      }
      if (p > 0) q = -q;
      p = Math.abs(p);
      if (2 * p < Math.min(3 * xm * q - Math.abs(tol1 * q), Math.abs(e * q))) {
        e = d;
        d = p / q;
      } else {
        d = xm;
        e = d;
      }
    } else {
      d = xm;
      e = d;
    }
    a = b;
    fa = fb;
    b += Math.abs(d) > tol1 ? d : xm > 0 ? tol1 : -tol1;
    fb = f(b);
  }
  return b;
}

/**
 * Отделить корень монотонной функции, расширяя отрезок от начального приближения,
 * и уточнить методом Брента.
 */
export function findRoot(
  f: (x: number) => number,
  x0: number,
  step: number,
  opts: { tol?: number; maxExpand?: number } = {},
): number {
  let a = x0 - step;
  let b = x0 + step;
  let fa = f(a);
  let fb = f(b);
  const maxExpand = opts.maxExpand ?? 60;
  for (let i = 0; i < maxExpand && fa * fb > 0; i++) {
    if (Math.abs(fa) < Math.abs(fb)) {
      a -= (b - a) * 1.6;
      fa = f(a);
    } else {
      b += (b - a) * 1.6;
      fb = f(b);
    }
  }
  if (fa * fb > 0) throw new RangeError('findRoot: не удалось отделить корень');
  return brent(f, a, b, { tol: opts.tol });
}
