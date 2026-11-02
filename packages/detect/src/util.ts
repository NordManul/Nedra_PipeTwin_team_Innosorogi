/** Мелкие структуры данных для потоковой обработки. */

/** Кольцевой буфер фиксированной длины со скользящей суммой. */
export class RollingWindow {
  private readonly buf: Float64Array;
  private head = 0;
  private count = 0;
  private sum = 0;

  constructor(readonly size: number) {
    this.buf = new Float64Array(Math.max(1, size));
  }

  push(v: number): void {
    if (this.count === this.buf.length) this.sum -= this.buf[this.head]!;
    else this.count++;
    this.buf[this.head] = v;
    this.sum += v;
    this.head = (this.head + 1) % this.buf.length;
  }

  get length(): number {
    return this.count;
  }

  get full(): boolean {
    return this.count === this.buf.length;
  }

  mean(): number {
    return this.count ? this.sum / this.count : 0;
  }

  /** Среднее последних n значений (n ≤ length). */
  meanLast(n: number): number {
    const k = Math.min(n, this.count);
    let s = 0;
    for (let i = 1; i <= k; i++) s += this.buf[(this.head - i + this.buf.length) % this.buf.length]!;
    return k ? s / k : 0;
  }

  /** Среднее значений с номерами [from, to) от конца (0 — последнее). */
  meanRange(from: number, to: number): number {
    let s = 0;
    let k = 0;
    for (let i = from; i < Math.min(to, this.count); i++) {
      s += this.buf[(this.head - 1 - i + 2 * this.buf.length) % this.buf.length]!;
      k++;
    }
    return k ? s / k : 0;
  }

  /** Значение i шагов назад (0 — последнее). */
  back(i: number): number {
    return this.buf[(this.head - 1 - i + 2 * this.buf.length) % this.buf.length]!;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.sum = 0;
  }
}

/** Коэффициент экспоненциального сглаживания для постоянной времени tau при шаге dt. */
export function ewmaAlpha(dt: number, tau: number): number {
  return tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
}
