import type { PipelineConfig, TwinModel } from '../contracts';
import { SteadyTwin } from './steady';
import { TransientTwin } from './transient';

export { SteadyTwin } from './steady';
export { TransientTwin } from './transient';
export { findEndSensors, sampleSensors, BoundaryInput } from './common';

/** Twin по настройке config.twin.model; готов к работе (reset уже вызван). */
export function createTwin(cfg: PipelineConfig): TwinModel {
  const twin: TwinModel = cfg.twin.model === 'steady' ? new SteadyTwin() : new TransientTwin();
  twin.reset(cfg);
  return twin;
}
