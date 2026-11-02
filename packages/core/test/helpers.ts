import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../src/config/resolve';
import type { PipelineConfig, PipelineConfigInput } from '../src/contracts';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export function readJson<T = unknown>(rel: string): T {
  return JSON.parse(readFileSync(ROOT + rel, 'utf8')) as T;
}

export function defaultConfig(): PipelineConfig {
  return resolveConfig(readJson('configs/pipeline.default.json')).config;
}

/** Труба с постоянными свойствами — для сверки с аналитическими формулами. */
export function constantPropsInput(over: Partial<PipelineConfigInput> = {}): PipelineConfigInput {
  const L = Number((over.geometry as { length?: number } | undefined)?.length ?? 10000);
  return {
    schemaVersion: 1,
    geometry: { length: 10000, diameter: 0.5, wallThickness: 0.008, roughness: 5e-5, elevation: [[0, 0], [10000, 0]] },
    fluid: {
      name: 'water',
      phase: 'liquid',
      density: { model: 'constant', rho: 1000 },
      viscosity: { model: 'constant', nu: 1e-6 },
      heatCapacity: 4180,
      bulkModulus: 2.2e9,
      vaporPressure: 2339,
    },
    thermal: { ambientTemp: 278.15, heatTransferCoef: 2 },
    boundary: {
      inlet: { type: 'pressure', pressure: 3e6 },
      outlet: { type: 'pressure', pressure: 1e6 },
      inletTemp: 293.15,
    },
    sensors: [
      { id: 'p_in', kind: 'p', x: 0, noiseStd: 1000 },
      { id: 'q_in', kind: 'q', x: 0, noiseStd: 0.001 },
      { id: 'p_mid', kind: 'p', x: L / 2, noiseStd: 1000 },
      { id: 'p_out', kind: 'p', x: L, noiseStd: 1000 },
      { id: 'q_out', kind: 'q', x: L, noiseStd: 0.001 },
    ],
    numerics: { dx: 100, frictionModel: 'colebrook', thermalMode: 'none' },
    ...over,
  };
}
