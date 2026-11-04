/**
 * H-B19: ML-классификатор «утечка или отказ датчика» перед подтверждением утечки.
 * Тест знает правду из plant; детектор — только кадры.
 */
import { describe, expect, it } from 'vitest';
import { createTwin, type ScenarioEvent } from '@pipetwin/core';
import { SimulatedSource } from '@pipetwin/core/plant';
import { createDetector, leakProbability, type EventClassifierModel } from '../src';
import { ctxFor, defaultConfig, readJson } from './helpers';

const MODEL = readJson<EventClassifierModel>('configs/models/event-classifier.default.json');

function run(events: ScenarioEvent[], seed: number, withModel: boolean): { confirmed: boolean; fault: boolean } {
  const cfg = defaultConfig();
  const truth = structuredClone(cfg);
  truth.geometry.roughness = 8e-5;
  const src = new SimulatedSource(truth, { seed, events, durationSec: 420 });
  const twin = createTwin(cfg);
  const spec = readJson<Parameters<typeof createDetector>[0]>('configs/strategy.selected.json');
  const det = createDetector({ ...spec, warmupSec: 60 }, withModel ? { eventClassifier: MODEL } : {});
  det.reset(ctxFor(cfg, twin));
  let confirmed = false;
  let fault = false;
  while (!src.done) {
    for (const f of src.step(0.1)) {
      const o = det.update(f, twin.predict(f));
      if ((o.leaks ?? []).some((l) => l.state === 'confirmed')) confirmed = true;
      if (o.eventClass === 'sensor-fault' && f.t > 110) fault = true;
    }
  }
  return { confirmed, fault };
}

describe('H-B19 утечка или отказ датчика', () => {
  it('модель — дерево решений, лист «отказ» есть, вероятность в [0, 1]', () => {
    expect(MODEL.kind).toBe('tree');
    const f = { dominance: 0.95, othersAgree: 0, leakSum: 5, boundaryJump: 0.6, flowMoved: 4.5, flowOpposite: 1, waves: 0, fitExplained: 1 };
    const p = leakProbability(MODEL, f);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(MODEL.threshold);
  });

  it('скачок расходомера на входе +8σ: без модели — ложная утечка, с моделью — отказ датчика', () => {
    const ev: ScenarioEvent[] = [{ t: 120, type: 'sensor-fault', sensorId: 'q_in', mode: 'step', magnitude: 8, durationSec: 600 }];
    expect(run(ev, 2, false).confirmed).toBe(true);
    const r = run(ev, 2, true);
    expect(r.confirmed).toBe(false);
    expect(r.fault).toBe(true);
  }, 120_000);

  it('утечка 5% на 3 км (почти один расходомер видит её) с моделью подтверждается', () => {
    const r = run([{ t: 120, type: 'leak', x: 3000, sizePct: 5, rampSec: 0 }], 12, true);
    expect(r.confirmed).toBe(true);
  }, 120_000);
});
