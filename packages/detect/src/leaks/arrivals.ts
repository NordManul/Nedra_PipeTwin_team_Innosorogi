/**
 * Приход волны давления на датчики и сколько источников (утечек) его объясняют (H-B15).
 *
 * Приход — первое устойчивое падение давления на датчике после начала события. Ранние приходы видны
 * в истории в момент тревоги (pipeline.firstChanges), поздние — на дальних датчиках — ловит ArrivalTracker
 * по уровню «до события», запомненному в момент тревоги.
 *
 * Один источник: t_i = t0 + |x_i − x|/a; два одновременных: t_i = t0 + min(|x_i − x1|, |x_i − x2|)/a.
 * Если один не объясняет приходы, а пара — объясняет, утечек две (одновременные).
 */
import type { SensorSpec } from '@pipetwin/core/contracts';
import type { RollingWindow } from '../util';

/** Приход засчитываем, если спад держится столько секунд (шумовой выброс — нет). */
export const ARRIVAL_SUSTAIN_SEC = 2;
/**
 * Две волны: RMS одного источника больше ARR_SINGLE_TOL (с), пары — меньше ARR_PAIR_TOL и вдвое лучше одного.
 * Ложный «приход» у насоса пара не объясняет — одиночная утечка не делится.
 */
export const ARR_SINGLE_TOL = 0.8;
export const ARR_PAIR_TOL = 1.5;
/**
 * Зона каждой утечки пары — места, где RMS пары не больше минимума + ARR_ZONE_TOL (с). 2 с — с запасом на
 * то, что утечки начинаются не строго одновременно (стенд нескольких утечек: обе зоны верны в 98% пар).
 */
export const ARR_ZONE_TOL = 2;
/** Шаг сетки мест, м. */
const GRID_STEP = 250;

export interface ArrivalSources {
  /** RMS лучшего одного источника, с. */
  rms1: number;
  /** Лучшая пара мест, м, её RMS, с, и зоны каждой утечки, м. */
  x1: number;
  x2: number;
  rms2: number;
  zone1: [number, number];
  zone2: [number, number];
}

/**
 * Один или два источника по временам прихода pts (x — место датчика, м; t — момент, с).
 * Нужно 4+ датчика: у пары три параметра (два места и момент начала).
 */
export function arrivalSources(pts: Array<{ x: number; t: number }>, L: number, waveSpeed: number, minSepM: number): ArrivalSources | null {
  if (pts.length < 4) return null;
  const a = waveSpeed;
  const step = GRID_STEP;
  const grid: number[] = [];
  for (let x = 0; x <= L + 1e-9; x += step) grid.push(x);
  // ложный «приход» бывает только на концах трубы (у насоса и задвижки) — отбросить разрешено лишь такой датчик
  // и только при 5+ приходах: иначе при неизвестном моменте начала одна утечка «объясняет» три датчика из четырёх
  const atEnd = pts.map((p) => p.x <= 1 || p.x >= L - 1);
  const rmsOf = (dist: (xi: number) => number, drop: boolean) => {
    const d = pts.map((p) => p.t - dist(p.x) / a);
    const fit = (keep: boolean[]) => {
      const v = d.filter((_, k) => keep[k]);
      const sorted = [...v].sort((u, w) => u - w);
      const t0 = sorted[Math.floor(sorted.length / 2)]!;
      return Math.sqrt(v.reduce((acc, x) => acc + (x - t0) ** 2, 0) / v.length);
    };
    let best = fit(pts.map(() => true));
    if (drop && pts.length >= 5) for (let k = 0; k < pts.length; k++) if (atEnd[k]) best = Math.min(best, fit(pts.map((_, q) => q !== k)));
    return best;
  };
  let rms1 = Infinity;
  for (const x of grid) rms1 = Math.min(rms1, rmsOf((xi) => Math.abs(xi - x), true));
  let best = { i: 0, j: 0, rms: Infinity };
  const m = grid.length;
  const pair: Float64Array = new Float64Array(m * m).fill(Infinity);
  const minSep = Math.round(minSepM / step);
  for (let i = 0; i < m; i++) {
    for (let j = i + minSep; j < m; j++) {
      const r = rmsOf((xi) => Math.min(Math.abs(xi - grid[i]!), Math.abs(xi - grid[j]!)), pts.length >= 5);
      pair[i * m + j] = r;
      if (r < best.rms) best = { i, j, rms: r };
    }
  }
  const lim = best.rms + ARR_ZONE_TOL;
  let lo1 = best.i;
  let hi1 = best.i;
  while (lo1 > 0 && pair[(lo1 - 1) * m + best.j]! <= lim) lo1--;
  while (hi1 + 1 < best.j - minSep + 1 && pair[(hi1 + 1) * m + best.j]! <= lim) hi1++;
  let lo2 = best.j;
  let hi2 = best.j;
  while (lo2 - 1 >= best.i + minSep && pair[best.i * m + lo2 - 1]! <= lim) lo2--;
  while (hi2 < m - 1 && pair[best.i * m + hi2 + 1]! <= lim) hi2++;
  return {
    rms1,
    x1: grid[best.i]!,
    x2: grid[best.j]!,
    rms2: best.rms,
    zone1: [Math.max(0, grid[lo1]! - step), Math.min(L, grid[hi1]! + step)],
    zone2: [Math.max(0, grid[lo2]! - step), Math.min(L, grid[hi2]! + step)],
  };
}

