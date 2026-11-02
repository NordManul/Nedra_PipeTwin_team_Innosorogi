/** Фильтры граничных замеров twin (H-B10, H-B11): шум в покое и запаздывание на рампе. */
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/math/rng';
import { EmaFilter, KalmanLevelFilter, type BoundaryFilter } from '../src/twin/boundary-filter';

const SIGMA = 10_000;
const DT = 0.1;

/** Ровный уровень 300 с, затем рампа +400 кПа за 3 с; возвращает шум в покое и наибольшее отставание на рампе. */
function probe(f: BoundaryFilter, seed = 1) {
  const rng = new Rng(seed);
  const quiet: number[] = [];
  let lag = 0;
  for (let i = 0; i < 3300; i++) {
    const t = i * DT;
    const truth = 4e6 + (t > 300 ? Math.min(t - 300, 3) / 3 : 0) * 4e5;
    const est = f.update(t, truth + SIGMA * rng.gauss());
    if (t > 60 && t <= 300) quiet.push(est - truth);
    if (t > 300) lag = Math.max(lag, Math.abs(est - truth));
  }
  const m = quiet.reduce((a, b) => a + b, 0) / quiet.length;
  const sd = Math.sqrt(quiet.reduce((a, b) => a + (b - m) ** 2, 0) / quiet.length);
  return { sd, lag };
}

describe('фильтры граничных замеров', () => {
  it('Калман в покое сглаживает как EMA с той же постоянной времени', () => {
    const k = probe(new KalmanLevelFilter(SIGMA, 2));
    const e = probe(new EmaFilter(2));
    // установившееся усиление α ≈ 0,05 → σ оценки ≈ σ·√(α/(2−α)) ≈ 0,16σ; редкие ложные сбросы добавляют немного
    expect(k.sd / SIGMA).toBeLessThan(0.3);
    expect(Math.abs(k.sd - e.sd) / e.sd).toBeLessThan(0.5);
  });

  it('на рампе насоса Калман не запаздывает, в отличие от EMA', () => {
    const k = probe(new KalmanLevelFilter(SIGMA, 5));
    const e = probe(new EmaFilter(5));
    // EMA отстаёт на ~ τ·скорость рампы (≈ 400 кПа за 5 с); Калман сбрасывается за несколько отсчётов
    expect(e.lag).toBeGreaterThan(200_000);
    expect(k.lag).toBeLessThan(80_000);
  });
});
