/** Небольшая плотная линейная алгебра для калибровки и детекторов (матрицы до ~50×50). */

export type Matrix = number[][];

export function zeros(n: number, m: number): Matrix {
  return Array.from({ length: n }, () => new Array<number>(m).fill(0));
}

export function identity(n: number): Matrix {
  const a = zeros(n, n);
  for (let i = 0; i < n; i++) a[i]![i] = 1;
  return a;
}

/** Решение A·x = b методом Гаусса с выбором главного элемента. Возвращает null для вырожденной A. */
export function solve(A: Matrix, b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    const pivVal = M[piv]![col]!;
    if (Math.abs(pivVal) < 1e-300) return null;
    if (piv !== col) [M[piv], M[col]] = [M[col]!, M[piv]!];
    const rowC = M[col]!;
    for (let r = col + 1; r < n; r++) {
      const row = M[r]!;
      const f = row[col]! / pivVal;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) row[c]! -= f * rowC[c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    const row = M[r]!;
    let s = row[n]!;
    for (let c = r + 1; c < n; c++) s -= row[c]! * x[c]!;
    x[r] = s / row[r]!;
  }
  return x;
}

/** Обратная матрица (через solve по столбцам). */
export function inverse(A: Matrix): Matrix | null {
  const n = A.length;
  const inv = zeros(n, n);
  for (let j = 0; j < n; j++) {
    const e = new Array<number>(n).fill(0);
    e[j] = 1;
    const col = solve(A, e);
    if (!col) return null;
    for (let i = 0; i < n; i++) inv[i]![j] = col[i]!;
  }
  return inv;
}

/** Собственные значения и векторы симметричной матрицы (метод Якоби). Значения по убыванию. */
export function symEig(A: Matrix): { values: number[]; vectors: Matrix } {
  const n = A.length;
  const a = A.map((r) => [...r]);
  const v = identity(n);
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p]![q]! ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p]![q]!;
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k]![p]!;
          const akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p]![k]!;
          const aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k]![p]!;
          const vkq = v[k]![q]!;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[j]![j]! - a[i]![i]!);
  return {
    values: order.map((i) => a[i]![i]!),
    vectors: order.map((i) => v.map((row) => row[i]!)),
  };
}

/** Aᵀ·A для матрицы n×m (строки — наблюдения). */
export function gram(J: Matrix): Matrix {
  const m = J[0]?.length ?? 0;
  const G = zeros(m, m);
  for (const row of J) {
    for (let i = 0; i < m; i++) {
      const ri = row[i]!;
      if (ri === 0) continue;
      for (let j = i; j < m; j++) G[i]![j]! += ri * row[j]!;
    }
  }
  for (let i = 0; i < m; i++) for (let j = 0; j < i; j++) G[i]![j] = G[j]![i]!;
  return G;
}
