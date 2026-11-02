/**
 * Excel и JSON на входе, нормализованный CSV кадров на выходе, ReplaySource для записей.
 */
import type { DataSource, GroundTruth, LeakLabelsFile, SensorFrame, SensorSpec } from '@pipetwin/core';
import { parseCsv, splitLines } from './text';

// ---------------------------------------------------------------- Excel (SheetJS)

export interface Sheet {
  name: string;
  /** Номер листа в книге (с 0). */
  index: number;
  rows: string[][];
  /** Число строк, похожих на данные (для выбора листа). */
  dataRows: number;
}

/** Прочитать книгу Excel: листы со строками; объединённые ячейки шапки заполняются. Лучший лист — первым. */
export async function readWorkbook(bytes: Uint8Array): Promise<Sheet[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(bytes, { type: 'array', cellDates: false });
  const sheets: Sheet[] = wb.SheetNames.map((name, index) => {
    const ws = wb.Sheets[name]!;
    for (const m of ws['!merges'] ?? []) {
      const src = ws[XLSX.utils.encode_cell(m.s)];
      if (!src) continue;
      for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) ws[XLSX.utils.encode_cell({ r, c })] ??= { ...src };
    }
    const rows = (XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }) as unknown[][]).map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))));
    const dataRows = rows.filter((r) => r.filter((c) => c !== '' && Number.isFinite(Number(c))).length >= Math.max(2, r.length / 2)).length;
    return { name, index, rows, dataRows };
  });
  return sheets.sort((a, b) => b.dataRows - a.dataRows);
}

// ---------------------------------------------------------------- JSON

/** JSON → строки таблицы: массив записей [{t, p_in, …}] или колоночный формат {t: […], p_in: […]}. */
export function rowsFromJson(text: string): string[][] {
  const data: unknown = JSON.parse(text);
  if (Array.isArray(data)) {
    const keys = [...new Set(data.flatMap((r) => Object.keys(r as object)))];
    return [keys, ...data.map((r) => keys.map((k) => String((r as Record<string, unknown>)[k] ?? '')))];
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown[]>;
    const keys = Object.keys(obj).filter((k) => Array.isArray(obj[k]));
    const n = Math.max(...keys.map((k) => obj[k]!.length));
    return [keys, ...Array.from({ length: n }, (_, i) => keys.map((k) => String(obj[k]![i] ?? '')))];
  }
  throw new Error('JSON: ожидался массив записей или объект колонок');
}

// ---------------------------------------------------------------- нормализованный CSV кадров

/** Кадры → CSV: «t,<id>…», СИ, пустая ячейка — пропуск (docs/contracts.md, п. 5). */
export function writeFramesCsv(frames: SensorFrame[], ids?: string[]): string {
  const cols = ids ?? [...new Set(frames.flatMap((f) => Object.keys(f.values)))];
  const lines = [['t', ...cols].join(',')];
  for (const f of frames) {
    const row = [String(Number(f.t.toFixed(6)))];
    for (const id of cols) {
      const v = f.values[id];
      row.push(v === undefined || f.valid?.[id] === false ? '' : String(Number(v.toPrecision(10))));
    }
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

export function readFramesCsv(text: string): { frames: SensorFrame[]; ids: string[] } {
  const { rows } = parseCsv(text, ',');
  const [head, ...data] = rows;
  if (!head || head[0] !== 't') throw new Error('нормализованный CSV кадров должен начинаться с колонки «t»');
  const ids = head.slice(1);
  const frames = data.map((r) => {
    const values: Record<string, number> = {};
    let valid: Record<string, boolean> | undefined;
    ids.forEach((id, i) => {
      const c = r[i + 1];
      if (c === undefined || c === '') (valid ??= {})[id] = false;
      else values[id] = Number(c);
    });
    return valid ? { t: Number(r[0]), values, valid } : { t: Number(r[0]), values };
  });
  return { frames, ids };
}

export { splitLines };

// ---------------------------------------------------------------- ReplaySource

export interface ReplayOptions {
  /** Разметка утечек (для стенда и секундомера; детектору не передаётся). */
  labels?: LeakLabelsFile;
  /** Номинальная частота; по умолчанию — по медианному шагу записи. */
  sampleRateHz?: number;
}

/** Проигрывание записи как DataSource. Время записи сдвигается так, что первый кадр — t = 0. */
export class ReplaySource implements DataSource {
  readonly kind = 'replay' as const;
  readonly sensors: SensorSpec[];
  readonly sampleRateHz: number;
  private readonly frames: SensorFrame[];
  private readonly labels?: LeakLabelsFile;
  private i = 0;
  private time = 0;

  constructor(frames: SensorFrame[], sensors: SensorSpec[], opts: ReplayOptions = {}) {
    const t0 = frames[0]?.t ?? 0;
    this.frames = frames.map((f) => ({ ...f, t: f.t - t0 }));
    this.sensors = sensors;
    this.labels = opts.labels;
    const dts = this.frames.slice(1, 200).map((f, k) => f.t - this.frames[k]!.t).sort((a, b) => a - b);
    const med = dts[Math.floor(dts.length / 2)] ?? 0.1;
    this.sampleRateHz = opts.sampleRateHz ?? Math.round((1 / med) * 1000) / 1000;
  }

  get t(): number {
    return this.time;
  }

  get done(): boolean {
    return this.i >= this.frames.length;
  }

  get duration(): number {
    return this.frames.at(-1)?.t ?? 0;
  }

  step(dt: number): SensorFrame[] {
    const target = this.time + dt;
    const out: SensorFrame[] = [];
    while (this.i < this.frames.length && this.frames[this.i]!.t <= target + 1e-9) out.push(this.frames[this.i++]!);
    this.time = target;
    return out;
  }

  /** Перейти к моменту t (перемотка). */
  seek(t: number): void {
    this.time = t;
    this.i = this.frames.findIndex((f) => f.t > t);
    if (this.i < 0) this.i = this.frames.length;
  }

  reset(): void {
    this.seek(-1e-9);
    this.time = 0;
  }

  truth(): GroundTruth {
    return { leaks: this.labels?.leaks ?? [], regimeEvents: [] };
  }
}
