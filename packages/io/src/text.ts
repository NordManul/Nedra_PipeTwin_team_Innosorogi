/** Декодирование байтов, разбор CSV и чисел (WP-C1). Без зависимостей: работает в браузере и Node. */

export type Encoding = 'utf-8' | 'windows-1251';

/** UTF-8, если байты корректны, иначе cp1251 (типично для выгрузок SCADA). BOM снимается. */
export function decodeBytes(bytes: Uint8Array, encoding?: Encoding): { text: string; encoding: Encoding } {
  const strip = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
  if (encoding) return { text: strip(new TextDecoder(encoding).decode(bytes)), encoding };
  try {
    return { text: strip(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), encoding: 'utf-8' };
  } catch {
    return { text: strip(new TextDecoder('windows-1251').decode(bytes)), encoding: 'windows-1251' };
  }
}

export type Delimiter = ',' | ';' | '\t' | ' ';

/** Разбить текст на строки (CRLF, LF, CR), пустые хвосты отбрасываются. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
  return lines;
}

/** Разделитель: тот, что даёт одинаковое (и наибольшее) число полей в первых строках. */
export function detectDelimiter(lines: string[]): Delimiter {
  const sample = lines.filter((l) => l.trim()).slice(0, 50);
  let best: Delimiter = ',';
  let bestScore = -1;
  for (const d of [';', '\t', ',', ' '] as Delimiter[]) {
    const counts = sample.map((l) => parseCsvLine(l, d).length);
    const tail = counts.slice(Math.floor(counts.length / 3));
    const mode = modeOf(tail);
    if (mode < 2) continue;
    const agree = tail.filter((c) => c === mode).length / Math.max(1, tail.length);
    const score = agree * 10 + Math.min(mode, 50) / 50 - (d === ' ' ? 1 : 0);
    if (score > bestScore) [best, bestScore] = [d, score];
  }
  return best;
}

function modeOf(xs: number[]): number {
  const m = new Map<number, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  let best = 0;
  let n = -1;
  for (const [k, v] of m) if (v > n) [best, n] = [k, v];
  return best;
}

/** Одна строка CSV с кавычками («"a;b";c»). */
export function parseCsvLine(line: string, d: Delimiter): string[] {
  if (d === ' ') return line.trim().split(/\s+/);
  if (!line.includes('"')) return line.split(d).map((c) => c.trim());
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === d) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export function parseCsv(text: string, d?: Delimiter, onProgress?: (fraction: number) => void): { rows: string[][]; delimiter: Delimiter } {
  const lines = splitLines(text);
  const delimiter = d ?? detectDelimiter(lines);
  const rows: string[][] = new Array(lines.length);
  const step = Math.max(1, Math.floor(lines.length / 20));
  for (let i = 0; i < lines.length; i++) {
    rows[i] = parseCsvLine(lines[i]!, delimiter);
    if (onProgress && i % step === 0) onProgress(i / lines.length);
  }
  return { rows, delimiter };
}

export type DecimalSep = '.' | ',';

/** Десятичный разделитель по данным: запятая, если числа вида «1,23» встречаются, а «1.23» — нет. */
export function detectDecimal(rows: string[][], delimiter: Delimiter): DecimalSep {
  if (delimiter === ',') return '.';
  let comma = 0;
  let dot = 0;
  for (const r of rows.slice(0, 200)) {
    for (const c of r) {
      if (/^[+-]?\d+,\d+$/.test(c)) comma++;
      else if (/^[+-]?\d+\.\d+$/.test(c)) dot++;
    }
  }
  return comma > dot ? ',' : '.';
}

/**
 * Число из ячейки; NaN — не число. Пробелы между разрядами допустимы.
 * decimal ',' — «1 234,5» или «1.234,5»; decimal '.' — «1234.5» или «1,234.5».
 */
export function parseCell(s: string | undefined, decimal: DecimalSep): number {
  if (s === undefined) return NaN;
  let t = s.trim().replace(/[\u00a0\u202f ]/g, '');
  if (!t) return NaN;
  if (decimal === ',') {
    if (t.includes(',')) t = t.replace(/\./g, '');
    t = t.replace(',', '.');
  } else if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) {
    t = t.replace(/,/g, '');
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return NaN;
  return Number(t);
}

export function isNumeric(s: string | undefined, decimal: DecimalSep): boolean {
  return Number.isFinite(parseCell(s, decimal));
}
