import type { LoadedScenario } from '../scenario';
import { SimulatedSource } from './source';

/** Источник данных для сценария с симуляцией («настоящая» труба = конфиг + truthOverrides). */
export function createScenarioSource(s: LoadedScenario): SimulatedSource {
  if (s.scenario.source.type !== 'simulated') throw new Error('для replay-сценария источник создаёт packages/io');
  return new SimulatedSource(s.truth.config, {
    seed: s.scenario.seed,
    noiseScale: s.scenario.noiseScale ?? 1,
    events: s.scenario.events,
    durationSec: s.scenario.durationSec,
  });
}
