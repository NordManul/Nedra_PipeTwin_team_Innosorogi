/** Перевод из СИ в «человеческие» единицы — только на экране (внутри всё в СИ). */
import type { SensorKind } from '@pipetwin/core/contracts';

export const ATM = 101325;

/** Давление: Па абс. → МПа избыточного. */
export const pMPa = (pa: number, atm = ATM) => (pa - atm) / 1e6;
export const qM3h = (q: number) => q * 3600;
export const tC = (k: number) => k - 273.15;
export const km = (m: number) => m / 1000;

export function display(kind: SensorKind, v: number, atm = ATM): number {
  return kind === 'p' ? pMPa(v, atm) : kind === 'q' ? qM3h(v) : tC(v);
}

export const UNIT: Record<SensorKind, string> = { p: 'МПа (изб.)', q: 'м³/ч', T: '°C' };

export function fmt(v: number | undefined | null, digits = 1): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits).replace('.', ',');
}

/** Значение параметра конфига для таблицы статусов: по пути выбираем единицу. */
export function paramDisplay(path: string, v: number): string {
  if (/pressure|Pressure|bulkModulus|wallModulus|vaporPressure/.test(path)) return `${fmt(v / 1e6, 3)} МПа`;
  if (/roughness|wallThickness|diameter/.test(path)) return `${fmt(v * 1000, 2)} мм`;
  if (/length|\.x$|dx/.test(path)) return v >= 1000 ? `${fmt(v / 1000, 2)} км` : `${fmt(v, 1)} м`;
  if (/Temp|T0|\.T$/.test(path)) return `${fmt(v - 273.15, 1)} °C`;
  if (/\.nu0?$|nu$/.test(path)) return `${fmt(v * 1e6, 2)} сСт`;
  if (/noiseStd|bias/.test(path)) return v > 100 ? `${fmt(v / 1000, 1)} кПа` : v < 0.01 ? `${fmt(v * 3600, 2)} м³/ч` : fmt(v, 3);
  if (/heatTransferCoef/.test(path)) return `${fmt(v, 2)} Вт/(м²·К)`;
  if (/rho/.test(path)) return `${fmt(v, 1)} кг/м³`;
  if (/rateHz/.test(path)) return `${fmt(v, 1)} Гц`;
  if (/lagSec/.test(path)) return `${fmt(v, 1)} с`;
  return Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(3) : fmt(v, 3);
}
