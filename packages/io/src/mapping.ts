/**
 * Профиль маппинга (WP-C2): угаданный черновик и применение к таблице — кадры в СИ,
 * давление абсолютное. Один и тот же код в браузере (мастер) и в Node (CLI, стенд).
 */
import { toSI, type ColumnMapping, type MappingProfile, type NormalizedTable, type PipelineConfig, type SensorFrame, type SensorKind } from '@pipetwin/core';
import type { ColumnGuess } from './guess';

const DIM: Record<SensorKind, 'pressure' | 'temperature' | 'flow'> = { p: 'pressure', T: 'temperature', q: 'flow' };

export interface MappingDraft {
  profile: MappingProfile;
  /** Что спросить у человека, по колонкам. */
  questions: Array<{ column: string; question: string }>;
  /** Доля колонок, угаданных без вопросов. */
  autoShare: number;
}

/**
 * Черновик профиля по угаданным колонкам. Если передан конфиг трубы — колонка привязывается
 * к датчику того же рода в той же точке, иначе id строится из рода и положения.
 */
export function draftMapping(name: string, guesses: ColumnGuess[], timeColumns: string[], cfg?: PipelineConfig): MappingDraft {
  const L = cfg?.geometry.length;
  const used = new Set<string>();
  const columns: ColumnMapping[] = [];
  const questions: MappingDraft['questions'] = [];
  let auto = 0;
  for (const g of guesses) {
    for (const q of g.questions) questions.push({ column: g.name, question: q });
    if (!g.kind || !g.unit) continue;
    let x: number | undefined = typeof g.x === 'number' ? g.x : g.x === 'in' ? 0 : g.x === 'out' ? L : undefined;
    let id: string | undefined;
    if (cfg && x !== undefined) {
      id = cfg.sensors.find((s) => s.kind === g.kind && Math.abs(s.x - x!) < Math.max(cfg.numerics.dx, 1) && !used.has(s.id))?.id;
    }
    if (!id) {
      const base = x === 0 ? `${g.kind}_in` : x !== undefined && L !== undefined && x >= L ? `${g.kind}_out` : x !== undefined ? `${g.kind}_km${String(+(x / 1000).toFixed(1)).replace('.', '_')}` : `${g.kind}_${g.name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || columns.length}`;
      id = /^[A-Za-z]/.test(base) ? base : `s_${base}`;
      let k = 2;
      while (used.has(id)) id = `${base}_${k++}`;
    }
    used.add(id);
    const m: ColumnMapping = { source: g.name, sensorId: id, kind: g.kind, unit: g.unit };
    if (g.kind === 'p') m.pressureReference = /абс|abs|\(а\)/i.test(g.name) ? 'absolute' : 'gauge';
    if (x !== undefined) m.x = x;
    columns.push(m);
    if (!g.questions.length) auto++;
  }
  const profile: MappingProfile = {
    schemaVersion: 1,
    name,
    time: { column: timeColumns.length === 2 ? [timeColumns[0]!, timeColumns[1]!] : timeColumns[0] ?? 't', format: 'auto' },
    columns,
  };
  return { profile, questions, autoShare: guesses.length ? auto / guesses.length : 0 };
}

export interface ApplyContext {
  ambientPressure?: number;
  /** Плотность для перевода массового расхода. */
  density?: number;
}

/** Применить профиль к таблице: кадры датчиков в СИ (давление — абсолютное). */
export function applyMapping(table: NormalizedTable, profile: MappingProfile, ctx: ApplyContext = {}): SensorFrame[] {
  const pAtm = ctx.ambientPressure ?? 101325;
  const cols = profile.columns.map((m) => {
    const col = table.columns.find((c) => c.name === m.source);
    if (!col) throw new Error(`в таблице нет колонки «${m.source}» (профиль ${profile.name})`);
    // множитель и сдвиг единицы — один раз, а не на каждое значение
    const a = toSI(0, m.unit, DIM[m.kind], { density: ctx.density, ambientPressure: pAtm });
    const b = toSI(1, m.unit, DIM[m.kind], { density: ctx.density, ambientPressure: pAtm });
    const k = b.value - a.value;
    let off = a.value;
    if (m.kind === 'p' && !a.gauge && (m.pressureReference ?? 'gauge') === 'gauge') off += pAtm;
    return { id: m.sensorId, data: col.data, k, off };
  });
  const frames: SensorFrame[] = new Array(table.t.length);
  for (let i = 0; i < table.t.length; i++) {
    const values: Record<string, number> = {};
    let invalid: Record<string, boolean> | undefined;
    for (const c of cols) {
      const v = c.data[i]!;
      if (Number.isFinite(v)) values[c.id] = v * c.k + c.off;
      else (invalid ??= {})[c.id] = false;
    }
    frames[i] = invalid ? { t: table.t[i]!, values, valid: invalid } : { t: table.t[i]!, values };
  }
  return frames;
}
