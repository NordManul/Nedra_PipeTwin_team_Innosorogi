/**
 * Подтверждённые утечки: установление отклика и их устранение — одной, нескольких или всех сразу (H-B13, H-B14).
 */

/** Окно средних невязок для вклада утечки и проверок установления, с. */
export const LEAK_WINDOW_SEC = 10;
/** Установилось: среднее за окно сдвинулось меньше max(SETTLE_Z σ, SETTLE_REL от отклонения) SETTLE_HITS раз подряд. */
const SETTLE_Z = 0.5;
const SETTLE_HITS = 3;
const SETTLE_REL = 0.15;
/** Набор снятых утечек объясняет сдвиг с ошибкой меньше RECOVER_TOL от его величины RECOVER_HITS проверок подряд. */
const RECOVER_TOL = 0.5;
const RECOVER_HITS = 5;
/** Допуск баланса расходов — BALANCE_REL от суммарного вклада снятых утечек (но не меньше 3σ шума баланса). */
const BALANCE_REL = 0.3;
/** Полный перебор наборов — до стольких утечек, дальше жадно. */
const EXHAUSTIVE_MAX = 10;

type Sigma = (id: string) => number | undefined;

/**
 * Установился ли отклик: раз в LEAK_WINDOW_SEC сравниваем средние невязки с прошлым снимком.
 * Пока после утечки (или её снятия) перестраиваются расход и давления, отклик ещё меняется.
 */
export class SettleTracker {
  private snap: { t: number; r: Record<string, number> } | null = null;
  /** Проверок подряд, на которых отклик не изменился. */
  hits = 0;

  reset(): void {
    this.snap = null;
    this.hits = 0;
  }

  /** Пора ли новая проверка (прошло окно с прошлого снимка). */
  due(t: number): boolean {
    return !this.snap || t - this.snap.t >= LEAK_WINDOW_SEC;
  }

  /** Новый снимок r (средние невязки, СИ) и сравнение с прошлым. */
  update(t: number, r: Record<string, number>, sigma: Sigma): void {
    const prev = this.snap;
    this.snap = { t, r };
    let ok = !!prev;
    if (prev) {
      for (const [id, v] of Object.entries(r)) {
        const sg = sigma(id);
        if (!sg || prev.r[id] === undefined) continue;
        // допуск — SETTLE_Z σ или SETTLE_REL от самого отклонения (у крупной утечки медленные колебания больше)
        if (Math.abs(v - prev.r[id]!) > Math.max(SETTLE_Z * sg, SETTLE_REL * Math.abs(v))) ok = false;
      }
    }
    this.hits = ok ? this.hits + 1 : 0;
  }

  get settled(): boolean {
    return this.hits >= SETTLE_HITS;
  }
}

export interface RecoveryInput {
  /** Средние невязки за окно (СИ) относительно нормы, в которую входят вклады подтверждённых утечек. */
  y: Record<string, number>;
  /** Вклады подтверждённых утечек (СИ). */
  deltas: Array<Record<string, number>>;
  sigma: Sigma;
  /** Расходомеры на входе и выходе — для баланса (если есть оба). */
  qIn?: string | undefined;
  qOut?: string | undefined;
}

/**
 * Какие утечки сняли. Сдвиг невязок y объясняем набором снятых R: y ≈ −Σ_{k∈R} Δ_k (давления), а баланс
 * расходов (вход − выход) — прямо суммарный расход утечек: по нему видно, сколько сняли, даже когда
 * в давлениях вклад малой утечки тонет в шуме. Набор принимаем, если он лучший RECOVER_HITS проверок подряд
 * и сдвиг установился; пока сдвиг заметен, норму держим замороженной (holdUntil).
 */
export class RecoveryWatcher {
  private mask = 0;
  private hits = 0;
  private stability = new SettleTracker();
  /** До этого момента норму не подстраиваем: идёт возможное снятие утечек. */
  holdUntil = -Infinity;

  reset(): void {
    this.mask = 0;
    this.hits = 0;
    this.stability.reset();
    this.holdUntil = -Infinity;
  }

