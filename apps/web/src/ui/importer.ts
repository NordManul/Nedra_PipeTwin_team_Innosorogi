/**
 * Мастер импорта записи (WP-C2): файл разбирается в отдельном воркере (большие файлы не морозят
 * интерфейс), колонки угадываются, человек подтверждает или правит привязку, кадры уходят в replay.
 */
import type { ColumnMapping, MappingProfile, NormalizedTable, SensorKind } from '@pipetwin/core/contracts';
import { clear, download, h } from './dom';

export interface ImportedFile {
  name: string;
  table: NormalizedTable;
  draft: MappingProfile;
  questions: Array<{ column: string; question: string }>;
  info: string;
}

export class Importer {
  private worker: Worker | null = null;

  constructor(private readonly host: HTMLElement, private readonly onApply: (table: NormalizedTable, profile: MappingProfile) => void) {
    this.renderIdle();
  }

  private renderIdle(msg?: string): void {
    clear(this.host);
    const inp = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.xlsx,.xlsm,.json' });
    inp.addEventListener('change', () => {
      const f = inp.files?.[0];
      if (f) void this.load(f);
    });
    this.host.append(
      h('p', { class: 'small muted' }, 'CSV / TSV / Excel / JSON с замерами датчиков. Кодировка, разделитель, строки заголовка и единиц, формат времени определяются автоматически.'),
      inp,
      msg ? h('p', { class: 'warn small' }, msg) : '',
    );
  }

  private async load(file: File): Promise<void> {
    clear(this.host);
    const progress = h('progress', { max: 1, value: 0 });
    this.host.append(h('p', {}, `Разбор «${file.name}»…`), progress);
    this.worker?.terminate();
    this.worker = new Worker(new URL('../engine/import.worker.ts', import.meta.url), { type: 'module' });
    const bytes = new Uint8Array(await file.arrayBuffer());
    this.worker.onmessage = (ev: MessageEvent<{ type: string; value?: number; result?: ImportedFile; message?: string }>) => {
      if (ev.data.type === 'progress') progress.value = ev.data.value ?? 0;
      else if (ev.data.type === 'done') this.renderMapping(ev.data.result!);
      else this.renderIdle(ev.data.message);
    };
    this.worker.postMessage({ bytes, name: file.name }, [bytes.buffer]);
  }

  private renderMapping(r: ImportedFile): void {
    clear(this.host);
    this.host.append(h('p', { class: 'small' }, r.info));
    if (r.questions.length) {
      const ul = h('ul', { class: 'warn small' });
      for (const q of r.questions) ul.append(h('li', {}, `${q.column}: ${q.question}`));
      this.host.append(h('p', { class: 'small' }, 'Проверьте:'), ul);
    }
    const rows: Array<{ m: ColumnMapping; use: HTMLInputElement; id: HTMLInputElement; kind: HTMLSelectElement; unit: HTMLInputElement; x: HTMLInputElement }> = [];
    const table = h('table', { class: 'params' }, h('tr', {}, h('th', {}, ''), h('th', {}, 'Колонка'), h('th', {}, 'id датчика'), h('th', {}, 'Род'), h('th', {}, 'Единица'), h('th', {}, 'x, м')));
    for (const m of r.draft.columns) {
      const use = h('input', { type: 'checkbox', checked: true });
      const id = h('input', { value: m.sensorId, size: 10 });
      const kind = h('select', {}, ...(['p', 'q', 'T'] as SensorKind[]).map((k) => h('option', { value: k, selected: k === m.kind }, k)));
      const unit = h('input', { value: m.unit, size: 7 });
      const x = h('input', { value: m.x !== undefined ? String(m.x) : '', size: 7, placeholder: '?' });
      rows.push({ m, use, id, kind, unit, x });
      table.append(h('tr', {}, h('td', {}, use), h('td', {}, m.source), h('td', {}, id), h('td', {}, kind), h('td', {}, unit), h('td', {}, x)));
    }
    const profile = (): MappingProfile => ({
      ...r.draft,
      columns: rows
        .filter((x) => x.use.checked)
        .map(({ m, id, kind, unit, x }) => ({ ...m, sensorId: id.value.trim(), kind: kind.value as SensorKind, unit: unit.value.trim(), ...(x.value.trim() ? { x: Number(x.value) } : {}) })),
    });
    this.host.append(
      h('div', { class: 'scroll' }, table),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'primary', onclick: () => this.onApply(r.table, profile()) }, 'Проиграть запись'),
        h('button', { onclick: () => download(`${r.draft.name}.json`, JSON.stringify({ $schema: '../../schemas/mapping.schema.json', ...profile() }, null, 2)) }, 'Сохранить профиль маппинга'),
        h('button', { onclick: () => this.renderIdle() }, 'Другой файл'),
      ),
    );
  }
}
