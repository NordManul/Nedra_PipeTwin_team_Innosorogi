/**
 * Метрики стенда (ТЗ, раздел 13): TTD, POD, MDL, FAR, LOC, CPU, V_loss — по строкам runs.csv.
 * Те же определения, что в python/analysis/select_strategy.py (там — выбор и бутстрэп).
 */
import { quantile, type RunRecord, type SelectionFile } from '@pipetwin/core';

export interface StrategyMetrics {
  strategy_id: string;
  runs: number;
  ttd_med: number;
  ttd_p95: number;
  pod: Record<string, number>;
  mdl: number;
  far_per_day: number;
  loc_med: number;
  cpu_ms: number;
  v_loss_med: number;
}

export function computeMetrics(rows: RunRecord[], sel: Pick<SelectionFile, 'ttdMinLeakFraction' | 'mdlPod'>): StrategyMetrics[] {
  const by = new Map<string, RunRecord[]>();
  for (const r of rows) by.set(r.strategy_id, [...(by.get(r.strategy_id) ?? []), r]);
  const out: StrategyMetrics[] = [];
  for (const [id, rs] of by) {
    const leaks = rs.filter((r) => r.leak_present === 1);
    const ttds = leaks.filter((r) => r.ttd !== null && (r.leak_frac ?? 0) >= sel.ttdMinLeakFraction).map((r) => r.ttd!);
    const sizes = [...new Set(leaks.map((r) => r.leak_frac!))].sort((a, b) => a - b);
    const pod: Record<string, number> = {};
    for (const s of sizes) {
      const g = leaks.filter((r) => r.leak_frac === s);
      pod[String(s)] = g.filter((r) => r.t_alarm !== null).length / g.length;
    }
    const mdl = sizes.find((s) => sizes.filter((x) => x >= s).every((x) => pod[String(x)]! >= sel.mdlPod)) ?? Infinity;
    const fa = rs.reduce((a, r) => a + r.false_alarms, 0);
    const obs = rs.reduce((a, r) => a + (r.noleak_s ?? 0), 0);
    const locs = leaks.filter((r) => r.loc_err !== null).map((r) => r.loc_err!);
    const vl = leaks.filter((r) => r.v_loss !== null && r.t_alarm !== null).map((r) => r.v_loss!);
    out.push({
      strategy_id: id,
      runs: rs.length,
      ttd_med: ttds.length ? quantile(ttds, 0.5) : Infinity,
      ttd_p95: ttds.length ? quantile(ttds, 0.95) : Infinity,
      pod,
      mdl,
      far_per_day: obs > 0 ? (fa / obs) * 86400 : NaN,
      loc_med: locs.length ? quantile(locs, 0.5) : Infinity,
      cpu_ms: rs.reduce((a, r) => a + r.cpu_ms_per_tick, 0) / rs.length,
      v_loss_med: vl.length ? quantile(vl, 0.5) : NaN,
    });
  }
  return out.sort((a, b) => a.ttd_med - b.ttd_med);
}

export function formatTable(ms: StrategyMetrics[]): string {
  const head = ['стратегия', 'прогонов', 'TTD мед, с', 'TTD p95, с', 'MDL, %', 'FAR, 1/сут', 'LOC мед, м', 'CPU, мс'];
  const rows = ms.map((m) => [
    m.strategy_id.split(':')[0]!,
    String(m.runs),
    fmt(m.ttd_med, 1),
    fmt(m.ttd_p95, 1),
    Number.isFinite(m.mdl) ? (m.mdl * 100).toFixed(1) : '—',
    fmt(m.far_per_day, 2),
    fmt(m.loc_med, 0),
    m.cpu_ms.toFixed(3),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  return [head, ...rows].map((r) => r.map((c, i) => c.padEnd(w[i]!)).join('  ')).join('\n');
}

function fmt(v: number, d: number): string {
  return Number.isFinite(v) ? v.toFixed(d) : '—';
}

/** runs.csv: заголовок по RUNS_CSV_COLUMNS, пустая ячейка = null. */
export function toCsv(rows: RunRecord[], columns: readonly string[]): string {
  const cell = (v: unknown) => (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? '' : typeof v === 'number' ? String(Number(v.toPrecision(8))) : String(v));
  return [columns.join(','), ...rows.map((r) => columns.map((c) => cell((r as unknown as Record<string, unknown>)[c])).join(','))].join('\n') + '\n';
}
