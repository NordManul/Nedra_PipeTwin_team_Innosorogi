/** Воркер стенда: выполняет задания пула (прогон сценария или сбор максимумов для калибровки). */
import { parentPort } from 'node:worker_threads';
import type { Job, JobResult } from './pool';
import { runScenario } from './runner';
import { tuneScenario } from './tune';

parentPort!.on('message', async (job: Job) => {
  try {
    const result: JobResult =
      job.kind === 'run'
        ? { kind: 'run', key: job.key, ...(await runScenario(job.scenario, job.strategies, { maxTtdSec: job.maxTtdSec })) }
        : { kind: 'tune', key: job.key, ...tuneScenario(job.scenario, job.strategies) };
    parentPort!.postMessage(result);
  } catch (e) {
    parentPort!.postMessage({ kind: 'error', key: job.key, message: `${job.scenario.id}: ${e instanceof Error ? e.stack ?? e.message : String(e)}` });
  }
});
