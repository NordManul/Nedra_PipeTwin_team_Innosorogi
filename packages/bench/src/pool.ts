/**
 * Параллельный пул на worker_threads с кэшем по хэшу (сценарий + стратегии + версия стенда):
 * прерванный прогон продолжается с места остановки, повторный — мгновенный.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Scenario, StrategySpec } from '@pipetwin/core';
import { ROOT, type ScenarioResult } from './runner';
import type { TuneJobResult } from './tune';

/** Меняйте при изменении логики стенда или детекторов, чтобы кэш не выдавал старое. */
export const BENCH_VERSION = 16;

export type Job =
  | { kind: 'run'; key: string; scenario: Scenario; strategies: StrategySpec[]; maxTtdSec?: number }
  | { kind: 'tune'; key: string; scenario: Scenario; strategies: StrategySpec[] };

export type JobResult = ({ kind: 'run'; key: string } & ScenarioResult) | ({ kind: 'tune'; key: string } & TuneJobResult) | { kind: 'error'; key: string; message: string };

export function jobKey(kind: Job['kind'], scenario: Scenario, strategies: StrategySpec[]): string {
  const pipe = typeof scenario.pipeline === 'string' ? readFileSync(resolve(ROOT, scenario.pipeline), 'utf8') : '';
  return createHash('sha1').update(JSON.stringify({ v: BENCH_VERSION, kind, scenario, strategies, pipe })).digest('hex');
}

export interface PoolOptions {
  workers?: number;
  cache?: boolean;
  onProgress?: (done: number, total: number) => void;
}

const CACHE_DIR = resolve(ROOT, 'results/cache');

export async function runJobs(jobs: Job[], opts: PoolOptions = {}): Promise<JobResult[]> {
  const useCache = opts.cache ?? true;
  if (useCache) mkdirSync(CACHE_DIR, { recursive: true });
  const results: JobResult[] = [];
  const todo: Job[] = [];
  for (const j of jobs) {
    const f = resolve(CACHE_DIR, `${j.key}.json`);
    if (useCache && existsSync(f)) results.push(JSON.parse(readFileSync(f, 'utf8')) as JobResult);
    else todo.push(j);
  }
  let done = results.length;
  opts.onProgress?.(done, jobs.length);
  if (!todo.length) return results;
  const n = Math.max(1, Math.min(opts.workers ?? Math.max(1, availableParallelism() - 1), todo.length));
  const errors: string[] = [];
  await new Promise<void>((resolveAll) => {
    let next = 0;
    let alive = n;
    for (let w = 0; w < n; w++) {
      const worker = new Worker(new URL('./worker-entry.mjs', import.meta.url));
      const feed = () => {
        if (next < todo.length) worker.postMessage(todo[next++]);
        else {
          void worker.terminate();
          if (--alive === 0) resolveAll();
        }
      };
      worker.on('message', (r: JobResult) => {
        if (r.kind === 'error') errors.push(r.message);
        else {
          results.push(r);
          if (useCache) writeFileSync(resolve(CACHE_DIR, `${r.key}.json`), JSON.stringify(r));
        }
        opts.onProgress?.(++done, jobs.length);
        feed();
      });
      worker.on('error', (e) => {
        errors.push(String(e));
        if (--alive === 0) resolveAll();
      });
      feed();
    }
  });
  if (errors.length) throw new Error(`ошибки в заданиях стенда:\n${errors.slice(0, 5).join('\n')}`);
  return results;
}