  /** Проверка раз в секунду. Возвращает маску снятых утечек (бит k — deltas[k]) или 0. holdSec — предел заморозки нормы. */
  check(t: number, inp: RecoveryInput, holdSec: number): number {
    const { y, sigma } = inp;
    const ids = Object.keys(y);
    const sg = ids.map((id) => sigma(id) ?? 0);
    const yv = ids.map((id, i) => (sg[i]! > 0 ? y[id]! / sg[i]! : 0));
    const dv = inp.deltas.map((d) => ids.map((id, i) => (sg[i]! > 0 ? (d[id] ?? 0) / sg[i]! : 0)));
    const n = inp.deltas.length;
    const { qIn, qOut } = inp;
    const hasBal = !!qIn && !!qOut && y[qIn] !== undefined && y[qOut] !== undefined;
    const by = hasBal ? y[qIn!]! - y[qOut!]! : 0;
    const bk = inp.deltas.map((d) => (hasBal ? (d[qIn!] ?? 0) - (d[qOut!] ?? 0) : 0));
    // шум баланса на среднем за окно: расходомеры инерционны, независимых отсчётов ≈ 1 в секунду
    const balNoise = hasBal ? Math.hypot(sigma(qIn!) ?? 0, sigma(qOut!) ?? 0) / Math.sqrt(LEAK_WINDOW_SEC) : 0;
    // давления: шум среднего за окно по всем каналам, в долях σ
    const pAbs = (3 * Math.sqrt(ids.length)) / Math.sqrt(LEAK_WINDOW_SEC);
    const evalSet = (mask: number) => {
      let err = 0;
      let size = 0;
      let bsum = 0;
      for (let k = 0; k < n; k++) if (mask & (1 << k)) bsum += bk[k]!;
      for (let i = 0; i < ids.length; i++) {
        let sum = 0;
        for (let k = 0; k < n; k++) if (mask & (1 << k)) sum += dv[k]![i]!;
        err += (yv[i]! + sum) ** 2;
        size += sum * sum;
      }
      const sb = Math.max(3 * balNoise, BALANCE_REL * Math.abs(bsum));
      const bmis = hasBal && sb > 0 ? Math.abs(by + bsum) / sb : 0;
      err = Math.sqrt(err);
      size = Math.sqrt(size);
      // счёт набора: давления (в долях вклада) и баланс (в долях допуска)
      const score = (err / Math.max(size, 1e-9)) ** 2 + bmis ** 2;
      const ok = bmis < 1 && err < Math.max(RECOVER_TOL * size, hasBal ? pAbs : 0);
      return { err, size, score, ok };
    };
    let bestMask = 0;
    let best = { err: Infinity, size: 0, score: Infinity, ok: false };
    if (n <= EXHAUSTIVE_MAX) {
      for (let mask = 1; mask < 1 << n; mask++) {
        const r = evalSet(mask);
        if (r.score < best.score) {
          best = r;
          bestMask = mask;
        }
      }
    } else {
      // много утечек: жадно добавляем ту, что сильнее всего уменьшает счёт
      let mask = 0;
      let cur = Infinity;
      for (;;) {
        let pick = -1;
        let pickScore = cur;
        for (let k = 0; k < n; k++) {
          if (mask & (1 << k)) continue;
          const e = evalSet(mask | (1 << k)).score;
          if (e < pickScore) {
            pickScore = e;
            pick = k;
          }
        }
        if (pick < 0) break;
        mask |= 1 << pick;
        cur = pickScore;
      }
      bestMask = mask;
      if (mask) best = evalSet(mask);
    }
    // заметный сдвиг (баланс или давления) — держим норму замороженной до решения (не дольше holdSec)
    const shiftP = Math.hypot(...yv);
    const shifted = (hasBal && Math.abs(by) > 3 * balNoise) || shiftP > pAbs;
    if (shifted) {
      if (!(t < this.holdUntil)) this.holdUntil = t + holdSec;
    } else this.holdUntil = -Infinity;
    // сдвиг должен установиться: пока идёт переходный процесс от снятия дальней утечки, набор ещё неполон
    if (this.stability.due(t)) this.stability.update(t, y, sigma);
    const ok = bestMask !== 0 && best.size > 0 && best.ok && this.stability.hits >= 2;
    this.hits = ok && bestMask === this.mask ? this.hits + 1 : ok ? 1 : 0;
    this.mask = ok ? bestMask : 0;
    if (this.hits < RECOVER_HITS) return 0;
    this.reset();
    return bestMask;
  }
}

/**
 * Защита после утечки (или её снятия): остаток переходного процесса — как после смены режима, порог
 * временно выше. Множитель растёт с величиной вклада: 1 + LEAK_GUARD_K·|Δ|σ, в пределах [1.5, 4].
 */
export const LEAK_GUARD_SCALE = 2;
const LEAK_GUARD_K = 0.2;

export function leakGuardFactor(delta: Record<string, number>, sigma: Sigma): number {
  let n2 = 0;
  for (const [id, d] of Object.entries(delta)) {
    const sg = sigma(id);
    if (sg) n2 += (d / sg) ** 2;
  }
  return Math.min(4, Math.max(1.5, 1 + LEAK_GUARD_K * Math.sqrt(n2)));
}
