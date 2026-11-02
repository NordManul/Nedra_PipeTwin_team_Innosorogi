/**
 * Движки интерфейса в Node (без браузера): T-C11, T-C15, T-C16, T-C17.
 * Тот же код работает в воркерах демо.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mergeConfigInput, resolveConfig, type ActionsFile, type DetectorOutput, type EventCard, type PipelineConfigInput, type Scenario, type StrategySpec } from '@pipetwin/core';
import { runScenario } from '@pipetwin/bench';
import { defaultStrategy } from '@pipetwin/detect';
import { DetectEngine } from '../src/engine/detect-engine';
import { SimEngine } from '../src/engine/sim-engine';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = <T>(p: string) => JSON.parse(readFileSync(ROOT + p, 'utf8')) as T;
const INPUT = read<PipelineConfigInput>('configs/pipeline.default.json');
const RULES = read<ActionsFile>('configs/actions.json').rules;
const TRUTH = { geometry: { roughness: '0,08 мм' } };
const STRATEGY: StrategySpec = { ...defaultStrategy('cusum'), params: { drift: 0.5, h: 29 } };

interface Demo {
  outs: DetectorOutput[];
  cards: EventCard[];
  sim: SimEngine;
  alarmAt: number | null;
}

/** Демо без браузера: воркер симуляции → (только кадры) → воркер детектора, шаг 50 мс модельного времени. */
function demo(actions: Array<{ at: number; run: (s: SimEngine) => void }>, until: number, seed = 7, strategy = STRATEGY): Demo {
  const sim = new SimEngine();
  const det = new DetectEngine();
  const twinCfg = resolveConfig(INPUT).config;
  sim.init(resolveConfig(mergeConfigInput(INPUT, TRUTH)).config, seed);
  det.init(twinCfg, strategy, RULES);
  const outs: DetectorOutput[] = [];
  const cards: EventCard[] = [];
  let t = 0;
  const todo = [...actions];
  while (t < until) {
    while (todo.length && todo[0]!.at <= t) todo.shift()!.run(sim);
    const b = sim.advance(0.05);
    if (b?.type !== 'batch') break;
    t = b.t;
    const r = det.frames(b.frames);
    if (r.type === 'batch') {
      outs.push(...r.outs);
      cards.push(...r.cards);
    }
  }
  const first = outs.find((o) => o.alarm);
  return { outs, cards, sim, alarmAt: first?.t ?? null };
}

function exportScenario(d: Demo, seed: number, duration: number): Scenario {
  return {
    schemaVersion: 1,
    id: 'demo-export-test',
    pipeline: INPUT,
    truthOverrides: TRUTH,
    source: { type: 'simulated' },
    durationSec: duration,
    seed,
    warmupSec: 60,
    split: 'demo',
    events: [...d.sim.recorded],
  };
}

describe('T-C16 сквозной сценарий', () => {
  it('конфиг → клик-утечка → тревога; смена режима без утечки → тревоги нет', () => {
    const leak = demo([{ at: 75, run: (s) => s.leak(23000, 5, 0) }], 100);
    expect(leak.alarmAt).not.toBeNull();
    expect(leak.alarmAt! - 75).toBeLessThan(10);
    const regime = demo([{ at: 75, run: (s) => s.control({ type: 'pump', changePct: 10, rampSec: 3 }) }, { at: 150, run: (s) => s.control({ type: 'valve', opening: 0.6, rampSec: 5 }) }], 260, 8);
    expect(regime.alarmAt).toBeNull();
  });
});

describe('T-C11 и T-C15: секундомер честный, экспорт сессии воспроизводится стендом', () => {
  it('одна сессия в демо и в стенде: тревога в то же модельное время (расхождение меньше одного тика)', async () => {
    const d = demo([{ at: 80, run: (s) => s.leak(31000, 3, 0) }], 120, 11);
    expect(d.alarmAt).not.toBeNull();
    const sc = exportScenario(d, 11, 120);
    const res = await runScenario(sc, [STRATEGY], { readJson: (p) => read(p) });
    const row = res.rows[0]!;
    expect(row.t_alarm).not.toBeNull();
    expect(Math.abs(row.t_alarm! - d.alarmAt!)).toBeLessThan(0.1);
    // секундомер интерфейса: тревога − начало утечки по правде plant
    const tLeak = d.sim.recorded[0]!.t;
    expect(Math.abs(row.ttd! - (d.alarmAt! - tLeak))).toBeLessThan(0.1);
  });
});

describe('T-C17 карточка события', () => {
  it('утечка 5% в середине: карточка в тот же тик, что и тревога', () => {
    const d = demo([{ at: 75, run: (s) => s.leak(25000, 5, 0) }], 180);
    const card = d.cards.find((c) => c.eventClass === 'leak' || c.eventClass === 'unknown')!;
    expect(card).toBeDefined();
    expect(card.tAlarm).toBe(d.alarmAt);
    expect(card.action.severity).toBe('critical');
    // по мере прихода волн карточка уточняется: появляются место и расход, рекомендация — по размеру
    const last = d.cards.filter((c) => c.id === card.id).at(-1)!;
    expect(last.location).toBeDefined();
    expect(Math.abs(last.location!.x - 25000)).toBeLessThan(3000);
  });

  it('отказ датчика: карточка «проверить прибор», тревоги об утечке нет', () => {
    const d = demo([{ at: 75, run: (s) => s.control({ type: 'sensor-fault', sensorId: 'p_km25', mode: 'step', magnitude: 8, durationSec: 200 }) }], 130);
    expect(d.alarmAt).toBeNull();
    const card = d.cards.find((c) => c.eventClass === 'sensor-fault')!;
    expect(card).toBeDefined();
    expect(card.action.text).toMatch(/проверку прибора/);
    expect(card.contributions[0]!.sensorId).toBe('p_km25');
  });
});