/** Две волны видны: одна утечка их не объясняет, пара — объясняет. */
export function twoWaves(r: ArrivalSources | null): ArrivalSources | null {
  return r && r.rms1 > ARR_SINGLE_TOL && r.rms2 < ARR_PAIR_TOL && r.rms2 < 0.5 * r.rms1 ? r : null;
}

/**
 * Моменты прихода волны по датчикам давления в текущем событии.
 * capture() — в момент тревоги запоминает уровень «до события» и порог; track() — ловит приход на датчиках,
 * ещё не увидевших волну: скользящее среднее за 1 с ушло вниз дальше порога и держится ARRIVAL_SUSTAIN_SEC.
 */
export class ArrivalTracker {
  readonly times = new Map<string, number>();
  private pre = new Map<string, { pre: number; lim: number }>();
  private scanT = -Infinity;

  clear(): void {
    this.times.clear();
  }

  /** Уровень «до события» по датчикам давления: окно preWindow истории, порог — 4σ шума среднего за 1 с. */
  capture(
    t: number,
    sensors: SensorSpec[],
    rawHist: Map<string, RollingWindow>,
    preWindow: (avail: number) => [number, number] | null,
    noiseOf: (id: string) => number | undefined,
    binSec: number,
  ): void {
    this.pre.clear();
    const nMa = Math.max(1, Math.round(1 / binSec));
    for (const v of sensors) {
      if (v.kind !== 'p') continue;
      const w = rawHist.get(v.id);
      const noise = noiseOf(v.id);
      const win = w ? preWindow(w.length) : null;
      if (!w || !noise || !win) continue;
      this.pre.set(v.id, { pre: w.meanRange(win[0], win[1]), lim: (4 * noise) / Math.sqrt(nMa) });
    }
    this.scanT = t;
  }

  /** Просматриваем только новые отсчёты с прошлой проверки. */
  track(t: number, rawHist: Map<string, RollingWindow>, binSec: number): void {
    const nMa = Math.max(1, Math.round(1 / binSec));
    const nSus = Math.round(ARRIVAL_SUSTAIN_SEC / binSec);
    const nNew = Math.max(1, Math.round((t - this.scanT) / binSec));
    this.scanT = t;
    for (const [id, { pre, lim }] of this.pre) {
      if (this.times.has(id)) continue;
      const w = rawHist.get(id);
      if (!w) continue;
      // кандидаты — отсчёты, у которых уже есть nSus более новых для проверки устойчивости
      for (let i = Math.min(w.length - nMa, nSus + nNew); i >= nSus; i--) {
        const ma = w.meanRange(i, i + nMa);
        if (!(pre - ma > lim)) continue;
        let held = true;
        for (let k = 1; k <= nSus && held; k++) if (!(pre - w.meanRange(i - k, i - k + nMa) > lim / 2)) held = false;
        if (held) {
          this.times.set(id, t - (i + nMa / 2) * binSec);
          break;
        }
      }
    }
  }

  /** Приходы с местами датчиков — для arrivalSources. */
  points(sensors: SensorSpec[]): Array<{ x: number; t: number }> {
    return sensors.filter((v) => v.kind === 'p' && this.times.has(v.id)).map((v) => ({ x: v.x, t: this.times.get(v.id)! }));
  }
}
