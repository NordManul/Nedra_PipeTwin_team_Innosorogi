/**
 * Валидация файлов по общим JSON Schema из schemas/ (тем же, что использует Python).
 * Ошибки возвращаются человекочитаемым текстом «поле: причина» (T-A18).
 */
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import actionsSchema from '../../../../schemas/actions.schema.json';
import leakLabelsSchema from '../../../../schemas/leak-labels.schema.json';
import mappingSchema from '../../../../schemas/mapping.schema.json';
import pipelineSchema from '../../../../schemas/pipeline.schema.json';
import scenarioSchema from '../../../../schemas/scenario.schema.json';
import selectionSchema from '../../../../schemas/selection.schema.json';
import strategySchema from '../../../../schemas/strategy.schema.json';

export type FileKind = 'pipeline' | 'scenario' | 'strategy' | 'selection' | 'actions' | 'mapping' | 'leak-labels';

const SCHEMAS: Record<FileKind, object> = {
  pipeline: pipelineSchema,
  scenario: scenarioSchema,
  strategy: strategySchema,
  selection: selectionSchema,
  actions: actionsSchema,
  mapping: mappingSchema,
  'leak-labels': leakLabelsSchema,
};

let ajv: Ajv2020 | null = null;
const compiled = new Map<FileKind, ValidateFunction>();

function getValidator(kind: FileKind): ValidateFunction {
  let v = compiled.get(kind);
  if (v) return v;
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
    addFormats(ajv);
    for (const s of Object.values(SCHEMAS)) ajv.addSchema(s);
  }
  v = ajv.getSchema((SCHEMAS[kind] as { $id: string }).$id)!;
  compiled.set(kind, v);
  return v;
}

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[], what = 'конфиг') {
    super(`${what}: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function pathOf(e: ErrorObject): string {
  const p = e.instancePath.replace(/^\//, '').replace(/\//g, '.');
  return p || '(корень)';
}

function describe(e: ErrorObject): string {
  const p = pathOf(e);
  switch (e.keyword) {
    case 'required':
      return `${p}: нет обязательного поля «${(e.params as { missingProperty: string }).missingProperty}»`;
    case 'additionalProperties':
      return `${p}: неизвестное поле «${(e.params as { additionalProperty: string }).additionalProperty}»`;
    case 'enum':
      return `${p}: допустимые значения — ${(e.params as { allowedValues: unknown[] }).allowedValues.join(', ')}`;
    case 'const':
      return `${p}: должно быть ${JSON.stringify((e.params as { allowedValue: unknown }).allowedValue)}`;
    case 'type':
      return `${p}: ожидался тип ${(e.params as { type: string }).type}`;
    case 'minimum':
    case 'exclusiveMinimum':
    case 'maximum':
    case 'exclusiveMaximum':
      return `${p}: значение должно быть ${e.message}`;
    case 'pattern':
      return `${p}: недопустимый формат`;
    default:
      return `${p}: ${e.message ?? e.keyword}`;
  }
}

/**
 * Проверить данные по схеме. Возвращает список проблем (пустой — всё в порядке).
 * Из ошибок oneOf/anyOf оставляются самые информативные, без дублей.
 */
export function validateFile(kind: FileKind, data: unknown): string[] {
  const v = getValidator(kind);
  if (v(data)) return [];
  const errs = (v.errors ?? []).filter((e) => e.keyword !== 'oneOf' && e.keyword !== 'anyOf' && e.keyword !== 'if' && e.keyword !== 'not');
  const msgs = [...new Set((errs.length ? errs : v.errors ?? []).map(describe))];
  return msgs.slice(0, 12);
}

/** Проверить и бросить ConfigError с понятным текстом. */
export function assertValid(kind: FileKind, data: unknown, what: string = kind): void {
  const issues = validateFile(kind, data);
  if (issues.length) throw new ConfigError(issues, what);
}
