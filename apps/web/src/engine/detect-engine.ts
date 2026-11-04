/**
 * Движок воркера детектора (без API воркера — тестируется в Node).
 * Получает только кадры датчиков; сам строит twin по конфигу трубы и ведёт выбранную стратегию.
 * Ничего из зоны правды (plant) не импортирует.
 */
import type { ActionRule, DetectorOutput, EventCard, PipelineConfig, RequirementCheck, SensorFrame, StrategySpec, TwinModel, TwinPrediction } from '@pipetwin/core/contracts';
import { calibrate, createTwin, getParam } from '@pipetwin/core';
import { buildEventCard, createDetector, defaultStrategy, REGISTRY, type DetectionPipeline, type EventClassifierModel, type KnnLocatorModel } from '@pipetwin/detect';
import locatorModel from '../../../../configs/models/locator.default.json';
import eventClassifierModel from '../../../../configs/models/event-classifier.default.json';

/** ML-оценка места первых секунд тревоги (H-B12); детектор сам проверит, что модель к этой трубе. */
const ML_LOCATOR = locatorModel as unknown as KnnLocatorModel;
/** ML «утечка или отказ датчика» перед подтверждением утечки (H-B19). */
const EVENT_CLASSIFIER = eventClassifierModel as unknown as EventClassifierModel;
import type { DetectMessage } from './protocol';

/** Сколько секунд кадров хранить для калибровки по запросу. */
const KEEP_SEC = 180;

export class DetectEngine {
  private config!: PipelineConfig;
  private twin!: TwinModel;
  private det!: DetectionPipeline;
  private strategy!: StrategySpec;
  private rules: ActionRule[] = [];
  private buffer: SensorFrame[] = [];
  private cards = new Map<string, { card: EventCard; at: number; state: string }>();
  private lastEvent: string | undefined;
  private cardSeq = 0;
  private nominalFlow = NaN;

  init(config: PipelineConfig, strategy: StrategySpec, rules: ActionRule[]): DetectMessage {
    this.config = config;
    this.rules = rules;
    this.buffer = [];
    this.twin = createTwin(config);
    this.setStrategy(strategy);
    const ctx = this.ctx();
    const checks: Record<string, RequirementCheck> = {};
    for (const name of Object.keys(REGISTRY)) if (name !== 'fusion') checks[name] = createDetector(defaultStrategy(name)).check(ctx);
    return { type: 'ready', strategy: this.strategy, checks };
  }

  private ctx() {
    return { config: this.config, sensors: this.config.sensors, sampleRateHz: this.config.sampling.rateHz, twin: this.twin };
  }

  setStrategy(strategy: StrategySpec): void {
    this.strategy = strategy;
    this.twin = createTwin(this.config);
    this.det = createDetector(strategy, { mlLocator: ML_LOCATOR, eventClassifier: EVENT_CLASSIFIER });
    const c = this.det.check(this.ctx());
    if (!c.ok) {
      // стратегия не подходит к датчикам — откат на порог по невязке
      this.strategy = defaultStrategy('threshold');
      this.det = createDetector(this.strategy, { mlLocator: ML_LOCATOR, eventClassifier: EVENT_CLASSIFIER });
    }
    this.det.reset(this.ctx());
    this.cards.clear();
    this.lastEvent = undefined;
  }

  get currentStrategy(): StrategySpec {
    return this.strategy;
  }

  frames(frames: SensorFrame[]): DetectMessage {
    const preds: TwinPrediction[] = [];
    const outs: DetectorOutput[] = [];
    const cards: EventCard[] = [];
    for (const f of frames) {
      this.buffer.push(f);
      const pred = this.twin.predict(f);
      const out = this.det.update(f, pred);
      preds.push(pred);
      outs.push(out);
      if (!Number.isFinite(this.nominalFlow) && out.phase !== 'warmup') this.nominalFlow = this.det.preprocessor.nominalFlow;
      cards.push(...this.updateCards(out));
    }
    const t = frames.at(-1)?.t ?? 0;
    while (this.buffer.length && this.buffer[0]!.t < t - KEEP_SEC) this.buffer.shift();
    return { type: 'batch', preds, outs, cards, ...(frames.length && this.twin.profile ? { twinProfile: this.twin.profile() } : {}) };
  }

  /**
   * Карточки: на каждую утечку своя (по списку активных утечек детектора) и на отказ датчика.
   * Карточка утечки создаётся в тик тревоги и уточняется раз в секунду, пока место уточняется;
   * при подтверждении — последний раз.
   */
  private updateCards(out: DetectorOutput): EventCard[] {
    const label = (id: string) => this.config.sensors.find((s) => s.id === id)?.label ?? id;
    const opts = { rules: this.rules, nominalFlow: this.nominalFlow, detector: this.strategy.strategy, sensorLabel: label };
    const res: EventCard[] = [];
    if (out.eventClass === 'sensor-fault' && this.lastEvent !== 'sensor-fault') res.push(buildEventCard(out, { ...opts, id: `ev${++this.cardSeq}` }));
    this.lastEvent = out.eventClass;
    for (const l of out.leaks ?? []) {
      const prev = this.cards.get(l.id);
      const due = !prev || (l.state === 'detecting' && out.t - prev.at >= 1) || prev.state !== l.state;
      if (!due) continue;
      const leakOut: DetectorOutput = {
        ...out,
        t: l.tAlarm,
        alarm: true,
        eventClass: l.state === 'confirmed' ? 'leak' : out.eventClass ?? 'leak',
        leaks: [l],
        ...(l.location !== undefined ? { location: l.location } : {}),
        ...(l.locationInterval ? { locationInterval: l.locationInterval } : {}),
        ...(l.locationStage ? { locationStage: l.locationStage } : {}),
        ...(l.leakRate !== undefined ? { leakRate: l.leakRate } : {}),
      };
      if (l.location === undefined) delete leakOut.location;
      const card = buildEventCard(leakOut, { ...opts, id: `ev-${l.id}` });
      const acked = prev?.card.acknowledgedAt;
      const c = { ...card, ...(acked !== undefined ? { acknowledgedAt: acked } : {}) };
      this.cards.set(l.id, { card: c, at: out.t, state: l.state });
      res.push(c);
    }
    for (const id of [...this.cards.keys()]) if (!(out.leaks ?? []).some((l) => l.id === id)) this.cards.delete(id);
    return res;
  }

  /** Калибровка по последним windowSec секундам (данные без утечки!). */
  calibrate(unknowns: string[], windowSec: number): DetectMessage {
    const t1 = this.buffer.at(-1)?.t ?? 0;
    const known = unknowns.filter((u) => getParam(this.config, u) !== undefined);
    const result = calibrate(this.buffer, { config: this.config, params: [], calibrationCandidates: [], warnings: [] }, { unknowns: known, window: [Math.max(0, t1 - windowSec), t1] });
    this.config = result.config;
    this.setStrategy(this.strategy);
    return { type: 'calibrated', result };
  }
}
