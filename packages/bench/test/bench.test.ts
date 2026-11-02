/** Стенд: T-B15 (воспроизводимость), T-B16 (наложение утечки на запись), корректность генераторов. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig, validateFile, type PipelineConfigInput, type RunRecord, type Scenario } from '@pipetwin/core';
import { SimulatedSource } from '@pipetwin/core/plant';
import { defaultStrategy } from '@pipetwin/detect';
import { writeFramesCsv } from '@pipetwin/io';
import { ROOT, readJsonFromRoot, runScenario, SUITES } from '../src';

const pipeline = readJsonFromRoot('configs/pipeline.default.json') as PipelineConfigInput;
const seeds = { validation: [1, 2, 3, 4, 5], test: [101, 102, 103, 104, 105] };
const STRATEGIES = [{ ...defaultStrategy('cusum'), params: { drift: 0.5, h: 29 } }, defaultStrategy('threshold')];

const withoutCpu = (rows: RunRecord[]) => rows.map(({ cpu_ms_per_tick: _cpu, ...r }) => r);

describe('генераторы сценариев', () => {
  it('все наборы дают сценарии, проходящие схему, с уникальными id', () => {
    for (const [name, suite] of Object.entries(SUITES)) {
      const list = suite({ quick: true, split: 'test', pipeline, seeds });
      expect(list.length, name).toBeGreaterThan(0);
      expect(new Set(list.map((s) => s.id)).size, name).toBe(list.length);
      for (const s of list.slice(0, 5)) expect(validateFile('scenario', s), `${name}: ${s.id}`).toEqual([]);
    }
  });
});

describe('T-B15 воспроизводимость стенда', () => {
  it('два запуска с одними seed — одинаковые строки runs.csv (кроме времени CPU)', async () => {
    const sc = SUITES.e3({ quick: true, split: 'test', pipeline, seeds })[2]!;
    const a = await runScenario(sc, STRATEGIES);
    const b = await runScenario(sc, STRATEGIES);
    expect(withoutCpu(a.rows)).toEqual(withoutCpu(b.rows));
    expect(a.rows.every((r) => r.t_alarm !== null)).toBe(true);
  });
});

describe('T-B16 наложение утечки на запись без утечки', () => {
  it('время детекции на наложенной утечке в пределах 20% (или 2 с) от симуляции', async () => {
    // запись без утечки в «чужом» формате — нормализованный CSV кадров
    const truthInput = { ...pipeline, geometry: { ...(pipeline.geometry as object), roughness: '0,08 мм' } } as PipelineConfigInput;
    const cfg = resolveConfig(truthInput).config;
    const frames = new SimulatedSource(cfg, { seed: 303 }).step(130);
    const dir = resolve(ROOT, 'results/cache');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'overlay-test.csv'), writeFramesCsv(frames, cfg.sensors.map((s) => s.id)));
    const leak = { t: 65, type: 'leak' as const, id: 'L1', x: 25000, sizePct: 5, rampSec: 0 };
    const replay: Scenario = {
      schemaVersion: 1,
      id: 'overlay-test',
      pipeline: 'configs/pipeline.default.json',
      source: { type: 'replay', file: 'results/cache/overlay-test.csv', mapping: 'frames-si' },
      durationSec: 125,
      seed: 303,
      warmupSec: 60,
      events: [],
      overlayLeaks: [leak],
    };
    const sim: Scenario = { ...replay, id: 'overlay-sim', source: { type: 'simulated' }, truthOverrides: { geometry: { roughness: '0,08 мм' } }, events: [leak], overlayLeaks: undefined };
    const spec = [STRATEGIES[0]!];
    const [o, s] = await Promise.all([runScenario(replay, spec), runScenario(sim, spec)]);
    const ttdO = o.rows[0]!.ttd!;
    const ttdS = s.rows[0]!.ttd!;
    expect(ttdO).not.toBeNull();
    expect(ttdS).not.toBeNull();
    expect(Math.abs(ttdO - ttdS)).toBeLessThanOrEqual(Math.max(2, 0.2 * ttdS));
  });
});
