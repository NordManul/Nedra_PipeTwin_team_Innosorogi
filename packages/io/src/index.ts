// Публичный вход @pipetwin/io: импорт чужих файлов, маппинг колонок, паспорт трубы, replay.
export { importFile, framesFromFile, type ImportOptions, type ImportResult, type FramesResult } from './import';
export { applyMapping, draftMapping, type ApplyContext, type MappingDraft } from './mapping';
export { buildTable, detectLayout, findTimeColumns, type Layout, type TableResult } from './table';
export { guessColumn, guessKind, unitFromHeader, positionFromName, unitFromMagnitude, type ColumnGuess } from './guess';
export { parseTime, parseDateTime, zonedToUtc, excelToWallMs, looksLikeTime } from './time';
export { decodeBytes, parseCsv, parseCsvLine, detectDelimiter, detectDecimal, parseCell, type Delimiter, type DecimalSep, type Encoding } from './text';
export { readWorkbook, rowsFromJson, writeFramesCsv, readFramesCsv, ReplaySource, type Sheet, type ReplayOptions } from './sources';
export { parsePassportText, parsePassportRows, type PassportResult } from './passport';
