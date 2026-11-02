/// <reference lib="webworker" />
/** Воркер импорта: разбор файла и угадывание колонок вне основного потока (T-C05). */
import { draftMapping, importFile } from '@pipetwin/io';

self.onmessage = async (ev: MessageEvent<{ bytes: Uint8Array; name: string }>) => {
  const { bytes, name } = ev.data;
  try {
    const r = await importFile(bytes, name, { onProgress: (v) => self.postMessage({ type: 'progress', value: v }) });
    const draft = draftMapping(name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_.-]+/g, '_') || 'import', r.guesses, r.timeColumns);
    const info = `${r.format}${r.encoding ? `, ${r.encoding}` : ''}${r.delimiter ? `, разделитель «${r.delimiter === '\t' ? 'TAB' : r.delimiter}»` : ''}, десятичный «${r.decimal}»; строк: ${r.table.t.length}; длительность ${r.table.t.at(-1)?.toFixed(1) ?? 0} с; время: ${r.timeColumns.join(' + ')}${r.table.t0 ? `, начало ${r.table.t0}` : ''}${r.sheets ? `; лист «${r.sheets[0]?.name}»` : ''}`;
    self.postMessage({ type: 'done', result: { name, table: r.table, draft: draft.profile, questions: draft.questions, info } });
  } catch (e) {
    self.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
