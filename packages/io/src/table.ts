/**
 * Нормализованная таблица (WP-C1): поиск строки заголовка (служебные строки над таблицей),
 * строки единиц под заголовком, колонки времени; время — в секундах от первой строки.
 */
import type { NormalizedTable, TimeMapping } from '@pipetwin/core';
import { guessColumn, type ColumnGuess } from './guess';
import { isNumeric, parseCell, type DecimalSep } from './text';
import { looksLikeTime, parseDateTime, parseTime } from './time';

export interface Layout {
  headerRow: number;
  unitsRow?: number;
  dataStart: number;
}

const isDataCell = (c: string | undefined, d: DecimalSep) => c !== undefined && c !== '' && (isNumeric(c, d) || looksLikeTime(c));
const isTextCell = (c: string | undefined, d: DecimalSep) => c !== undefined && c.trim() !== '' && !isDataCell(c, d);

/** Строка заголовка — первая «текстовая» строка, за которой идут строки данных той же ширины. */
export function detectLayout(rows: string[][], decimal: DecimalSep): Layout {
  const dataLike = (r: string[] | undefined) => !!r && r.filter((c) => isDataCell(c, decimal)).length >= Math.max(1, Math.ceil(r.length * 0.5));
  for (let i = 0; i < Math.min(rows.length - 1, 40); i++) {
    const h = rows[i]!;
    if (h.length < 2 || h.filter((c) => isTextCell(c, decimal)).length < Math.ceil(h.length * 0.5)) continue;
    const width = h.length;
    const next = rows[i + 1];
    const unitsLike = !!next && !dataLike(next) && next.length >= width - 1 && next.some((c) => c.trim() !== '');
    const start = unitsLike ? i + 2 : i + 1;
    const probe = rows.slice(start, start + 3);
    if (probe.length && probe.every((r) => dataLike(r) && Math.abs(r.length - width) <= 1)) {
      return { headerRow: i, ...(unitsLike ? { unitsRow: i + 1 } : {}), dataStart: start };
    }
  }
  return { headerRow: -1, dataStart: 0 };
}

const TIME_NAME = /^(время|time|timestamp|datetime|дата[ _.]?время|date[ _]?time|t|t,\s*с|t\s*\[s\]|метка времени)$/i;
const DATE_NAME = /^(дата|date|day)$/i;
const CLOCK_NAME = /^(время|time|час)$/i;

/** Колонки времени: явная настройка или автопоиск («Дата» + «Время», «timestamp», первая колонка с датами). */
export function findTimeColumns(headers: string[], sample: string[][], time?: TimeMapping): number[] {
  const idx = (n: string) => headers.findIndex((h) => h.trim() === n.trim());
  if (time) {
    const cols = Array.isArray(time.column) ? time.column.map(idx) : [idx(time.column)];
    if (cols.some((c) => c < 0)) throw new Error(`нет колонки времени «${time.column}»`);
    return cols;
  }
  const d = headers.findIndex((h) => DATE_NAME.test(h.trim()));
  const c = headers.findIndex((h, i) => i !== d && CLOCK_NAME.test(h.trim()));
  if (d >= 0 && c >= 0) return [d, c];
  const named = headers.findIndex((h) => TIME_NAME.test(h.trim()));
  if (named >= 0) return [named];
  const byValue = headers.findIndex((_, i) => sample.length > 0 && sample.every((r) => r[i] !== undefined && looksLikeTime(r[i]!)));
  if (byValue >= 0) return [byValue];
  return [0];
}

export interface TableResult {
  table: NormalizedTable;
  guesses: ColumnGuess[];
  layout: Layout;
  timeColumns: string[];
}

export function buildTable(rows: string[][], decimal: DecimalSep, opts: { time?: TimeMapping; ignore?: string[]; layout?: Partial<Layout> } = {}): TableResult {
  const auto = detectLayout(rows, decimal);
  const layout: Layout = { ...auto, ...opts.layout } as Layout;
  if (opts.layout?.headerRow !== undefined && opts.layout.dataStart === undefined) {
    layout.dataStart = layout.headerRow + 1 + (layout.unitsRow !== undefined ? 1 : 0);
  }
  if (layout.headerRow < 0) throw new Error('не найдена строка заголовка: укажите её в профиле маппинга (file.headerRow)');
  const headers = rows[layout.headerRow]!.map((h) => h.trim());
  const units = layout.unitsRow !== undefined ? rows[layout.unitsRow]! : undefined;
  const data = rows.slice(layout.dataStart).filter((r) => r.some((c) => c.trim() !== ''));
  const tcols = findTimeColumns(headers, data.slice(0, 5), opts.time);
  const tz = opts.time?.timezone;
  const fmt = opts.time?.format;
  const warnings: string[] = [];
  const times: number[] = [];
  const keep: number[] = [];
  data.forEach((r, i) => {
    const v = tcols.length === 2 ? parseDateTime(r[tcols[0]!] ?? '', r[tcols[1]!] ?? '', tz) : parseTime(r[tcols[0]!] ?? '', fmt === 'excel' || fmt === 'iso' || fmt === 'unix-s' || fmt === 'unix-ms' || fmt === 'seconds' ? fmt : undefined, tz);
    if (Number.isFinite(v)) {
      times.push(v);
      keep.push(i);
    }
  });
  if (!times.length) throw new Error('не удалось разобрать ни одной метки времени');
  if (keep.length < data.length) warnings.push(`строк с неразобранным временем: ${data.length - keep.length}`);
  for (let i = 1; i < times.length; i++) {
    if (times[i]! <= times[i - 1]!) {
      warnings.push('время не возрастает строго — строки упорядочены по времени');
      break;
    }
  }
  const order = keep.map((_, j) => j).sort((a, b) => times[a]! - times[b]!);
  const t0ms = times[order[0]!]!;
  const absolute = t0ms > 1e11;
  const t = Float64Array.from(order, (j) => (times[j]! - t0ms) / 1000);
  const ignore = new Set(opts.ignore ?? []);
  const columns: NormalizedTable['columns'] = [];
  const guesses: ColumnGuess[] = [];
  headers.forEach((name, ci) => {
    if (tcols.includes(ci) || ignore.has(name) || !name) return;
    const vals = Float64Array.from(order, (j) => parseCell(data[keep[j]!]![ci], decimal));
    const numeric = vals.filter(Number.isFinite).length;
    if (numeric < vals.length * 0.5) return;
    const g = guessColumn(name, vals, units?.[ci]);
    guesses.push(g);
    columns.push({ name, data: vals, ...(g.kind ? { kind: g.kind } : {}), ...(g.unit ? { unit: g.unit } : {}) });
  });
  const table: NormalizedTable = { t, columns, warnings };
  if (absolute) table.t0 = new Date(t0ms).toISOString();
  return { table, guesses, layout, timeColumns: tcols.map((i) => headers[i]!) };
}
