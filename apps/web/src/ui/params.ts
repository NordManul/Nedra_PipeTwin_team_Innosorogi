/**
 * Параметры трубы (WP-C3): статусы given / default / calibrated, форма, построенная из
 * JSON Schema конфига (новое поле схемы появляется без правки интерфейса), разбор паспорта текстом,
 * загрузка конфига из файла.
 */
import type { ParamMeta, PipelineConfigInput } from '@pipetwin/core/contracts';
import pipelineSchema from '../../../../schemas/pipeline.schema.json';
import { clear, h } from './dom';
import { paramDisplay } from './format';

const STATUS_NAMES = { given: 'дано', default: 'по умолчанию', calibrated: 'откалибровано' } as const;

type SchemaNode = { properties?: Record<string, SchemaNode>; $ref?: string; description?: string; enum?: string[]; type?: string };

/** Простые поля формы из схемы: секция.поле → описание (величины и перечисления). */
export function formFields(): Array<{ path: string; label: string; enum?: string[] }> {
  const props = (pipelineSchema as SchemaNode).properties ?? {};
  const out: Array<{ path: string; label: string; enum?: string[] }> = [];
  for (const sec of ['geometry', 'thermal', 'sampling', 'numerics']) {
    const node = props[sec]?.properties ?? {};
    for (const [k, v] of Object.entries(node)) {
      if (v.$ref === '#/$defs/quantity' || v.enum) out.push({ path: `${sec}.${k}`, label: v.description ? `${k} — ${v.description}` : k, ...(v.enum ? { enum: v.enum } : {}) });
    }
  }
  out.push({ path: 'fluid.name', label: 'fluid.name — среда (light-crude, heavy-crude, diesel, water)' });
  return out;
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function setPath(obj: Record<string, unknown>, path: string, v: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
  if (v === undefined) delete cur[parts.at(-1)!];
  else cur[parts.at(-1)!] = v;
}

export interface ParamsHandlers {
  /** Применить новый входной конфиг (из формы, файла или паспорта). */
  apply(input: PipelineConfigInput): void;
  parsePassport(text: string): PipelineConfigInput;
  calibrate(): void;
}

export class ParamsPanel {
  private input: PipelineConfigInput | null = null;

  constructor(private readonly host: HTMLElement, private readonly handlers: ParamsHandlers) {}

  render(input: PipelineConfigInput, params: ParamMeta[], warnings: string[], candidates: string[]): void {
    this.input = input;
    clear(this.host);
    const counts = { given: 0, default: 0, calibrated: 0 };
    for (const p of params) counts[p.status]++;
    this.host.append(
      h('div', { class: 'panel-head' }, h('h3', {}, 'Параметры трубы'), h('button', { class: 'small', onclick: () => this.handlers.calibrate(), title: 'Подобрать параметры по последним 60 с без утечки' }, 'Откалибровать')),
      h('p', { class: 'muted small' }, `дано: ${counts.given} · по умолчанию: ${counts.default} · откалибровано: ${counts.calibrated}${candidates.length ? ` · кандидаты на калибровку: ${candidates.join(', ')}` : ''}`),
    );
    for (const w of warnings) this.host.append(h('p', { class: 'warn small' }, w));
    const table = h('table', { class: 'params' }, h('tr', {}, h('th', {}, 'Параметр'), h('th', {}, 'Значение'), h('th', {}, 'Статус'), h('th', {}, 'Источник')));
    for (const p of params.filter((x) => !x.path.startsWith('sensors.') || /noiseStd$/.test(x.path))) {
      table.append(
        h(
          'tr',
          {},
          h('td', {}, p.path),
          h('td', { title: p.original ?? '' }, paramDisplay(p.path, p.value)),
          h('td', {}, h('span', { class: `badge st-${p.status}` }, STATUS_NAMES[p.status])),
          h('td', { class: 'muted small' }, p.source ?? ''),
        ),
      );
    }
    this.host.append(h('div', { class: 'scroll' }, table));
    this.host.append(this.form(), this.passport(), this.fileLoad());
  }

  /** Форма из схемы: значения строками с единицами, флажок «не знаем» удаляет поле (→ default). */
  private form(): HTMLElement {
    const box = h('details', { class: 'sub' }, h('summary', {}, 'Изменить параметры (форма из схемы конфига)'));
    const inputs = new Map<string, { el: HTMLInputElement | HTMLSelectElement; unknown: HTMLInputElement }>();
    for (const f of formFields()) {
      const cur = getPath(this.input, f.path);
      const val = cur === undefined ? '' : typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
      const el = f.enum
        ? h('select', {}, h('option', { value: '' }, '—'), ...f.enum.map((o) => h('option', { value: o, selected: o === val }, o)))
        : h('input', { value: val, placeholder: 'например «50 км», «530 мм», «0,05 мм»' });
      const unknown = h('input', { type: 'checkbox', checked: cur === undefined, title: 'не знаем — взять по умолчанию' });
      inputs.set(f.path, { el, unknown });
      box.append(h('label', { class: 'field' }, h('span', { class: 'small' }, f.label), el, h('span', { class: 'small muted' }, unknown, ' не знаем')));
    }
    box.append(
      h(
        'button',
        {
          class: 'primary',
          onclick: () => {
            const next = structuredClone(this.input ?? { schemaVersion: 1 }) as Record<string, unknown>;
            for (const [path, { el, unknown }] of inputs) {
              const v = el.value.trim();
              if (unknown.checked || v === '') setPath(next, path, undefined);
              else {
                const num = Number(v);
                setPath(next, path, v.startsWith('[') || v.startsWith('{') ? JSON.parse(v) : Number.isFinite(num) && !/\s/.test(v) ? num : v);
              }
            }
            this.handlers.apply(next as unknown as PipelineConfigInput);
          },
        },
        'Применить',
      ),
    );
    return box;
  }

  private passport(): HTMLElement {
    const ta = h('textarea', { rows: 3, placeholder: 'Длина: 50 км, диаметр 530×8 мм, нефть 850 кг/м³, давление на входе 3,9 МПа' });
    return h(
      'details',
      { class: 'sub' },
      h('summary', {}, 'Паспорт трубы текстом'),
      ta,
      h('button', { onclick: () => this.handlers.apply(this.handlers.parsePassport(ta.value)) }, 'Разобрать и применить'),
    );
  }

  private fileLoad(): HTMLElement {
    const inp = h('input', { type: 'file', accept: '.json' });
    inp.addEventListener('change', async () => {
      const f = inp.files?.[0];
      if (f) this.handlers.apply(JSON.parse(await f.text()) as PipelineConfigInput);
    });
    return h('details', { class: 'sub' }, h('summary', {}, 'Загрузить конфиг трубы (JSON)'), inp);
  }
}
