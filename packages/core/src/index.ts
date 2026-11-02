// Публичный вход @pipetwin/core.
// Зона правды (plant) экспортируется отдельно: '@pipetwin/core/plant' — пакет detect её не импортирует.
export * from './contracts';
export * from './units';
export { evalSchedule, Ramp } from './schedule';
export { createFluid, waltherCoefficients, type FluidModel } from './fluid';
export { frictionFactor, frictionGradient, colebrook, haaland, swameeJain, RE_LAMINAR, RE_TURBULENT } from './friction';
export { resolveConfig, mergeConfigInput, type ResolveOptions } from './config/resolve';
export { validateFile, assertValid, ConfigError, type FileKind } from './config/validate';
export { getParam, withParam, setParamInPlace } from './config/paths';
export { FLUIDS, ROUGHNESS, HEAT_TRANSFER, DEFAULTS, defaultGridStep } from './config/library';
export { PipeModel, G } from './hydraulics/pipe';
export { steadyForward, steadyBackward, steadyFromPressures, nodeFlow, type SteadyProfile, type PointSink } from './hydraulics/steady';
export { MocSolver, type BoundarySpec, type NodeLeak } from './hydraulics/moc';
export { createTwin, SteadyTwin, TransientTwin, findEndSensors, sampleSensors } from './twin';
export { calibrate } from './calibrate/calibrate';
export { loadScenario, minDetectionTime, type LoadedScenario } from './scenario';
export { Rng } from './math/rng';
export { brent, findRoot } from './math/roots';
export { solve, inverse, symEig, gram, zeros, identity, type Matrix } from './math/linalg';
export { mean, variance, std, quantile, median, madSigma, interp, clamp } from './math/stats';
