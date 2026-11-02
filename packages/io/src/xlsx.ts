/**
 * Чтение и запись .xlsx без сторонних парсеров таблиц: книга — zip с XML (ECMA-376), распаковка — fflate.
 *
 * Своё вместо SheetJS из npm: у версии 0.18.5 известные уязвимости при чтении чужих файлов
 * (подмена прототипа, ReDoS), а исправленные версии в npm не публикуются. Нам нужно немного:
 * значения ячеек всех листов и объединённые ячейки шапки. Формулы не вычисляются — берётся
 * сохранённое значение. Старые .xls (BIFF) и .ods не читаются: их нужно пересохранить в .xlsx или CSV.
 *
 * Разбор XML — линейными регулярными выражениями без вложенных квантификаторов; размер распакованных
 * частей ограничен, чтобы «zip-бомба» не съела память вкладки.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

/** Лист как строки ячеек (значения — строками; числа — в записи JavaScript, даты — серийным числом Excel). */
export interface XlsxSheet {
  name: string;
  rows: string[][];
}

const MAX_PART_BYTES = 200 * 1024 * 1024;

function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e]!;
  });
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]!) : undefined;
}

/** Текст всех <t>…</t> внутри фрагмента (строка с форматированием состоит из нескольких прогонов). */
function textOf(xml: string): string {
  let out = '';
  // фонетические подсказки (<rPh>) — не часть значения
  for (const m of xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) out += m[1];
  return decodeXml(out);
}

/** «BC12» → [строка 11, столбец 54] (с нуля). */
function cellRef(ref: string): [number, number] | undefined {
  const m = /^([A-Z]{1,3})([0-9]{1,7})$/.exec(ref);
  if (!m) return undefined;
  let c = 0;
  for (const ch of m[1]!) c = c * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]) - 1, c - 1];
}

function resolveTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = ['xl'];
  for (const p of target.split('/')) {
    if (p === '..') parts.pop();
    else if (p !== '.') parts.push(p);
  }
  return parts.join('/');
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const grid: string[][] = [];
  let rowNo = -1;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = attr(rm[1] ?? '', 'r');
    rowNo = r ? Number(r) - 1 : rowNo + 1;
    const row: string[] = (grid[rowNo] = []);
    let colNo = -1;
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = cm[1] ?? '';
      const ref = attr(head, 'r');
      const pos = ref ? cellRef(ref) : undefined;
      colNo = pos ? pos[1] : colNo + 1;
      const body = cm[2] ?? '';
      const type = attr(head, 't') ?? 'n';
      const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
      let val = '';
      if (type === 's') val = v !== undefined ? shared[Number(v)] ?? '' : '';
      else if (type === 'inlineStr') val = textOf(body);
      else if (type === 'b') val = v === undefined ? '' : v === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'n') val = v === undefined || v === '' ? '' : String(Number(v));
      else val = v !== undefined ? decodeXml(v) : ''; // str (формула), e (ошибка), d (дата ISO)
      row[colNo] = val;
    }
  }
  // объединённые ячейки шапки («Давление» над двумя колонками): значение левой верхней — во все ячейки области.
  // Заголовок-баннер (в его строке больше ничего нет) не размножаем — иначе он выглядит как строка названий колонок.
  for (const mm of xml.matchAll(/<mergeCell\s[^>]*ref="([A-Z]+[0-9]+):([A-Z]+[0-9]+)"/g)) {
    const a = cellRef(mm[1]!);
    const b = cellRef(mm[2]!);
    if (!a || !b) continue;
    const src = grid[a[0]]?.[a[1]];
    if (src === undefined || src === '') continue;
    const banner = !(grid[a[0]] ?? []).some((v, c) => v !== undefined && v !== '' && (c < a[1] || c > b[1]));
    if (banner) continue;
    for (let r = a[0]; r <= b[0]; r++) for (let c = a[1]; c <= b[1]; c++) {
      const row = (grid[r] ??= []);
      if (row[c] === undefined || row[c] === '') row[c] = src;
    }
  }
  // плотная таблица от первой непустой строки и колонки (как диапазон листа), пропуски — ''
  let r0 = Infinity;
  let c0 = Infinity;
  grid.forEach((row, r) => {
    row?.forEach((v, c) => {
      if (v !== undefined && v !== '') {
        r0 = Math.min(r0, r);
        c0 = Math.min(c0, c);
      }
    });
  });
  if (!Number.isFinite(r0)) return [];
  const out: string[][] = [];
  for (let r = r0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    let last = row.length - 1;
    while (last >= c0 && (row[last] === undefined || row[last] === '')) last--;
    out.push(Array.from({ length: Math.max(0, last - c0 + 1) }, (_, i) => row[c0 + i] ?? ''));
  }
  while (out.length && out[out.length - 1]!.length === 0) out.pop();
  return out;
}

