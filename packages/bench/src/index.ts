// Публичный вход @pipetwin/bench: генераторы сценариев, раннер, метрики, наложение утечки.
export { SUITES, suiteE3, suiteE4, suiteE5, suiteE6, suiteRandom, suiteNoLeak, WARMUP_SEC, LEAK_T, type SuiteName, type SuiteOptions } from './scenarios';
export { runScenario, readJsonFromRoot, ROOT, type ScenarioResult, type RunOptions } from './runner';
export { defaultCandidates, strategyId } from './candidates';
export { computeMetrics, formatTable, toCsv, type StrategyMetrics } from './metrics';
export { overlayLeaks } from './overlay';
export { runJobs, jobKey, BENCH_VERSION, type Job, type JobResult } from './pool';
export { tuneScenario, BLOCK_SEC } from './tune';
