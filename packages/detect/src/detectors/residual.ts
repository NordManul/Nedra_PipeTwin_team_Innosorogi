/**
 * D1–D3: детекторы по нормированной невязке. Работают по каналам «свидетельства утечки» e
 * (каждый датчик + суммарный канал); статистика — максимум по каналам.
 */
import type { DetectorParams } from '@pipetwin/core/contracts';
import type { PreparedSample, StatContext, Statistic, StatOut } from '../types';
import { ewmaAlpha, RollingWindow } from '../util';

/** Отслеживание момента начала: последний момент, когда статистика канала была около нуля. */
class OnsetTracker {
  private readonly quiet = new Map<string, number>();
  mark(ch: string, t: number, value: number, quietLevel: number): void {
    if (value <= quietLevel || !this.quiet.has(ch)) this.quiet.set(ch, t);
  }
  get(ch: string): number | undefined {
    return this.quiet.get(ch);
  }
  clear(): void {
    this.quiet.clear();
  }
}

function pickMax(values: Record<string, number>): [string, number] {
  let best = '';
  let v = -Infinity;
  for (const [k, x] of Object.entries(values)) if (x > v) [best, v] = [k, x];
  return [best, v];
}

/** D1: порог на скользящем среднем z за windowSec, нормированном на √n. */
export class ThresholdStat implements Statistic {
  private readonly win = new Map<string, RollingWindow>();
  private readonly n: number;
  private readonly onset = new OnsetTracker();
  constructor(sc: StatContext, private readonly p: DetectorParams) {
    this.n = Math.max(1, Math.round(p.windowSec! / sc.binSec));
  }
  update(s: PreparedSample): StatOut {
    const ch: Record<string, number> = {};
    for (const [id, e] of Object.entries(s.e)) {
      let w = this.win.get(id);
      if (!w) this.win.set(id, (w = new RollingWindow(this.n)));
      w.push(e);
      ch[id] = w.mean() * Math.sqrt(w.length);
      this.onset.mark(id, s.t, ch[id]!, 0.5);
    }
    const [best, score] = pickMax(ch);
    return { score: Number.isFinite(score) ? score : 0, threshold: this.p.k!, channels: ch, onset: this.onset.get(best) };
  }
  rearm(): void {
    this.win.clear();
    this.onset.clear();
  }
}

/** D2: CUSUM Пейджа; односторонний по направлению утечки для тревоги, обратная сторона — для журнала. */
export class CusumStat implements Statistic {
  private readonly S = new Map<string, number>();
  private readonly onset = new OnsetTracker();
  constructor(private readonly p: DetectorParams) {}
  update(s: PreparedSample): StatOut {
    const ch: Record<string, number> = {};
    for (const [id, e] of Object.entries(s.e)) {
      const v = Math.max(0, (this.S.get(id) ?? 0) + e - this.p.drift!);
      this.S.set(id, v);
      ch[id] = v;
      this.onset.mark(id, s.t, v, 0);
    }
    const [best, score] = pickMax(ch);
    return { score: Number.isFinite(score) ? score : 0, threshold: this.p.h!, channels: ch, onset: this.onset.get(best) };
  }
  rearm(): void {
    this.S.clear();
    this.onset.clear();
  }
}

/** D3: EWMA-карта с постоянной времени tauSec и пределом L·σ_EWMA. */
export class EwmaStat implements Statistic {
  private readonly E = new Map<string, number>();
  private readonly onset = new OnsetTracker();
  constructor(private readonly sc: StatContext, private readonly p: DetectorParams) {}
  update(s: PreparedSample): StatOut {
    const lam = ewmaAlpha(this.sc.binSec, this.p.tauSec!);
    const sd = Math.sqrt(lam / (2 - lam));
    const ch: Record<string, number> = {};
    for (const [id, e] of Object.entries(s.e)) {
      const v = (1 - lam) * (this.E.get(id) ?? 0) + lam * e;
      this.E.set(id, v);
      ch[id] = v / sd;
      this.onset.mark(id, s.t, ch[id]!, 0.5);
    }
    const [best, score] = pickMax(ch);
    return { score: Number.isFinite(score) ? score : 0, threshold: this.p.L!, channels: ch, onset: this.onset.get(best) };
  }
  rearm(): void {
    this.E.clear();
    this.onset.clear();
  }
}

/**
 * D10: GLR — обобщённое отношение правдоподобия для сдвига среднего неизвестной величины, начавшегося
 * в неизвестный момент. Для единичного шума log Λ = max_k S_k²/(2n_k), где S_k — сумма e за последние n_k
 * отсчётов; статистика — √(2 log Λ) = max_n S_n/√n (в долях σ). В отличие от CUSUM не нужно заранее
 * задавать величину утечки (drift): короткое окно ловит крупную, длинное — малую. Окна — геометрическая
 * сетка от minSec до maxSec (шаг ×1,15); момент начала — начало лучшего окна.
 */
