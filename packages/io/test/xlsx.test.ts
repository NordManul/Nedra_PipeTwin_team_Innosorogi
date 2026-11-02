/** Свой читатель .xlsx (packages/io/src/xlsx.ts): особенности настоящих выгрузок Excel. */
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readXlsx, writeXlsx } from '../src/xlsx';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';

/** Книга «как из Excel»: общие строки, связи листов, произвольный XML листа. */
function book(sheetXml: string, shared: string[] = [], name = 'Архив') {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8(`<workbook ${NS} xmlns:r="r"><sheets><sheet name="${name}" sheetId="1" r:id="rId7"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId7" Type="worksheet" Target="/xl/worksheets/data.xml"/></Relationships>'),
    'xl/sharedStrings.xml': strToU8(`<sst ${NS} count="${shared.length}">${shared.join('')}</sst>`),
    'xl/worksheets/data.xml': strToU8(`<worksheet ${NS}><sheetData>${sheetXml}</sheetData></worksheet>`),
  });
}

describe('чтение .xlsx', () => {
  it('общие строки с форматированием и фонетикой, сущности XML, числа, логические, формулы', () => {
    const shared = [
      '<si><t>Время</t></si>',
      '<si><r><rPr><b/></rPr><t>P_вх, </t></r><r><t xml:space="preserve">МПа</t></r><rPh sb="0" eb="1"><t>x</t></rPh></si>',
      '<si><t>A &amp; B &lt;1&gt; &#x41;&#66;</t></si>',
    ];
    const xml =
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
      '<row r="2" spans="1:4"/>' +
      '<row r="3"><c r="A3"><v>46333.5</v></c><c r="B3" s="2"><v>3.8999999999999999</v></c><c r="C3" t="b"><v>1</v></c><c r="D3" t="str"><f>A3*2</f><v>итог</v></c></row>';
    const [s] = readXlsx(book(xml, shared));
    expect(s!.name).toBe('Архив');
    expect(s!.rows).toEqual([
      ['Время', 'P_вх, МПа', 'A & B <1> AB'],
      [],
      ['46333.5', '3.9', 'TRUE', 'итог'],
    ]);
  });

  it('ячейки без адреса, таблица не с A1, встроенные строки, объединение', () => {
    const xml =
      '<row r="3"><c r="C3" t="inlineStr"><is><t>Замеры</t></is></c></row>' +
      '<row r="4"><c t="inlineStr"><is><t>t</t></is></c><c><v>1</v></c></row>' +
      '<row><c r="C5"><v>0.1</v></c><c r="D5"><v>2</v></c></row>' +
      '</sheetData><mergeCells count="1"><mergeCell ref="C3:D3"/></mergeCells><sheetData>';
    const [s] = readXlsx(book(xml));
    // строка 4 без адресов начинается с колонки A — таблица от A3
    expect(s!.rows).toEqual([
      ['', '', 'Замеры', 'Замеры'],
      ['t', '1'],
      ['', '', '0.1', '2'],
    ]);
  });

  it('старый .xls и .ods отклоняются с подсказкой пересохранить', () => {
    const xls = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    expect(() => readXlsx(xls)).toThrow(/пересохраните/);
    const ods = zipSync({ mimetype: strToU8('application/vnd.oasis.opendocument.spreadsheet'), 'content.xml': strToU8('<x/>') });
    expect(() => readXlsx(ods)).toThrow(/пересохраните/);
  });

  it('запись и чтение — то же самое', () => {
    const rows = [['Время', 'PT-101'], ['2026-11-07T07:00:00.000Z', 3.89012], ['x < y & "z"', -0.5]];
    const [a, b] = readXlsx(writeXlsx([{ name: 'Лист <1>', rows: [['пусто']] }, { name: 'Данные', rows }]));
    expect(a!.name).toBe('Лист <1>');
    expect(b!.rows).toEqual(rows.map((r) => r.map(String)));
  });
});
