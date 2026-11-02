/**
 * Генератор образцов для тестов импорта (fixtures/import/). Одни и те же 30 кадров симулятора
 * записываются в разных «неприятных» форматах (WP-C1). Запуск: npx tsx scripts/make-import-fixtures.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveConfig } from '../packages/core/src';
import { SimulatedSource } from '../packages/core/src/plant';
import { writeXlsx } from '../packages/io/src/xlsx';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = resolve(ROOT, 'fixtures/import');
mkdirSync(OUT, { recursive: true });

const cfg = resolveConfig(JSON.parse(readFileSync(resolve(ROOT, 'configs/pipeline.default.json'), 'utf8'))).config;
const frames = new SimulatedSource(cfg, { seed: 2026 }).step(2.95);
const ATM = 101325;
const START_UTC = Date.UTC(2026, 10, 7, 7, 0, 0); // 10:00:00 по Москве
const ids = ['p_in', 'q_in', 'T_in', 'p_km10', 'p_km25', 'p_out', 'q_out', 'T_out'];
const tags: Record<string, string> = { p_in: 'PT-101', q_in: 'FT-201', T_in: 'TT-301', p_km10: 'PT-102', p_km25: 'PT-103', p_out: 'PT-104', q_out: 'FT-202', T_out: 'TT-302' };

// в «человеческих» единицах: давление избыточное, МПа; расход м³/ч; температура °C
const human = (id: string, v: number) => (id[0] === 'p' ? (v - ATM) / 1e6 : id[0] === 'q' ? v * 3600 : v - 273.15);
const fmt = (v: number, d: number, comma = false) => (comma ? v.toFixed(d).replace('.', ',') : v.toFixed(d));
const digits = (id: string) => (id[0] === 'p' ? 5 : id[0] === 'q' ? 2 : 2);
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const moscow = (ms: number) => new Date(ms + 3 * 3600_000);

// ожидаемые значения в СИ после импорта с учётом округления записи
const expected = frames.map((f, i) => ({
  t: Number((i * 0.1).toFixed(3)),
  values: Object.fromEntries(ids.map((id) => [id, Number(fmt(human(id, f.values[id]!), digits(id)))])),
}));
writeFileSync(resolve(OUT, 'expected.human.json'), JSON.stringify({ note: 'значения в единицах файлов: МПа изб., м³/ч, °C', rows: expected }, null, 1) + '\n');

// 1. SCADA: cp1251, «;», десятичная запятая, служебные строки, строка единиц, дата и время отдельно, пропуск
{
  const lines = [
    'Выгрузка архива ПЛК;;;;;;;;;;',
    'Объект: участок НПС-1 — НПС-2;;;;;;;;;;',
    'Период: 07.11.2026;;;;;;;;;;',
    ['Дата', 'Время', ...ids.map((id) => tags[id]), 'Примечание'].join(';'),
    ['', '', 'МПа', 'м3/ч', '°C', 'МПа', 'МПа', 'МПа', 'м3/ч', '°C', ''].join(';'),
  ];
  frames.forEach((f, i) => {
    const d = moscow(START_UTC + i * 100);
    const date = `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
    const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
    const vals = ids.map((id) => (i === 12 && id === 'p_km25' ? '' : fmt(human(id, f.values[id]!), digits(id), true)));
    lines.push([date, time, ...vals, i === 5 ? 'норма' : ''].join(';'));
  });
  const text = lines.join('\r\n') + '\r\n';
  const bytes = Uint8Array.from(text, (ch) => {
    const c = ch.charCodeAt(0);
    if (c < 128) return c;
    if (c >= 0x410 && c <= 0x44f) return c - 0x410 + 0xc0;
    if (c === 0x401) return 0xa8;
    if (c === 0x451) return 0xb8;
    if (c === 0xb0) return 0xb0;
    if (c === 0x2014) return 0x97;
    return 0x3f;
  });
  writeFileSync(resolve(OUT, 'scada_cp1251.csv'), bytes);
}

// 2. ISO-время, «,», заголовки с единицами в кавычках
{
  const head = ['timestamp', '"P_вх, МПа"', '"Q_вх, м3/ч"', '"T_вх, °C"', '"P км 10, МПа"', '"P км 25, МПа"', '"P_вых, МПа"', '"Q_вых, м3/ч"', '"T_вых, °C"'];
  const lines = [head.join(',')];
  frames.forEach((f, i) => lines.push([new Date(START_UTC + i * 100).toISOString(), ...ids.map((id) => fmt(human(id, f.values[id]!), digits(id)))].join(',')));
  writeFileSync(resolve(OUT, 'iso_utf8.csv'), lines.join('\n') + '\n');
}

// 3. unix мс, табуляция, единицы в квадратных скобках (давление в барах)
{
  const head = ['time', 'p_in [bar]', 'q_in [m3/h]', 'T_in [°C]', 'p_km10 [bar]', 'p_km25 [bar]', 'p_out [bar]', 'q_out [m3/h]', 'T_out [°C]'];
  const lines = [head.join('\t')];
  frames.forEach((f, i) => lines.push([String(START_UTC + i * 100), ...ids.map((id) => (id[0] === 'p' ? fmt(human(id, f.values[id]!) * 10, 4) : fmt(human(id, f.values[id]!), digits(id))))].join('\t')));
  writeFileSync(resolve(OUT, 'unix_ms.tsv'), lines.join('\n') + '\n');
}

// 4. дата Excel (сутки с 1899-12-30) в колонке времени
{
  const lines = [['t', ...ids.map((id) => `${tags[id]}`)].join(';')];
  frames.forEach((f, i) => {
    const wall = START_UTC + 3 * 3600_000 + i * 100;
    const serial = wall / 86400000 + 25569;
    lines.push([serial.toFixed(10).replace('.', ','), ...ids.map((id) => fmt(human(id, f.values[id]!), digits(id), true))].join(';'));
  });
  writeFileSync(resolve(OUT, 'excel_serial.csv'), lines.join('\n') + '\n');
}

// 5. Excel: данные на втором листе, объединённая ячейка-заголовок над таблицей
{
  const aoa: (string | number)[][] = [
    ['Замеры участка'],
    ['Время', ...ids.map((id) => tags[id]!)],
    ['', 'МПа', 'м3/ч', '°C', 'МПа', 'МПа', 'МПа', 'м3/ч', '°C'],
  ];
  frames.forEach((f, i) => aoa.push([new Date(START_UTC + i * 100).toISOString(), ...ids.map((id) => Number(fmt(human(id, f.values[id]!), digits(id))))]));
  const book = writeXlsx([
    { name: 'Описание', rows: [['Описание выгрузки'], ['Участок НПС-1 — НПС-2'], ['Единицы — во второй строке таблицы']] },
    { name: 'Данные', rows: aoa, merges: ['A1:I1'] },
  ]);
  writeFileSync(resolve(OUT, 'multi_sheet.xlsx'), book);
}

// 6. JSON: массив записей и колоночный формат (время — секунды от начала)
{
  const recs = frames.map((f, i) => ({ t: Number((i * 0.1).toFixed(1)), ...Object.fromEntries(ids.map((id) => [`${tags[id]}`, Number(fmt(human(id, f.values[id]!), digits(id)))])) }));
  writeFileSync(resolve(OUT, 'records.json'), JSON.stringify(recs, null, 1) + '\n');
  const cols: Record<string, number[]> = { t: recs.map((r) => r.t) };
  for (const id of ids) cols[tags[id]!] = recs.map((r) => (r as unknown as Record<string, number>)[tags[id]!]!);
  writeFileSync(resolve(OUT, 'columns.json'), JSON.stringify(cols) + '\n');
}

// 7. Паспорт «ключ — значение — единица» (как в учебном пакете P1)
writeFileSync(
  resolve(OUT, 'passport.csv'),
  ['Параметр;Значение;Единица', 'Длина участка;50;км', 'Диаметр;530×8;мм', 'Нефть, плотность;850;кг/м3', 'Вязкость;10;сСт', 'Давление на входе;3,9;МПа', 'Температура нефти;60;°C', 'Температура грунта;5;°C'].join('\n') + '\n',
);

console.log(`образцы записаны в ${OUT}`);
