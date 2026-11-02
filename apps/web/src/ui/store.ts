/**
 * Скользящее окно временных рядов для графиков: время + именованные ряды.
 * Хранит не больше capacity точек; отдаёт массивы для uPlot.
 */
export class SeriesStore {
  t: number[] = [];
  series = new Map<string, Array<number | null>>();

  constructor(private readonly capacity = 6000) {}

  push(t: number, values: Record<string, number | null | undefined>): void {
    this.t.push(t);
    const n = this.t.length;
    for (const [k, v] of Object.entries(values)) {
      let s = this.series.get(k);
      if (!s) {
        s = new Array(n - 1).fill(null);
        this.series.set(k, s);
      }
      s.push(v ?? null);
    }
    for (const s of this.series.values()) if (s.length < n) s.push(null);
    if (n > this.capacity) {
      const cut = n - this.capacity;
      this.t.splice(0, cut);
      for (const s of this.series.values()) s.splice(0, cut);
    }
  }

  /** Данные для uPlot за последние windowSec секунд. */
  window(keys: string[], windowSec: number): [number[], ...Array<Array<number | null>>] {
    const tEnd = this.t.at(-1) ?? 0;
    let i0 = 0;
    while (i0 < this.t.length && this.t[i0]! < tEnd - windowSec) i0++;
    return [this.t.slice(i0), ...keys.map((k) => (this.series.get(k) ?? []).slice(i0))];
  }

  clear(): void {
    this.t = [];
    this.series.clear();
  }
}
