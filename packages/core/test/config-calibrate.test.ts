/** resolveConfig, примеры конфигов, калибровка T-A15, T-A16. */
import { describe, expect, it } from 'vitest';
import { calibrate } from '../src/calibrate/calibrate';
import { resolveConfig } from '../src/config/resolve';
import { validateFile } from '../src/config/validate';
import type { PipelineConfigInput, SensorFrame } from '../src/contracts';
import { withParam } from '../src/config/paths';
import { SimulatedSource } from '../src/plant/source';
import { constantPropsInput, readJson } from './helpers';

describe('resolveConfig', () => {
  it('конфиг только с длиной и диаметром даёт рабочую модель и кандидатов на калибровку', () => {
    const r = resolveConfig({ schemaVersion: 1, geometry: { length: '30 км', diameter: '0,4 м' } });
    expect(r.config.geometry.length).toBe(30000);
    expect(r.config.sensors.length).toBeGreaterThanOrEqual(7);
    expect(r.calibrationCandidates).toEqual(expect.arrayContaining(['geometry.roughness', 'thermal.heatTransferCoef']));
    const src = new SimulatedSource(r.config, { seed: 1 });
    const frames = src.step(5);
    expect(frames.length).toBe(51);
    expect(Object.values(frames[50]!.values).every(Number.isFinite)).toBe(true);
  });

  it('статусы: given для заданного, default для взятого из библиотеки', () => {
    const r = resolveConfig(readJson('configs/pipeline.example.json'));
    const st = (p: string) => r.params.find((x) => x.path === p)?.status;
    expect(st('geometry.length')).toBe('given');
    expect(st('geometry.roughness')).toBe('default');
    expect(st('geometry.wallModulus')).toBe('default');
    expect(st('thermal.heatTransferCoef')).toBe('default');
    expect(r.config.geometry.diameter).toBeCloseTo(0.514, 9);
    expect(r.config.sensors.find((s) => s.id === 'p_in')!.noiseStd).toBeCloseTo(1e4, 6);
    // «39 бар» — абсолютное давление
    expect(r.config.boundary.inlet).toEqual({ type: 'pressure', pressure: 3.9e6 });
  });

  it('все конфиги и сценарии из configs/ проходят свои схемы', () => {
    const files: Array<[Parameters<typeof validateFile>[0], string]> = [
      ['pipeline', 'configs/pipeline.default.json'],
      ['pipeline', 'configs/pipeline.example.json'],
      ['scenario', 'configs/scenarios/example-leak.json'],
      ['scenario', 'configs/scenarios/example-regime-no-leak.json'],
      ['strategy', 'configs/strategy.selected.json'],
      ['selection', 'configs/selection.json'],
      ['actions', 'configs/actions.json'],
      ['mapping', 'configs/mappings/example-scada.json'],
    ];
    for (const [kind, f] of files) expect(validateFile(kind, readJson(f)), f).toEqual([]);
  });
});

function framesFor(input: PipelineConfigInput, seconds: number, noiseScale = 1): SensorFrame[] {
  const cfg = resolveConfig(input).config;
  const src = new SimulatedSource(cfg, { seed: 11, noiseScale, events: [{ t: 20, type: 'pump', changePct: 8, rampSec: 5 }] });
  return src.step(seconds);
}

describe('T-A15 калибровка находит истину', () => {
  it('ε = 0,05 мм и k = 2 из старта 0,2 мм и 5 (шум 0,3% шкалы) — в пределах 5%', () => {
    const truthInput = readJson<PipelineConfigInput>('configs/pipeline.default.json');
    (truthInput.sensors as Array<Record<string, unknown>>).forEach((s) => {
      if (s.noisePct !== undefined) s.noisePct = 0.3;
    });
    const frames = framesFor(truthInput, 120);
    const resolved = resolveConfig(truthInput);
    let start = withParam(resolved.config, 'geometry.roughness', 0.2e-3);
    start = withParam(start, 'thermal.heatTransferCoef', 5);
    const res = calibrate(frames, { ...resolved, config: start }, { unknowns: ['geometry.roughness', 'thermal.heatTransferCoef'], window: [0, 120] });
    const eps = res.params.find((p) => p.path === 'geometry.roughness')!;
    const k = res.params.find((p) => p.path === 'thermal.heatTransferCoef')!;
    expect(eps.status).toBe('calibrated');
    expect(Math.abs(eps.value / 0.05e-3 - 1)).toBeLessThan(0.05);
    expect(Math.abs(k.value / 2 - 1)).toBeLessThan(0.05);
    expect(res.identifiability.rank).toBe(2);
  });
});

describe('T-A16 неидентифицируемость видна', () => {
  it('нет датчиков температуры и вязкость от температуры не зависит: k «не определяется», остаётся default', () => {
    const input = constantPropsInput();
    input.sensors = (input.sensors as Array<Record<string, unknown>>).filter((s) => s.kind !== 'T');
    input.numerics = { dx: 100, frictionModel: 'colebrook', thermalMode: 'quasi-steady' };
    const frames = framesFor(input, 60);
    const resolved = resolveConfig(input);
    const start = withParam(resolved.config, 'thermal.heatTransferCoef', 5);
    const res = calibrate(frames, { ...resolved, config: start }, { unknowns: ['geometry.roughness', 'thermal.heatTransferCoef'], window: [0, 60] });
    const k = res.params.find((p) => p.path === 'thermal.heatTransferCoef')!;
    expect(res.identifiability.unidentifiable).toContain('thermal.heatTransferCoef');
    expect(k.status).toBe('default');
    expect(k.warnings?.[0]).toMatch(/не определяется/);
    expect(res.params.find((p) => p.path === 'geometry.roughness')!.status).toBe('calibrated');
  });

  it('без датчиков температуры, но с вязкостью от температуры k определяется косвенно и с погрешностью', () => {
    const input = readJson<PipelineConfigInput>('configs/pipeline.default.json');
    input.sensors = (input.sensors as Array<Record<string, unknown>>).filter((s) => s.kind !== 'T');
    const frames = framesFor(input, 60);
    const resolved = resolveConfig(input);
    const start = withParam(resolved.config, 'thermal.heatTransferCoef', 5);
    const res = calibrate(frames, { ...resolved, config: start }, { unknowns: ['geometry.roughness', 'thermal.heatTransferCoef'], window: [0, 60] });
    const k = res.params.find((p) => p.path === 'thermal.heatTransferCoef')!;
    expect(k.status).toBe('calibrated');
    expect(Math.abs(k.value - 2)).toBeLessThan(3 * k.std!);
  });
});
