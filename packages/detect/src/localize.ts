/**
 * Локализация утечки (WP-B4) и оценка расхода (WP-B5).
 *  L1 hgl — пересечение линий гидравлического уклона: профиль от входа по (p_вх, Q_вх) и от выхода
 *           по (p_вых, Q_вых); утечка там, где они пересекаются.
 *  L2 lsq — МНК-подбор (x, q) по невязкам всех датчиков с откликами twin.
 *  L3 wave-timing — по времени прихода волны (DropTracker в detectors/npw.ts).
 */
import type { SensorValues, TwinModel } from '@pipetwin/core/contracts';

export interface LocationEstimate {
  x: number;
  interval: [number, number];
  rate?: number;
}

/** L1: пересечение линий гидравлического уклона. */
export function locateHgl(twin: TwinModel, L: number, pIn: number, qIn: number, pOut: number, qOut: number): LocationEstimate | null {
  if (!twin.steadyProfileFrom) return null;
  const up = twin.steadyProfileFrom('inlet', pIn, qIn);
  const dn = twin.steadyProfileFrom('outlet', pOut, qOut);
  const n = up.x.length;
  let prev = up.p[0]! - dn.p[0]!;
  for (let i = 1; i < n; i++) {
    const cur = up.p[i]! - dn.p[i]!;
    if (prev === 0 || Math.sign(cur) !== Math.sign(prev)) {
      const x0 = up.x[i - 1]!;
      const x1 = up.x[i]!;
      const x = prev === cur ? x0 : x0 + ((x1 - x0) * prev) / (prev - cur);
      const err = 0.05 * L;
      return { x, interval: [Math.max(0, x - err), Math.min(L, x + err)], rate: Math.max(0, qIn - qOut) };
    }
    prev = cur;
  }
  return null;
}

/** Кэш откликов twin на сетке кандидатов для L2. */
export class LsqLocator {
  private xs: number[] = [];
  private resp: SensorValues[] = [];
  private qTest = 0;

  build(twin: TwinModel, L: number, nominalFlow: number, positions = 50): boolean {
    if (!twin.leakResponse) return false;
    this.qTest = 0.01 * Math.max(Math.abs(nominalFlow), 1e-6);
    this.xs = Array.from({ length: positions }, (_, j) => (L * (j + 0.5)) / positions);
    this.resp = this.xs.map((x) => twin.leakResponse!(x, this.qTest));
    return true;
  }

  get ready(): boolean {
    return this.xs.length > 0;
  }

  /**
   * Стоимость каждого кандидата: dr — изменение невязки (замер − прогноз) относительно нормы, СИ;
   * sigma — шум по датчикам. q̂ = (Hᵀy)/(HᵀH) ≥ 0, стоимость = |y − q̂·H|².
   */
  costs(dr: SensorValues, sigma: (id: string) => number | undefined): { costs: number[]; rates: number[] } | null {
    if (!this.ready) return null;
    const costs: number[] = [];
    const rates: number[] = [];
    for (const r of this.resp) {
      let hh = 0;
      let hy = 0;
      let yy = 0;
      for (const [id, v] of Object.entries(dr)) {
        const sg = sigma(id);
        const h = r[id];
        if (!sg || h === undefined) continue;
        const hn = h / this.qTest / sg;
        const yn = v / sg;
        hh += hn * hn;
        hy += hn * yn;
        yy += yn * yn;
      }
      const q = hh > 0 ? Math.max(0, hy / hh) : 0;
      rates.push(q);
      costs.push(yy - 2 * q * hy + q * q * hh);
    }
    return { costs, rates };
  }

  /** Место по стоимостям: минимум (с уточнением параболой) и интервал, где стоимость ≤ минимум + delta. */
  fromCosts(costs: number[], rates: number[], L: number, delta = 4): LocationEstimate | null {
    if (!this.ready || costs.length !== this.xs.length) return null;
    let best = 0;
    for (let j = 1; j < costs.length; j++) if (costs[j]! < costs[best]!) best = j;
    const lim = costs[best]! + delta;
    let lo = best;
    let hi = best;
    while (lo > 0 && costs[lo - 1]! <= lim) lo--;
    while (hi < costs.length - 1 && costs[hi + 1]! <= lim) hi++;
    // уточнение параболой по трём точкам
    let x = this.xs[best]!;
    if (best > 0 && best < costs.length - 1) {
      const [c0, c1, c2] = [costs[best - 1]!, costs[best]!, costs[best + 1]!];
      const den = c0 - 2 * c1 + c2;
      if (den > 0) x += (0.5 * (c0 - c2) / den) * (this.xs[1]! - this.xs[0]!);
    }
    const half = L / this.xs.length / 2;
    return { x: Math.min(L, Math.max(0, x)), interval: [Math.max(0, this.xs[lo]! - half), Math.min(L, this.xs[hi]! + half)], rate: rates[best] };
  }

  /**
   * Отклики кандидатов на утечку 1 м³/с, нормированные на шум: для подбора «одна утечка или две»
   * (одновременные утечки). ids — каналы в нужном порядке.
   */
  shapes(ids: string[], sigma: (id: string) => number | undefined): { xs: number[]; h: number[][] } | null {
    if (!this.ready) return null;
    const h = this.resp.map((r) => ids.map((id) => {
      const sg = sigma(id);
      const v = r[id];
      return sg && v !== undefined ? v / this.qTest / sg : 0;
    }));
    return { xs: this.xs, h };
  }

  locate(dr: SensorValues, sigma: (id: string) => number | undefined, L: number, delta = 4): LocationEstimate | null {
    const c = this.costs(dr, sigma);
    return c ? this.fromCosts(c.costs, c.rates, L, delta) : null;
  }
}
