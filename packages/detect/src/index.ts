// Публичный вход @pipetwin/detect. Ничего из зоны правды (plant) этот пакет не импортирует.
export { DetectionPipeline, createDetector, defaultStrategy, requirementsOf, type PipelineOptions } from './pipeline';
export { REGISTRY, SIMPLICITY_ORDER } from './registry';
export { checkRequirements, mergeRequirements } from './requirements';
export { classifyEvent, type Signature, type SignatureInput } from './signature';
export { buildEventCard, confidenceOf, matchRule, renderTemplate, FORECAST_SEC, type ExplainOptions } from './explain';
export { autotune, blockMaxima, gumbelScale, scaleThreshold, type AutotuneOptions, type AutotuneResult } from './autotune';
export { Preprocessor, DEFAULT_PREPROCESS, type PreprocessOptions } from './preprocess';
export { LsqLocator, locateHgl, type LocationEstimate } from './localize';
export { DropTracker, type WaveSource } from './detectors/npw';
export { SUM, type PreparedSample, type Statistic, type StatOut, type StatContext, type DetectorMeta } from './types';
