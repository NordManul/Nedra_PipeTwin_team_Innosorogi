/**
 * Детерминированный генератор псевдослучайных чисел (mulberry32) и нормальное
 * распределение (Бокс–Мюллер). Один seed — побитово одинаковые последовательности (T-A14).
 */
export class Rng {
  private state: number;
  private spare: number | null = null;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** Равномерное на [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Равномерное на [a, b). */
  uniform(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** Целое на [a, b]. */
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }

  /** Стандартное нормальное N(0, 1). */
  gauss(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    let u = 0;
    while (u <= Number.MIN_VALUE) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  /** Независимый поток для подсистемы: детерминированно выводится из текущего seed. */
  fork(salt: number): Rng {
    return new Rng((Math.imul(this.state ^ salt, 0x85ebca6b) ^ (salt * 0x27d4eb2f)) >>> 0);
  }
}
