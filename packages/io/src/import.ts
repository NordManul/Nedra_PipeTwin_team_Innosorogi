/**
 * Единая точка импорта: любой файл (CSV/TSV/TXT, Excel, JSON) → нормализованная таблица →
 * (профиль маппинга) → кадры датчиков в СИ. Тот же код в браузере и Node.
 */
import type { MappingProfile, NormalizedTable, PipelineConfig, SensorFrame } from '@pipetwin/core';
import { applyMapping, draftMapping, type ApplyContext, type MappingDraft } from './mapping';
import { readWorkbook, rowsFromJson, type Sheet } from './sources';
import { buildTable, type Layout } from './table';
import type { ColumnGuess } from './guess';
import { decodeBytes, detectDecimal, parseCsv, type DecimalSep, type Delimiter, type Encoding } from './text';

export interface ImportOptions {
  /** Профиль маппинга: параметры разбора и привязка колонок. */
  profile?: MappingProfile;
  /** Лист Excel (имя или номер в книге); по умолчанию — лист с наибольшим числом строк данных. */
  sheet?: string | number;
  onProgress?: (fraction: number) => void;
}

export interface ImportResult {
  table: NormalizedTable;
  guesses: ColumnGuess[];
  layout: Layout;
  timeColumns: string[];
  format: 'csv' | 'excel' | 'json';
  encoding?: Encoding;
  delimiter?: Delimiter;
  decimal: DecimalSep;
  /** Листы книги Excel по убыванию «похожести на данные». */
  sheets?: Array<Pick<Sheet, 'name' | 'index' | 'dataRows'>>;
}

function ext(name: string): string {
  return name.toLowerCase().split('.').pop() ?? '';
}

export async function importFile(bytes: Uint8Array, fileName: string, opts: ImportOptions = {}): Promise<ImportResult> {
  const f = opts.profile?.file ?? {};
  let rows: string[][];
  let format: ImportResult['format'] = 'csv';
  let encoding: Encoding | undefined;
  let delimiter: Delimiter | undefined;
  let decimal: DecimalSep;
  let sheets: Sheet[] | undefined;
  const e = ext(fileName);
  if (e === 'xlsx' || e === 'xls' || e === 'xlsm' || e === 'ods') {
    format = 'excel';
    sheets = await readWorkbook(bytes);
    const want = opts.sheet ?? f.sheet;
    const sheet = typeof want === 'number' ? sheets.find((s) => s.index === want) : typeof want === 'string' ? sheets.find((s) => s.name === want) : sheets[0];
    if (!sheet) throw new Error(`в книге нет листа «${want}»`);
    rows = sheet.rows;
    decimal = f.decimal ?? detectDecimal(rows, ';');
  } else {
    const dec = decodeBytes(bytes, f.encoding);
    encoding = dec.encoding;
    if (e === 'json') {
      format = 'json';
      rows = rowsFromJson(dec.text);
      decimal = '.';
    } else {
      const parsed = parseCsv(dec.text, f.delimiter, opts.onProgress);
      rows = parsed.rows;
      delimiter = parsed.delimiter;
      decimal = f.decimal ?? detectDecimal(rows, delimiter);
    }
  }
  const time = opts.profile && opts.profile.time.format !== 'auto' ? opts.profile.time : opts.profile ? { ...opts.profile.time, format: 'auto' } : undefined;
  const layout: Partial<Layout> = {};
  if (f.headerRow !== undefined) layout.headerRow = f.headerRow;
  if (f.unitsRow !== undefined) layout.unitsRow = f.unitsRow;
  const built = buildTable(rows, decimal, { time, ignore: opts.profile?.ignore, layout });
  opts.onProgress?.(1);
  return {
    ...built,
    format,
    decimal,
    ...(encoding ? { encoding } : {}),
    ...(delimiter ? { delimiter } : {}),
    ...(sheets ? { sheets: sheets.map(({ name, index, dataRows }) => ({ name, index, dataRows })) } : {}),
  };
}

export interface FramesResult {
  frames: SensorFrame[];
  profile: MappingProfile;
  /** Черновик (если профиль не передан): вопросы к человеку. */
  draft?: MappingDraft;
  imported: ImportResult;
}

/** Файл → кадры. Без профиля — черновик по автоугадыванию (его надо подтвердить в мастере). */
export async function framesFromFile(
  bytes: Uint8Array,
  fileName: string,
  opts: ImportOptions & { config?: PipelineConfig; apply?: ApplyContext } = {},
): Promise<FramesResult> {
  const imported = await importFile(bytes, fileName, opts);
  let profile = opts.profile;
  let draft: MappingDraft | undefined;
  if (!profile) {
    draft = draftMapping(fileName.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_.-]+/g, '_') || 'import', imported.guesses, imported.timeColumns, opts.config);
    profile = draft.profile;
  }
  const frames = applyMapping(imported.table, profile, { ambientPressure: opts.config?.ambientPressure, ...opts.apply });
  return { frames, profile, imported, ...(draft ? { draft } : {}) };
}
