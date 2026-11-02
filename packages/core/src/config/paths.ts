/**
 * Доступ к числовым параметрам PipelineConfig по пути через точку:
 * "geometry.roughness", "fluid.viscosity.nu0", "sensors.p_km10.bias".
 */
import type { PipelineConfig } from '../contracts';

type Obj = Record<string, unknown>;

function walk(cfg: PipelineConfig, path: string): { parent: Obj; key: string } | null {
  const parts = path.split('.');
  let cur: unknown = cfg;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (k === 'sensors' && i === 0) {
      const id = parts[++i]!;
      cur = cfg.sensors.find((s) => s.id === id);
    } else {
      cur = (cur as Obj | undefined)?.[k];
    }
    if (cur === undefined || cur === null) return null;
  }
  return { parent: cur as Obj, key: parts[parts.length - 1]! };
}

export function getParam(cfg: PipelineConfig, path: string): number | undefined {
  const w = walk(cfg, path);
  const v = w?.parent[w.key];
  return typeof v === 'number' ? v : undefined;
}

/** Копия конфига с изменённым параметром. */
export function withParam(cfg: PipelineConfig, path: string, value: number): PipelineConfig {
  const copy = structuredClone(cfg);
  setParamInPlace(copy, path, value);
  return copy;
}

export function setParamInPlace(cfg: PipelineConfig, path: string, value: number): void {
  const w = walk(cfg, path);
  if (!w) throw new Error(`нет параметра «${path}»`);
  w.parent[w.key] = value;
}