export class GlrStat implements Statistic {
  private readonly cum = new Map<string, Float64Array>();
  private readonly ns: number[];
  private readonly size: number;
  private i = 0;
  private readonly count = new Map<string, number>();
  constructor(private readonly sc: StatContext, private readonly p: DetectorParams) {
    const nMin = Math.max(1, Math.round(p.minSec! / sc.binSec));
    const nMax = Math.max(nMin, Math.round(p.maxSec! / sc.binSec));
    const ns: number[] = [];
    for (let n = nMin; n < nMax; n = Math.max(n + 1, Math.round(n * 1.15))) ns.push(n);
    ns.push(nMax);
    this.ns = ns;
    this.size = nMax + 1;
  }
  update(s: PreparedSample): StatOut {
    const ch: Record<string, number> = {};
    let best = -Infinity;
    let bestN = 0;
    const at = this.i % this.size;
    const prevAt = (this.i - 1 + this.size) % this.size;
    for (const [id, e] of Object.entries(s.e)) {
      let c = this.cum.get(id);
      if (!c) this.cum.set(id, (c = new Float64Array(this.size)));
      const have = this.count.get(id) ?? 0;
      // c — кольцо накопленных сумм: c[at] = c[at − 1] + e
      c[at] = (have ? c[prevAt]! : 0) + e;
      this.count.set(id, Math.min(have + 1, this.size));
      let v = 0;
      let vn = 0;
      for (const n of this.ns) {
        if (n >= this.count.get(id)!) break;
        const S = c[at]! - c[(at - n + this.size) % this.size]!;
        const g = S / Math.sqrt(n);
        if (g > v) {
          v = g;
          vn = n;
        }
      }
      ch[id] = v;
      if (v > best) {
        best = v;
        bestN = vn;
      }
    }
    this.i++;
    const score = Number.isFinite(best) ? best : 0;
    return { score, threshold: this.p.h!, channels: ch, ...(bestN ? { onset: s.t - bestN * this.sc.binSec } : {}) };
  }
  rearm(): void {
    this.cum.clear();
    this.count.clear();
    this.i = 0;
  }
}

/**
 * D11: адаптивный EWMA (Capizzi, Masarotto, 2003): E ← E + φ(e − E), φ — функция Хьюбера с порогом kH (σ).
 * Малые отклонения сглаживаются как в EWMA (λ по tauSec), крупный скачок проходит почти целиком —
 * карта реагирует как порог на одном отсчёте. Предел — L·σ_EWMA, как у D3.
 */
export class AewmaStat implements Statistic {
  private readonly E = new Map<string, number>();
  private readonly onset = new OnsetTracker();
  constructor(private readonly sc: StatContext, private readonly p: DetectorParams) {}
  update(s: PreparedSample): StatOut {
    const lam = ewmaAlpha(this.sc.binSec, this.p.tauSec!);
    const k = this.p.kH!;
    const sd = Math.sqrt(lam / (2 - lam));
    const ch: Record<string, number> = {};
    for (const [id, e] of Object.entries(s.e)) {
      const prev = this.E.get(id) ?? 0;
      const u = e - prev;
      const phi = u > k ? u - (1 - lam) * k : u < -k ? u + (1 - lam) * k : lam * u;
      const v = prev + phi;
      this.E.set(id, v);
      ch[id] = v / sd;
      this.onset.mark(id, s.t, ch[id]!, 0.5);
    }
    const [best, score] = pickMax(ch);
    return { score: Number.isFinite(score) ? score : 0, threshold: this.p.L!, channels: ch, onset: this.onset.get(best) };
  }
  rearm(): void {
    this.E.clear();
    this.onset.clear();
  }
}

/**
 * D12: SPRT на балансе расходов, как в промышленных системах (API RP 1130, статистический баланс объёма).
 * Баланс — разница невязок расходомеров на входе и на выходе: двойник уже учёл накопление в трубе,
 * поэтому при утечке q баланс сдвигается на q (вход растёт, выход падает). Параллельно несколько
 * последовательных тестов отношения вероятностей — по одному на размер утечки (доля номинального
 * расхода из sizes): S ← max(0, S + m·(x − m/2)), x и m — в долях шума баланса. Тест со сбросом в ноль —
 * это CUSUM Пейджа; порог h — логарифм отношения правдоподобия, общий для всех размеров.
 */
export class SprtStat implements Statistic {
  private readonly S: number[];
  private readonly qIn: string | undefined;
  private readonly qOut: string | undefined;
  private readonly sizes: number[];
  private quietAt: number | undefined;
  constructor(private readonly sc: StatContext, private readonly p: DetectorParams) {
    const L = sc.ctx.config.geometry.length;
    this.qIn = sc.ctx.sensors.find((v) => v.kind === 'q' && v.x <= 1)?.id;
    this.qOut = sc.ctx.sensors.find((v) => v.kind === 'q' && v.x >= L - 1)?.id;
    this.sizes = [p.size1!, p.size2!, p.size3!, p.size4!].filter((v) => v > 0);
    this.S = this.sizes.map(() => 0);
  }
  update(s: PreparedSample): StatOut {
    const h = this.p.h!;
    const zi = this.qIn ? s.z[this.qIn] : undefined;
    const zo = this.qOut ? s.z[this.qOut] : undefined;
    const si = this.qIn ? this.sc.prep.sigmaOf(this.qIn) : undefined;
    const so = this.qOut ? this.sc.prep.sigmaOf(this.qOut) : undefined;
    const Q = this.sc.prep.nominalFlow;
    if (zi === undefined || zo === undefined || !si || !so || !(Q > 0)) return { score: 0, threshold: h };
    const sb = Math.hypot(si, so);
    const b = zi * si - zo * so;
    const x = b / sb;
    let best = 0;
    for (let k = 0; k < this.sizes.length; k++) {
      const m = (this.sizes[k]! * Q) / sb;
      this.S[k] = Math.max(0, this.S[k]! + m * (x - m / 2));
      best = Math.max(best, this.S[k]!);
    }
    if (best === 0 || this.quietAt === undefined) this.quietAt = s.t;
    return {
      score: best,
      threshold: h,
      leakRate: Math.max(0, b),
      channels: { [this.qIn!]: best / 2, [this.qOut!]: best / 2 },
      onset: this.quietAt,
    };
  }
  rearm(): void {
    this.S.fill(0);
    this.quietAt = undefined;
  }
}