/** Прочитать .xlsx / .xlsm: листы в порядке книги. */
export function readXlsx(bytes: Uint8Array): XlsxSheet[] {
  if (!isZip(bytes)) {
    throw new Error('Excel: это не .xlsx (возможно, старый .xls или .ods) — пересохраните файл в .xlsx или CSV');
  }
  let total = 0;
  const files = unzipSync(bytes, {
    filter: (f) => {
      const want = f.name === 'xl/workbook.xml' || f.name === 'xl/_rels/workbook.xml.rels' || f.name === 'xl/sharedStrings.xml' || f.name.startsWith('xl/worksheets/');
      if (want) {
        total += f.originalSize;
        if (total > MAX_PART_BYTES) throw new Error('Excel: книга слишком большая после распаковки (больше 200 МБ)');
      }
      return want;
    },
  });
  const part = (name: string) => (files[name] ? strFromU8(files[name]!) : undefined);
  const wb = part('xl/workbook.xml');
  if (!wb) throw new Error('Excel: в архиве нет xl/workbook.xml — это не книга .xlsx (возможно, .ods) — пересохраните файл в .xlsx или CSV');

  const rels = new Map<string, string>();
  for (const m of (part('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\s[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) rels.set(id, resolveTarget(target));
  }
  const shared: string[] = [];
  for (const m of (part('xl/sharedStrings.xml') ?? '').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]!));

  const sheets: XlsxSheet[] = [];
  let k = 0;
  for (const m of wb.matchAll(/<sheet\s[^>]*>/g)) {
    k++;
    const name = attr(m[0], 'name') ?? `Лист${k}`;
    const rid = attr(m[0], 'r:id');
    const path = (rid && rels.get(rid)) || `xl/worksheets/sheet${k}.xml`;
    const xml = part(path);
    sheets.push({ name, rows: xml ? parseSheet(xml, shared) : [] });
  }
  return sheets;
}

// ---------------------------------------------------------------- запись (образцы для тестов, выгрузка)

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colName(c: number): string {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export interface XlsxSheetOut {
  name: string;
  rows: Array<Array<string | number>>;
  /** Объединённые области, например «A1:I1». */
  merges?: string[];
}

/** Записать простую книгу .xlsx: числа — числами, строки — встроенными строками. */
export function writeXlsx(sheets: XlsxSheetOut[]): Uint8Array {
  const sheetXml = (s: XlsxSheetOut) => {
    const rows = s.rows
      .map((row, r) => {
        const cells = row
          .map((v, c) => {
            const ref = `${colName(c)}${r + 1}`;
            if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${ref}"><v>${v}</v></c>` : '';
            return v === '' ? '' : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
          })
          .join('');
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join('');
    const merges = s.merges?.length ? `<mergeCells count="${s.merges.length}">${s.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData>${merges}</worksheet>`;
  };
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('')}</Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
        .map((s, i) => `<sheet name="${escXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}</Relationships>`,
    ),
  };
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s))));
  return zipSync(files, { level: 6 });
}
