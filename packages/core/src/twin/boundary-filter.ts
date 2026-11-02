/**
 * Фильтры граничных замеров нестационарного twin (config.twin.inputFilter, inputFilterSec).
 *
 * Шум датчиков на концах трубы twin разносит волнами во все прогнозы. Сгладить его — значит
 * уменьшить шум невязок, но простое сглаживание запаздывает за рампой насоса или задвижки,
 * и запаздывание выглядит как утечка (H-B10). Поэтому фильтр Калмана работает в два режима:
 *  - в покое — оценка уровня (случайное блуждание) с установившимся усилением как у
 *    фильтра первого порядка с постоянной времени tauSec;
 *  - при манёвре (двусторонний CUSUM по нормированным инновациям) — сброс ковариации:
 *    оценка сразу встаёт на замер и дальше усредняет 1, 1/2, 1/3… отсчётов, пока усиление
 *    не вернётся к установившемуся. Продолжающаяся рампа снова поднимает CUSUM и снова сбрасывает.
 */

export interface BoundaryFilter {
  /** Новый замер (уже очищенный от выбросов) → оценка. */
  update(t: number, value: number): number;
}

/** Фильтр первого порядка (EMA) — для сравнения (H-B10). */
export class EmaFilter implements BoundaryFilter {
  private x: number | undefined;
  private lastT = NaN;
  constructor(private readonly tauSec: number) {}
  update(t: number, value: number): number {
    const dt = t - this.lastT;
    this.lastT = t;
    this.x = this.x === undefined || !(dt > 0) ? value : this.x + (value - this.x) * (1 - Math.exp(-dt / this.tauSec));
    return this.x;
  }
}

/** Порог CUSUM по инновациям (в σ) и допуск на отсчёт: ложный сброс в покое — раз в несколько минут, и он безвреден. */
const JUMP_K = 0.5;
const JUMP_H = 5;

export class KalmanLevelFilter implements BoundaryFilter {
  private x: number | undefined;
  private P = 0;
  private lastT = NaN;
  private gPos = 0;
  private gNeg = 0;
  /** Число сбросов — для диагностики. */
  resets = 0;

  /**
   * @param noiseStd σ шума датчика, единицы замера
   * @param tauSec постоянная времени в покое, с
   */
  constructor(
    private readonly noiseStd: number,
    private readonly tauSec: number,
  ) {}

  update(t: number, value: number): number {
    const R = Math.max(this.noiseStd, 1e-12) ** 2;
    const dt = t - this.lastT;
    this.lastT = t;
    if (this.x === undefined || !(dt > 0)) {
      this.x = value;
      this.P = R;
      return value;
    }
    // установившееся усиление α = 1 − e^(−dt/τ) ⇔ шум процесса Q = R·α²/(1 − α)
    const a = 1 - Math.exp(-dt / this.tauSec);
    const Q = (R * a * a) / (1 - a);
    const Pp = this.P + Q;
    const S = Pp + R;
    const nu = value - this.x;
    const z = nu / Math.sqrt(S);
    this.gPos = Math.max(0, this.gPos + z - JUMP_K);
    this.gNeg = Math.max(0, this.gNeg - z - JUMP_K);
    if (this.gPos > JUMP_H || this.gNeg > JUMP_H) {
      // манёвр: оценка — замер, дальше усреднение с нуля
      this.x = value;
      this.P = R;
      this.gPos = this.gNeg = 0;
      this.resets++;
      return value;
    }
    const K = Pp / S;
    this.x += K * nu;
    this.P = (1 - K) * Pp;
    return this.x;
  }
}
