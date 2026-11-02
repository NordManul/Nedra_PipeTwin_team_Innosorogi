// Зона правды: знает об утечках. Импортировать из packages/detect запрещено (scripts/check-boundaries.mjs).
export { Plant, type ActiveLeak } from './plant';
export { SensorModel } from './sensors';
export { SimulatedSource, DEFAULT_LEAK_CD, type SimulatedSourceOptions } from './source';
export { createScenarioSource } from './scenario-source';
