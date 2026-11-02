/**
 * Разбор времени (WP-C1): ISO, dd.mm.yyyy HH:MM:SS(.fff), unix в с и мс, дата Excel,
 * дата и время в разных колонках. Время без пояса трактуется в заданном часовом поясе IANA.
 * Результат — миллисекунды Unix (UTC).
 */

export type TimeFormat = 'iso' | 'unix-s' | 'unix-ms' | 'excel' | 'seconds' | string;

/** Смещение пояса tz относительно UTC в момент utcMs, мс. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Местное время в поясе tz → UTC, мс. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, tz?: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  if (!tz || tz === 'UTC') return wall;
  let guess = wall - tzOffsetMs(wall, tz);
  guess = wall - tzOffsetMs(guess, tz);
  return guess;
}

const RU_DATE = /^(\d{1,2})[./](\d{1,2})[./](\d{2,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?)?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;
const TIME_ONLY = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?$/;

const frac = (s?: string) => (s ? Math.round(Number(`0.${s}`) * 1000) : 0);

/** Дата Excel (дни с 1899-12-30) → мс UTC «настенного» времени. */
export function excelToWallMs(serial: number): number {
  return Math.round((serial - 25569) * 86400000);
}

/**
 * Разобрать значение времени. Возвращает мс UTC или, для формата 'seconds', секунды×1000 как есть.
 * format — подсказка; без неё формат определяется по виду.
 */
export function parseTime(v: string | number, format?: TimeFormat, tz?: string): number {
  if (typeof v === 'number') return numericTime(v, format, tz);
  const s = v.trim();
  if (format === 'unix-s' || format === 'unix-ms' || format === 'excel' || format === 'seconds') return numericTime(Number(s.replace(',', '.')), format, tz);
  let m = ISO_DATE.exec(s);
  if (m) {
    const ms = frac(m[7]);
    const base = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), ms);
    if (m[8]) {
      if (m[8] === 'Z') return base;
      const sign = m[8][0] === '-' ? -1 : 1;
      const [hh, mm] = m[8].slice(1).replace(':', '').match(/(\d{2})(\d{2})/)!.slice(1).map(Number);
      return base - sign * (hh! * 60 + mm!) * 60000;
    }
    return zonedToUtc(+m[1]!, +m[2]!, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), ms, tz);
  }
  m = RU_DATE.exec(s);
  if (m) {
    let y = +m[3]!;
    if (y < 100) y += 2000;
    return zonedToUtc(y, +m[2]!, +m[1]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), frac(m[7]), tz);
  }
  const n = Number(s.replace(',', '.'));
  if (Number.isFinite(n)) return numericTime(n, format, tz);
  return NaN;
}

function numericTime(n: number, format?: TimeFormat, tz?: string): number {
  switch (format) {
    case 'unix-s':
      return n * 1000;
    case 'unix-ms':
      return n;
    case 'excel': {
      const wall = excelToWallMs(n);
      if (!tz) return wall;
      const d = new Date(wall);
      return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(), tz);
    }
    case 'seconds':
      return n * 1000;
    default:
      if (n > 1e11) return n; // unix мс
      if (n > 1e8) return n * 1000; // unix с
      if (n > 20000 && n < 80000) return numericTime(n, 'excel', tz); // дата Excel (1954–2119)
      return n * 1000; // секунды от начала
  }
}

/** Время «дата» + «время» из двух колонок. */
export function parseDateTime(date: string, time: string, tz?: string): number {
  const t = TIME_ONLY.exec(time.trim());
  if (!t) return parseTime(`${date} ${time}`, undefined, tz);
  const iso = ISO_DATE.exec(date.trim());
  const ru = RU_DATE.exec(date.trim());
  const ms = frac(t[4]);
  if (iso) return zonedToUtc(+iso[1]!, +iso[2]!, +iso[3]!, +t[1]!, +t[2]!, +(t[3] ?? 0), ms, tz);
  if (ru) {
    let y = +ru[3]!;
    if (y < 100) y += 2000;
    return zonedToUtc(y, +ru[2]!, +ru[1]!, +t[1]!, +t[2]!, +(t[3] ?? 0), ms, tz);
  }
  return NaN;
}

/** Похоже ли значение на метку времени (для автопоиска колонки времени). */
export function looksLikeTime(s: string): boolean {
  const v = s.trim();
  return ISO_DATE.test(v) || RU_DATE.test(v) || TIME_ONLY.test(v);
}
