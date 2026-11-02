/**
 * Движок воркера детектора (без API воркера — тестируется в Node).
 * Получает только кадры датчиков; сам строит twin по конфигу трубы и ведёт выбранную стратегию.
 * Ничего из зоны правды (plant) не импортирует.
 */
import type { ActionRule, DetectorOutput, EventCard, PipelineConfig, RequirementCheck, SensorFrame, StrategySpec, TwinModel, TwinPrediction } from '@pipetwin/core/contracts';
import { calibrate, createTwin, getParam } from '@pipetwin/core';
import { buildEventCard, createDetector, defaultStrategy, REGISTRY, type DetectionPipeline } from '@pipetwin/detect';
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
  private card: EventCard | null = null;
  private lastEvent: string | undefined;
  private cardAt = -Infinity;
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
    this.det = createDetector(strategy);
    const c = this.det.check(this.ctx());
    if (!c.ok) {
      // стратегия не подходит к датчикам — откат на порог по невязке
      this.strategy = defaultStrategy('threshold');
      this.det = createDetector(this.strategy);
    }
    this.det.reset(this.ctx());
    this.card = null;
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
      const card = this.updateCard(out);
      if (card) cards.push(card);
    }
    const t = frames.at(-1)?.t ?? 0;
    while (this.buffer.length && this.buffer[0]!.t < t - KEEP_SEC) this.buffer.shift();
    return { type: 'batch', preds, outs, cards, ...(frames.length && this.twin.profile ? { twinProfile: this.twin.profile() } : {}) };
  }

  /** Карточка: создаётся в тик тревоги (или события «отказ датчика»), пока тревога активна — обновляется раз в секунду. */
  private updateCard(out: DetectorOutput): EventCard | null {
    const label = (id: string) => this.config.sensors.find((s) => s.id === id)?.label ?? id;
    const opts = { rules: this.rules, nominalFlow: this.nominalFlow, detector: this.strategy.strategy, sensorLabel: label };
    const isFault = out.eventClass === 'sensor-fault' && this.lastEvent !== 'sensor-fault';
    this.lastEvent = out.eventClass;
    if ((out.alarm && !this.card) || isFault) {
      this.card = buildEventCard(out, { ...opts, id: `ev${++this.cardSeq}` });
      this.cardAt = out.t;
      if (isFault && !out.alarm) {
        const c = this.card;
        this.card = null;
        return c;
      }
      return this.card;
    }
    if (out.alarm && this.card && out.t - this.cardAt >= 1) {
      // уточнение: место и расход сходятся по мере прихода волн; время тревоги прежнее
      const updated = buildEventCard({ ...out, t: this.card.tAlarm, onsetTime: out.onsetTime }, { ...opts, id: this.card.id });
      if (updated.vLoss !== undefined && out.leakRate !== undefined) {
        updated.vLoss = out.leakRate * Math.max(0, this.card.tAlarm - (out.onsetTime ?? this.card.tAlarm));
        updated.vLossForecast30min = updated.vLoss + out.leakRate * 1800;
      }
      this.card = { ...updated, ...(this.card.acknowledgedAt !== undefined ? { acknowledgedAt: this.card.acknowledgedAt } : {}) };
      this.cardAt = out.t;
      return this.card;
    }
    if (!out.alarm) this.card = null;
    return null;
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
