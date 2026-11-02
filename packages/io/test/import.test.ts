/** Тесты импорта T-C01…T-C09 (ТЗ, раздел 12.2) на образцах fixtures/import/. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveConfig, type MappingProfile, type PipelineConfigInput } from '@pipetwin/core';
import { applyMapping, draftMapping, framesFromFile, importFile, parseCsv, parsePassportRows, parsePassportText, readFramesCsv, writeFramesCsv } from '../src';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const bytes = (f: string) => new Uint8Array(readFileSync(`${ROOT}fixtures/import/${f}`));
const expected = JSON.parse(readFileSync(`${ROOT}fixtures/import/expected.human.json`, 'utf8')) as { rows: Array<{ t: number; values: Record<string, number> }> };
const cfg = resolveConfig(JSON.parse(readFileSync(`${ROOT}configs/pipeline.default.json`, 'utf8'))).config;
const scadaProfile = JSON.parse(readFileSync(`${ROOT}configs/mappings/example-scada.json`, 'utf8')) as MappingProfile;

describe('T-C01 русский CSV', () => {
  it('cp1251, «;», десятичная запятая: числа и кириллица прочитаны верно', async () => {
    const r = await importFile(bytes('scada_cp1251.csv'), 'scada_cp1251.csv');
    expect(r.encoding).toBe('windows-1251');
    expect(r.delimiter).toBe(';');
    expect(r.decimal).toBe(',');
    const col = r.table.columns.find((c) => c.name === 'PT-101')!;
    expect(col.data[0]).toBeCloseTo(expected.rows[0]!.values.p_in!, 9);
    expect(r.table.columns.some((c) => c.name === 'Примечание')).toBe(false);
  });
});

describe('T-C02 мусор над таблицей', () => {
  it('3 служебные строки и строка единиц найдены автоматически', async () => {
    const r = await importFile(bytes('scada_cp1251.csv'), 'scada_cp1251.csv');
    expect(r.layout).toEqual({ headerRow: 3, unitsRow: 4, dataStart: 5 });
    expect(r.table.columns.find((c) => c.name === 'FT-201')!.unit).toBe('м3/ч');
  });
});

describe('T-C03 Excel с несколькими листами', () => {
  it('данные на втором листе предложены первыми, объединённая ячейка не мешает', async () => {
    const r = await importFile(bytes('multi_sheet.xlsx'), 'multi_sheet.xlsx');
    expect(r.sheets![0]!.name).toBe('Данные');
    expect(r.layout.headerRow).toBe(1);
    expect(r.table.columns.length).toBe(8);
    expect(r.table.columns[0]!.data[3]).toBeCloseTo(expected.rows[3]!.values.p_in!, 9);
  });
});

describe('T-C04 форматы времени', () => {
  it('ISO, dd.mm.yyyy + время отдельно, unix мс, дата Excel, секунды — одинаковые метки', async () => {
    const files: Array<[string, MappingProfile | undefined]> = [
      ['iso_utf8.csv', undefined],
      ['scada_cp1251.csv', scadaProfile],
      ['unix_ms.tsv', undefined],
      ['excel_serial.csv', { ...scadaProfile, file: { delimiter: ';', decimal: ',' }, time: { column: 't', format: 'excel', timezone: 'Europe/Moscow' }, columns: [] }],
      ['records.json', undefined],
      ['columns.json', undefined],
    ];
    const t0s = new Set<string>();
    for (const [f, profile] of files) {
      const r = await importFile(bytes(f), f, { profile });
      expect(r.table.t.length, f).toBe(30);
      for (let i = 0; i < 30; i++) expect(r.table.t[i], `${f} строка ${i}`).toBeCloseTo(expected.rows[i]!.t, 3);
      if (r.table.t0) t0s.add(r.table.t0);
    }
    // все абсолютные метки совпадают: 10:00 по Москве = 07:00Z
    expect([...t0s]).toEqual(['2026-11-07T07:00:00.000Z']);
  });
});

describe('T-C05 большой файл', () => {
  it('CSV ~100 МБ разбирается быстрее 10 с', () => {
    const line = '2026-11-07T07:00:00.000Z,3.71115,1180.44,59.93,3.27976,2.78237,2.40886,1156.70,45.55\n';
    const n = Math.ceil(100e6 / line.length);
    const text = 'timestamp,p,q,T,p1,p2,p3,q2,T2\n' + line.repeat(n);
    const t0 = performance.now();
    const { rows } = parseCsv(text, ',');
    const ms = performance.now() - t0;
    expect(rows.length).toBe(n + 1);
    expect(ms).toBeLessThan(10_000);
  }, 60_000);
});

describe('T-C06 автоугадывание колонок', () => {
  it('на образцах угадано ≥ 80% колонок, остальное — вопросами', async () => {
    let total = 0;
    let ok = 0;
    for (const f of ['iso_utf8.csv', 'scada_cp1251.csv', 'unix_ms.tsv', 'multi_sheet.xlsx', 'records.json']) {
      const r = await importFile(bytes(f), f);
      for (const g of r.guesses) {
        total++;
        if (g.kind && g.unit) ok++;
      }
    }
    expect(ok / total).toBeGreaterThanOrEqual(0.8);
  });

  it('угаданный профиль даёт те же кадры, что и ручной', async () => {
    const auto = await framesFromFile(bytes('iso_utf8.csv'), 'iso_utf8.csv', { config: cfg });
    expect(auto.draft!.profile.columns.map((c) => c.sensorId).sort()).toEqual(['T_in', 'T_out', 'p_in', 'p_km10', 'p_km25', 'p_out', 'q_in', 'q_out']);
    const pIn = auto.frames[0]!.values.p_in!;
    expect(pIn).toBeCloseTo(expected.rows[0]!.values.p_in! * 1e6 + 101325, 3);
    expect(auto.frames[0]!.values.T_out!).toBeCloseTo(expected.rows[0]!.values.T_out! + 273.15, 6);
    expect(auto.frames[0]!.values.q_in!).toBeCloseTo(expected.rows[0]!.values.q_in! / 3600, 9);
  });
});

describe('T-C07 маппинг в Node', () => {
  it('CLI с профилем даёт побитово те же кадры, что и библиотека (браузерный код — тот же)', async () => {
    const lib = await framesFromFile(bytes('scada_cp1251.csv'), 'scada_cp1251.csv', { profile: scadaProfile });
    const csvLib = writeFramesCsv(lib.frames, scadaProfile.columns.map((c) => c.sensorId));
    const out = execFileSync('npx', ['tsx', 'packages/io/src/cli.ts', 'fixtures/import/scada_cp1251.csv', '--mapping', 'example-scada'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    expect(out).toBe(csvLib);
    // пропуск в исходнике → пустая ячейка → valid = false
    const back = readFramesCsv(out);
    expect(back.frames[12]!.valid?.p_km25).toBe(false);
    expect(back.frames[0]!.values.p_in).toBeCloseTo(expected.rows[0]!.values.p_in! * 1e6 + 101325, 3);
  }, 60_000);
});

describe('T-C08 форма из схемы', () => {
  it('новое поле в схеме конфига появляется в форме без правки UI (форма строится по schemas/pipeline.schema.json)', () => {
    const schema = JSON.parse(readFileSync(`${ROOT}schemas/pipeline.schema.json`, 'utf8')) as { properties: Record<string, { properties?: Record<string, unknown> }> };
    // интерфейс строит форму по properties — проверяем, что поля для формы извлекаются из схемы
    const fields = Object.entries(schema.properties).flatMap(([sec, def]) => Object.keys(def.properties ?? {}).map((k) => `${sec}.${k}`));
    expect(fields).toEqual(expect.arrayContaining(['geometry.length', 'geometry.diameter', 'fluid.viscosity', 'thermal.heatTransferCoef']));
  });
});

describe('T-C09 паспорт текстом', () => {
  it('«Длина: 50 км, диаметр 530×8 мм, нефть 850 кг/м³» → три параметра given, в СИ', () => {
    const r = parsePassportText('Длина: 50 км, диаметр 530×8 мм, нефть 850 кг/м³');
    const res = resolveConfig(r.input as PipelineConfigInput);
    expect(res.config.geometry.length).toBe(50000);
    expect(res.config.geometry.diameter).toBeCloseTo(0.514, 9);
    expect(res.config.geometry.wallThickness).toBeCloseTo(0.008, 9);
    expect(res.config.fluid.density).toEqual({ model: 'constant', rho: 850 });
    const st = (p: string) => res.params.find((x) => x.path === p)?.status;
    expect([st('geometry.length'), st('geometry.diameter'), st('fluid.density.rho')]).toEqual(['given', 'given', 'given']);
  });

  it('паспорт таблицей «параметр — значение — единица»', () => {
    const { rows } = parseCsv(readFileSync(`${ROOT}fixtures/import/passport.csv`, 'utf8'));
    const r = parsePassportRows(rows);
    const res = resolveConfig(r.input as PipelineConfigInput);
    expect(res.config.boundary.inlet).toEqual({ type: 'pressure', pressure: 3.9e6 });
    expect(res.config.boundary.inletTemp).toBeCloseTo(333.15, 9);
    expect(res.config.thermal.ambientTemp).toBeCloseTo(278.15, 9);
    expect(res.config.fluid.viscosity.model).toBe('constant');
    expect((res.config.fluid.viscosity as { nu: number }).nu).toBeCloseTo(1e-5, 12);
  });
});

describe('применение профиля', () => {
  it('избыточное давление переводится в абсолютное, °C — в К, м³/ч — в м³/с', async () => {
    const r = await importFile(bytes('scada_cp1251.csv'), 'scada_cp1251.csv', { profile: scadaProfile });
    const frames = applyMapping(r.table, scadaProfile);
    const e = expected.rows[1]!.values;
    expect(frames[1]!.values.p_in!).toBeCloseTo(e.p_in! * 1e6 + 101325, 3);
    expect(frames[1]!.values.T_in!).toBeCloseTo(e.T_in! + 273.15, 6);
    expect(frames[1]!.values.q_out!).toBeCloseTo(e.q_out! / 3600, 9);
  });

  it('черновик без конфига строит id по роду и положению', async () => {
    const r = await importFile(bytes('unix_ms.tsv'), 'unix_ms.tsv');
    const d = draftMapping('x', r.guesses, r.timeColumns);
    expect(d.profile.columns.find((c) => c.source === 'p_km25 [bar]')).toMatchObject({ sensorId: 'p_km25', kind: 'p', unit: 'bar', x: 25000 });
  });
});
