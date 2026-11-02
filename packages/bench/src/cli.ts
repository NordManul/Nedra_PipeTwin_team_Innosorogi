/**
 * Стенд экспериментов:
 *   npm run bench                       — полная матрица (E3, E5, длинные без утечки, случайные трубы)
 *   npm run bench -- --quick            — уменьшенная матрица (< 3 мин)
 *   npm run bench -- --suite e3,e4,e5,e6,random,noleak,files
 *   опции: --config <pipeline.json> --workers N --no-cache --no-tune --reuse-tuned --strategies <file.json> --out <runs.csv>
 * Шаги (ТЗ, раздел 14): 1) пороги на валидационных seed под FAR из selection.json;
 * 2) прогон тестовых seed с зафиксированными порогами → results/runs.csv. Выбор — python/analysis/select_strategy.py.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RUNS_CSV_COLUMNS, assertValid, type PipelineConfigInput, type RunRecord, type Scenario, type SelectionFile, type StrategySpec } from '@pipetwin/core';
import { scaleThreshold } from '@pipetwin/detect';
import { defaultCandidates, strategyId } from './candidates';
import { computeMetrics, formatTable, toCsv } from './metrics';
import { jobKey, runJobs, type Job } from './pool';
import { ROOT, readJsonFromRoot } from './runner';
import { SUITES, type SuiteName } from './scenarios';
import { pickScale, TUNE_SCALES } from './tune';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function progress(label: string) {
  let last = 0;
  return (done: number, total: number) => {
    const now = Date.now();
    if (done === total || now - last > 2000) {
      last = now;
      process.stderr.write(`\r${label}: ${done}/${total}${done === total ? '\n' : ''}`);
    }
  };
}

function fileScenarios(): Scenario[] {
  const dir = resolve(ROOT, 'configs/scenarios');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const s = JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as Scenario;
      assertValid('scenario', s, f);
      return s;
    });
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const quick = flag('quick');
  const cache = !flag('no-cache');
  const workers = opt('workers') ? Number(opt('workers')) : undefined;
  const selection = readJsonFromRoot('configs/selection.json') as SelectionFile;
  const pipeline = readJsonFromRoot(opt('config') ?? 'configs/pipeline.default.json') as PipelineConfigInput;
  const candidates: StrategySpec[] = opt('strategies') ? (readJsonFromRoot(opt('strategies')!) as StrategySpec[]) : defaultCandidates();
  const suites = (opt('suite') ?? (quick ? 'e3,e5,noleak,random' : 'e3,e5,noleak,random')).split(',') as Array<SuiteName | 'files'>;
  const base = { quick, pipeline, seeds: selection.seeds };
  mkdirSync(resolve(ROOT, 'results'), { recursive: true });

  // 1. калибровка порогов на валидационных прогонах без утечки (или пороги прошлой калибровки)
  let strategies = candidates;
  const tunedPath = resolve(ROOT, 'results/strategies.tuned.json');
  if (flag('reuse-tuned') && existsSync(tunedPath)) {
    strategies = (JSON.parse(readFileSync(tunedPath, 'utf8')) as { strategies: Array<{ spec: StrategySpec }> }).strategies.map((t) => t.spec);
    console.error(`пороги — из ${tunedPath}`);
  } else if (!flag('no-tune')) {
    // валидационные прогоны без утечки: обычный режим и смены режима (на них ложных тревог быть не должно)
    const tuneSet = [...SUITES.noleak({ ...base, split: 'validation' }), ...SUITES.e5({ ...base, split: 'validation' }).filter((s) => s.tags?.includes('noleak'))];
    const jobs: Job[] = tuneSet.map((scenario) => ({ kind: 'tune', key: jobKey('tune', scenario, candidates), scenario, strategies: candidates }));
    const res = await runJobs(jobs, { workers, cache, onProgress: progress('калибровка порогов') });
    const counts = new Map<string, number[]>();
    let observed = 0;
    for (const r of res) {
      if (r.kind !== 'tune') continue;
      observed += r.observedSec;
      for (const [id, c] of Object.entries(r.alarms)) counts.set(id, (counts.get(id) ?? TUNE_SCALES.map(() => 0)).map((v, i) => v + c[i]!));
    }
    const tuned = candidates.map((spec) => {
      const id = strategyId(spec);
      const c = counts.get(id) ?? TUNE_SCALES.map(() => 0);
      const scale = pickScale(c, observed, selection.targetFarPerDay);
      return { base: id, scale, alarmsByScale: Object.fromEntries(TUNE_SCALES.map((k, i) => [k, c[i]])), observedHours: Number((observed / 3600).toFixed(2)), spec: scaleThreshold(spec, scale) };
    });
    strategies = tuned.map((t) => t.spec);
    writeFileSync(
      resolve(ROOT, 'results/strategies.tuned.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), quick, targetFarPerDay: selection.targetFarPerDay, strategies: tuned.map((t) => ({ id: strategyId(t.spec), ...t })) }, null, 1) + '\n',
    );
  }

  // 2. тестовые прогоны с зафиксированными порогами
  const scenarios: Scenario[] = suites.flatMap((s) => (s === 'files' ? fileScenarios() : SUITES[s]({ ...base, split: 'test' })));
  const jobs: Job[] = scenarios.map((scenario) => ({ kind: 'run', key: jobKey('run', scenario, strategies), scenario, strategies }));
  const res = await runJobs(jobs, { workers, cache, onProgress: progress('прогоны') });
  const rows: RunRecord[] = [];
  const excluded: string[] = ['scenario_id,strategy_id,reasons'];
  for (const r of res) {
    if (r.kind !== 'run') continue;
    rows.push(...r.rows);
    for (const e of r.excluded) excluded.push(`${e.scenario_id},${e.strategy_id},"${e.reasons.join('; ')}"`);
  }
  rows.sort((a, b) => a.scenario_id.localeCompare(b.scenario_id) || a.strategy_id.localeCompare(b.strategy_id));
  const out = resolve(ROOT, opt('out') ?? 'results/runs.csv');
  writeFileSync(out, toCsv(rows, RUNS_CSV_COLUMNS));
  writeFileSync(resolve(ROOT, 'results/excluded.csv'), excluded.join('\n') + '\n');
  console.log(`\n${formatTable(computeMetrics(rows, selection))}\n`);
  console.log(`прогонов: ${rows.length} (${scenarios.length} сценариев × ${strategies.length} стратегий), выбыло по требованиям: ${excluded.length - 1}`);
  console.log(`результат: ${out}; время: ${((Date.now() - t0) / 1000).toFixed(0)} с`);
  console.log('дальше: python3 python/analysis/select_strategy.py');
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
