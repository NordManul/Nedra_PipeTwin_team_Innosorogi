/**
 * DetectionPipeline — реализация контракта Detector для любой стратегии из strategy.selected.json:
 *   кадр + прогноз → предобработка → статистика детектора → сигнатурный фильтр → локализация → выход.
 * Детектор получает только DetectorContext, кадры датчиков и прогноз twin (граница честности).
 */
import type {
  Detector,
  DetectorContext,
  DetectorOutput,
  DetectorParams,
  DetectorPhase,
  DetectorRequirements,
  EventClass,
  LocalizationMethod,
  LocationStage,
  ActiveLeak,
  RequirementCheck,
  SensorFrame,
  StrategySpec,
  TwinPrediction,
} from '@pipetwin/core/contracts';
import { PipeModel } from '@pipetwin/core';
import { DropTracker } from './detectors/npw';
import { FusionStat } from './detectors/fusion';
import { LsqLocator, locateHgl, type LocationEstimate } from './localize';
import { Preprocessor, type PreprocessOptions } from './preprocess';
import { REGISTRY } from './registry';
import { checkRequirements, mergeRequirements } from './requirements';
import { classifyEvent, type FirstChange } from './signature';
import { SUM, type PreparedSample, type StatContext, type Statistic, type StatOut } from './types';
import { ewmaAlpha, RollingWindow } from './util';
import { KnnLocator, type KnnLocatorModel, type LocatorFeatures } from './ml/knn-locator';
import { ARRIVAL_SUSTAIN_SEC, ArrivalTracker, arrivalSources, twoWaves, type ArrivalSources } from './leaks/arrivals';
import { LEAK_GUARD_SCALE, LEAK_WINDOW_SEC, leakGuardFactor, RecoveryWatcher, SettleTracker } from './leaks/recovery';
import { acceptPair, fitOneOrTwo, ratesAt, SPLIT_MIN_SEP, splitDelta, type Shapes } from './leaks/split';
import { eventFeatures, leakProbability, type EventClassifierModel, type EventFeatureName } from './leaks/event-features';

export interface PipelineOptions {
  preprocess?: Partial<PreprocessOptions>;
  /**
   * Защита от переходных режимов (как в системах по API 1130): после скачка на конце трубы,
   * не похожего на утечку (насос, задвижка), порог умножается на guardFactor на время
   * guardTransits пробегов волны через трубу + 10 с. По умолчанию 1,5 и 1,5 (подобрано на E5).
   */
  guardFactor?: number;
  guardTransits?: number;
  /**
   * Сигнатура не нашла признаков утечки («неизвестно»): тревога, только если превышение держится
   * столько секунд подряд (по умолчанию 2). Отсекает выбросы шума, почти не задерживая утечки:
   * у них сигнатура почти всегда «утечка».
   */
  confirmSec?: number;
  /** Минимальная длительность тревоги, после которой она может сняться, с. */
  holdSec?: number;
  /** Не выдавать тревог (для autotune: нужна только статистика). */
  silent?: boolean;
  /** ML-модель места (configs/models/locator.*.json); без неё стадия ml не используется. */
  mlLocator?: KnnLocatorModel;
  /**
   * ML-модель «утечка или отказ датчика» (configs/models/event-classifier.*.json, H-B19): перед
   * подтверждением утечки событие с малой вероятностью утечки считается отказом датчика.
   */
  eventClassifier?: EventClassifierModel;
}

/** Подавлять тревогу как смену режима только при уверенной сигнатуре. */
const SUPPRESS_CONFIDENCE = 0.75;
/** Отказ датчика: |среднее z за 2 с|·√n одного канала выше FAULT_Z, остальные ниже QUIET_Z. */
const FAULT_Z = 6;
const QUIET_Z = 4;
/** Окно истории замеров для сигнатур, с. */
const HISTORY_SEC = 40;
/** Порог «активного» канала: среднее z за 2 с, нормированное на √n. */
const ACTIVE_Z = 3;
/** Запас «ячейки» датчика на неточность момента первого изменения, в секундах пробега волны. */
const SEGMENT_MARGIN_SEC = 1;
/** Порог интервала профиля: стоимость ≤ минимум + PROFILE_DELTA (подобран на стенде под покрытие 90%). */
const PROFILE_DELTA = 0.4;
/** Профиль — после затухания волн: через 1,7 пробега волны после тревоги (≈ 75 с на 50 км). */
const PROFILE_AFTER_TRANSITS = 1.7;
/** ML-оценка — только в первые 0,45 пробега (≈ 20 с на 50 км): позже без волны её покрытие падает. */
const ML_UNTIL_TRANSITS = 0.45;
/** Профиль — только при оценке утечки не меньше 1,5% расхода: у меньших на стенде он уверенно ошибался. */
const PROFILE_MIN_FRACTION = 0.015;
/** Расширение интервала по волне до покрытия 90%. */
const WAVE_WIDEN = 1.5;
/** Утечка подтверждается (вклад — в норму, детектор перевзводится) не раньше стольких пробегов волны после тревоги. */
const CONFIRM_AFTER_TRANSITS = 1.7;

export function requirementsOf(spec: StrategySpec): DetectorRequirements {
  if (spec.strategy === 'fusion') return mergeRequirements((spec.members ?? []).map((m) => REGISTRY[m.detector]!.requires));
  const meta = REGISTRY[spec.strategy];
  if (!meta) throw new Error(`неизвестный детектор «${spec.strategy}»`);
  return meta.requires;
}

function createStatistic(spec: StrategySpec, sc: StatContext, params: DetectorParams): Statistic {
  if (spec.strategy === 'fusion') {
    const members = (spec.members ?? []).map((m) => {
      const meta = REGISTRY[m.detector];
      if (!meta || m.detector === 'fusion') throw new Error(`fusion: недопустимый участник «${m.detector}»`);
      return { name: m.detector, stat: meta.create(sc, { ...meta.defaults, ...m.params }), weight: m.weight ?? 1 };
    });
    return new FusionStat(members, params, spec.fusionRule ?? 'weighted-sum');
  }
  return REGISTRY[spec.strategy]!.create(sc, params);
}

export class DetectionPipeline implements Detector {
  readonly name: string;
  readonly requires: DetectorRequirements;
  private readonly spec: StrategySpec;
  private readonly opts: PipelineOptions;
  private ctx!: DetectorContext;
  private params!: DetectorParams;
  private prep!: Preprocessor;
  private stat!: Statistic;
  private sc!: StatContext;
  private tracker: DropTracker | null = null;
  private lsq = new LsqLocator();
  private rawHist = new Map<string, RollingWindow>();
  private zHist = new Map<string, RollingWindow>();
  private last: DetectorOutput | null = null;
  private alarmed = false;
  private alarmStart = NaN;
  private eventClass: EventClass | undefined;
  private eventUntil = -Infinity;
  private holdUntil = NaN;
  private unknownSince = NaN;
  private faultHoldSec = 5;
  private location: LocationEstimate | null = null;
  private waveEst: LocationEstimate | null = null;
  /** Стадии места: отрезок по первому изменению (сразу при тревоге), волна, профиль — для диагностики и стенда. */
  private segEst: LocationEstimate | null = null;
  /** Моменты прихода волны (первого спада давления) по датчикам в текущем событии. */
  private arrival = new ArrivalTracker();
  private profEst: LocationEstimate | null = null;
  private profCosts: number[] | null = null;
  private mlEst: LocationEstimate | null = null;
  private locStage: LocationStage = 'segment';
  /** Отрезок построен по первому изменению (волна от утечки видна на датчиках). */
  private segByArrival = false;
  /** Подтверждённые утечки: вклад в невязки учтён в норме; ждём их устранения. */
  private confirmed: Array<ActiveLeak & { delta: Record<string, number> }> = [];
  private leakSeq = 0;
  private leakId = '';
  private zLong = new Map<string, RollingWindow>();
  private recoverAt = -Infinity;
  /** Какие подтверждённые утечки сняли. */
  private recovery = new RecoveryWatcher();
  /** Идёт снятие утечек: скачки на концах трубы не считаем сменой режима. */
  private removalUntil = -Infinity;
  /** Две волны в текущем событии (одновременные утечки) — по временам прихода. */
  private multi: ArrivalSources | null = null;
  private multiKey = '';
  /** Установился ли отклик текущего события. */
  private settle = new SettleTracker();
  /** Уровень сырых замеров «до события» (момент тревоги) и шум — для признаков события. */
  private alarmPre = new Map<string, { pre: number; noise: number; n: number }>();
  private readonly sigma = (id: string): number | undefined => this.prep.sigmaOf(id);
  private leakGuardUntil = -Infinity;
  private leakGuardFactor = 1.5;
  /** Последняя выданная оценка расхода текущего события — её же хранит подтверждённая утечка. */
  private lastRate: number | undefined;
  private ml: KnnLocator | null = null;
  private locatedAt = -Infinity;
  private flowImbalance = NaN;
  private onset: number | undefined;
  private guardUntil = -Infinity;
  private faultSince = new Map<string, number>();
  private guardSec = 60;
  private lastRegimeT = -Infinity;

  constructor(spec: StrategySpec, opts: PipelineOptions = {}) {
    this.spec = spec;
    this.opts = opts;
    this.name = spec.strategy;
    this.requires = requirementsOf(spec);
  }

  check(ctx: DetectorContext): RequirementCheck {
    return checkRequirements(this.requires, ctx);
  }

  reset(ctx: DetectorContext, params: DetectorParams = {}): void {
    this.ctx = ctx;
    const meta = REGISTRY[this.spec.strategy]!;
    this.params = { ...meta.defaults, ...this.spec.params, ...params };
    this.prep = new Preprocessor(ctx, { warmupSec: this.spec.warmupSec, ...this.opts.preprocess });
    const waveSpeed = new PipeModel(ctx.config).waveSpeed();
    this.sc = { ctx, prep: this.prep, binSec: this.prep.opts.binSec, waveSpeed };
    this.stat = createStatistic(this.spec, this.sc, this.params);
    const ps = ctx.sensors.filter((s) => s.kind === 'p').sort((a, b) => a.x - b.x);
    this.tracker = ps.length >= 2 ? new DropTracker(this.sc, 1, 5, 5, 0.6) : null;
    // удержание одиночного сигнала: время пробега волны до соседнего датчика + запас
    let maxGap = 0;
    for (let i = 1; i < ps.length; i++) maxGap = Math.max(maxGap, ps[i]!.x - ps[i - 1]!.x);
    this.faultHoldSec = Math.min(20, Math.max(3, maxGap / waveSpeed + 2));
    this.guardSec = ((this.opts.guardTransits ?? 1.5) * ctx.config.geometry.length) / waveSpeed + 10;
    this.guardUntil = -Infinity;
    this.lastRegimeT = -Infinity;
    this.faultSince.clear();
    this.unknownSince = NaN;
    this.lsq = new LsqLocator();
    this.rawHist.clear();
    this.zHist.clear();
    this.zLong.clear();
    this.confirmed = [];
    this.leakSeq = 0;
    this.leakId = '';
    this.recoverAt = -Infinity;
    this.recovery.reset();
    this.removalUntil = -Infinity;
    this.settle.reset();
    this.leakGuardUntil = -Infinity;
    this.last = null;
    this.alarmed = false;
    this.eventClass = undefined;
    this.holdUntil = NaN;
    this.location = null;
    this.waveEst = null;
    this.segEst = null;
    this.profEst = null;
    this.profCosts = null;
    this.mlEst = null;
    const ml = this.opts.mlLocator;
    this.ml = ml && KnnLocator.fits(ml, ctx.config.geometry.length, ctx.sensors.map((v) => v.id)) ? new KnnLocator(ml) : null;
    this.flowImbalance = NaN;
    this.onset = undefined;
  }

  /**
   * Признаки для ML-оценки места (ml/knn-locator.ts): только то, что видит детектор.
   * Доступны во время тревоги; вне тревоги — null.
   */
  locatorFeatures(t: number): LocatorFeatures | null {
    if (!this.alarmed) return null;
    const z: Record<string, number> = {};
    for (const [id, w] of this.zHist) if (w.length) z[id] = w.mean();
    const first: Record<string, number | undefined> = Object.fromEntries(this.arrival.times);
    return { z, first, sinceAlarm: t - this.alarmStart, transit: this.ctx.config.geometry.length / this.sc.waveSpeed };
  }

  /** Текущие оценки места по стадиям (диагностика, стенд). */
  get locationStages(): { segment: LocationEstimate | null; wave: LocationEstimate | null; profile: LocationEstimate | null; ml: LocationEstimate | null } {
    return { segment: this.segEst, wave: this.waveEst, profile: this.profEst, ml: this.mlEst };
  }

  get effectiveParams(): DetectorParams {
    return { ...this.params };
  }

  /** Доступ к предобработке (для autotune и интерфейса: σ, статусы датчиков). */
  get preprocessor(): Preprocessor {
    return this.prep;
  }

  update(frame: SensorFrame, pred: TwinPrediction | null): DetectorOutput {
    for (const s of this.prep.push(frame, pred)) this.last = this.process(s);
    return this.last ?? { t: frame.t, phase: 'warmup', alarm: false, score: 0 };
  }

  private remember(s: PreparedSample): void {
    const n = Math.round(HISTORY_SEC / this.sc.binSec);
    for (const [id, v] of Object.entries(s.raw)) {
      let w = this.rawHist.get(id);
      if (!w) this.rawHist.set(id, (w = new RollingWindow(n)));
      w.push(v);
    }
    const nz = Math.max(1, Math.round(2 / this.sc.binSec));
    const nl = Math.max(1, Math.round(LEAK_WINDOW_SEC / this.sc.binSec));
    for (const [id, z] of Object.entries(s.z)) {
      let w = this.zHist.get(id);
      if (!w) this.zHist.set(id, (w = new RollingWindow(nz)));
      w.push(z);
      let wl = this.zLong.get(id);
      if (!wl) this.zLong.set(id, (wl = new RollingWindow(nl)));
      wl.push(z);
    }
  }

  private activeChannels(): string[] {
    const out: string[] = [];
    for (const [id, w] of this.zHist) if (Math.abs(w.mean()) * Math.sqrt(w.length) > ACTIVE_Z) out.push(id);
    return out;
  }

  /**
   * Окно «до события» в истории (номера отсчётов от конца): самые старые 10 с из HISTORY_SEC.
   * Оценка момента начала у статистик запаздывает, поэтому привязываться к ней ненадёжно.
   */
  private preWindow(avail: number): [number, number] | null {
    const bin = this.sc.binSec;
    const preTo = avail;
    const preFrom = Math.max(Math.round(4 / bin), avail - Math.round(10 / bin));
    return preTo - preFrom >= 5 ? [preFrom, preTo] : null;
  }

  /** Изменение замеров «сейчас − до события» в долях шума изменения. */
  private deltas(): Record<string, number> {
    const nPost = Math.round(2 / this.sc.binSec);
    const out: Record<string, number> = {};
    for (const [id, w] of this.rawHist) {
      const win = this.preWindow(w.length);
      const noise = this.prep.rawStats(id)?.noise;
      if (!win || !noise) continue;
      const pre = w.meanRange(win[0], win[1]);
      const post = w.meanRange(0, nPost);
      out[id] = (post - pre) / (noise * Math.sqrt(1 / nPost + 1 / (win[1] - win[0])));
    }
    return out;
  }

  /**
   * Первое значимое изменение каждого датчика после «до события»: скользящее среднее за 1 с
   * отошло от уровня до события дальше 4σ своего шума. Нужно сигнатуре: волна идёт от источника.
   */
  private firstChanges(t: number, sustainSec = 0): Record<string, FirstChange> {
    const bin = this.sc.binSec;
    const nMa = Math.max(1, Math.round(1 / bin));
    const out: Record<string, FirstChange> = {};
    const delta = this.deltas();
    for (const [id, w] of this.rawHist) {
      // учитываем только устойчивое изменение: сейчас уровень значимо отличается от «до»
      const d = delta[id];
      if (d === undefined || Math.abs(d) < 3) continue;
      const win = this.preWindow(w.length);
      const noise = this.prep.rawStats(id)?.noise;
      if (!win || !noise) continue;
      const pre = w.meanRange(win[0], win[1]);
      const lim = (4 * noise) / Math.sqrt(nMa);
      const nSus = Math.round(sustainSec / bin);
      for (let i = win[0] - nMa; i >= 0; i--) {
        const ma = w.meanRange(i, i + nMa);
        if (Math.abs(ma - pre) > lim && Math.sign(ma - pre) === Math.sign(d)) {
          // устойчивость: следующие sustainSec скользящее среднее не возвращается за половину порога
          let held = true;
          for (let k = 1; k <= nSus && i - k >= 0 && held; k++) {
            const m2 = w.meanRange(i - k, i - k + nMa);
            if (!(Math.sign(m2 - pre) === Math.sign(d) && Math.abs(m2 - pre) > lim / 2)) held = false;
          }
          if (!held) continue;
          out[id] = { t: t - (i + nMa / 2) * bin, sign: Math.sign(d) };
          break;
        }
      }
    }
    return out;
  }

  /** Скачок замера: среднее за 1 с минус среднее за 5 с перед ним, в долях шума разности. */
  private step(id: string | undefined): number {
    if (!id) return 0;
    const w = this.rawHist.get(id);
    const noise = this.prep.rawStats(id)?.noise;
    const bin = this.sc.binSec;
    const nS = Math.round(1 / bin);
    const nL = Math.round(5 / bin);
    if (!w || !noise || w.length < nS + nL) return 0;
    return (w.meanRange(0, nS) - w.meanRange(nS, nS + nL)) / (noise * Math.sqrt(1 / nS + 1 / nL));
  }

  /**
   * Режимное событие на конце трубы: скачок давления на входе или выходе, не похожий на утечку
   * (у утечки у входа давление падает при росте расхода, у выхода — падают оба).
   */
  private watchRegime(t: number): void {
    const L = this.ctx.config.geometry.length;
    const at = (k: 'p' | 'q', x: number) => this.ctx.sensors.find((v) => v.kind === k && v.x === x)?.id;
    const ends: Array<{ p?: string; q?: string; leakLike: (dp: number, dq: number) => boolean; cls: EventClass }> = [
      { p: at('p', 0), q: at('q', 0), leakLike: (dp, dq) => dp < 0 && dq > 2, cls: 'pump-change' },
      { p: at('p', L), q: at('q', L), leakLike: (dp, dq) => dp < 0 && dq < -2, cls: 'valve-change' },
    ];
    for (const e of ends) {
      const dp = this.step(e.p);
      if (Math.abs(dp) < 6) continue;
      const dq = this.step(e.q);
      if (e.leakLike(dp, dq)) continue;
      // снятие подтверждённых утечек: давление на конце растёт без явного манёвра (на входе расход не растёт,
      // на выходе не падает) — это не смена режима, его распознает watchRecovery; переходный процесс от снятия
      // идёт ещё минуты, поэтому окно держится и после восстановления
      if ((this.confirmed.length || t < this.removalUntil) && dp > 0 && (e.cls === 'pump-change' ? dq <= 2 : dq >= -2)) {
        this.removalUntil = Math.max(this.removalUntil, t + this.guardSec);
        continue;
      }
      if (t < this.removalUntil) continue;
      // во время тревоги класс события не меняем: спад давления от самой утечки, дошедший до конца
      // трубы раньше, чем отреагировал инерционный расходомер, похож на манёвр задвижки
      if (t - this.lastRegimeT > 5 && !this.alarmed) {
        this.setEvent(e.cls, t);
        // новая рабочая точка: накопленное до события больше не относится к делу
        this.stat.rearm();
      }
      this.lastRegimeT = t;
      this.guardUntil = Math.max(this.guardUntil, t + this.guardSec);
    }
  }

  /**
   * Монитор отказов (WP-B1, T-B07): ровно один датчик сильно отклонился от модели (в любую сторону),
   * остальные спокойны, и так дольше времени пробега волны до соседа — это прибор, а не труба.
   */
  private watchSensorFaults(t: number): void {
    const level = new Map<string, number>();
    for (const [id, w] of this.zHist) if (w.length) level.set(id, Math.abs(w.mean()) * Math.sqrt(w.length));
    const big = [...level].filter(([, v]) => v > FAULT_Z);
    const quiet = [...level].every(([id, v]) => v < QUIET_Z || big.some(([b]) => b === id));
    if (big.length !== 1 || !quiet) {
      this.faultSince.clear();
      return;
    }
    const id = big[0]![0];
    // во время тревоги отклонение в сторону утечки — её отклик, а не отказ: утечку у конца трубы видит почти
    // один расходомер, и исключать его нельзя — без него не будет ни места, ни баланса для распознавания снятия
    if (this.alarmed && (this.prep.signs.get(id) ?? 0) * (this.zHist.get(id)?.mean() ?? 0) > 0) {
      this.faultSince.clear();
      return;
    }
    const since = this.faultSince.get(id) ?? t;
    this.faultSince.set(id, since);
    if (t - since >= this.faultHoldSec) {
      this.prep.exclude(id);
      this.zHist.delete(id);
      this.setEvent('sensor-fault', t);
      if (!this.alarmed) this.stat.rearm();
      this.faultSince.clear();
      this.holdUntil = NaN;
    }
  }

  /** Идёт ли переходный режим после смены режима перекачки. */
  inTransientGuard(t: number): boolean {
    return t < this.guardUntil;
  }

  private updateFlowImbalance(s: PreparedSample): void {
    const L = this.ctx.config.geometry.length;
    const qi = this.ctx.sensors.find((x) => x.kind === 'q' && x.x === 0);
    const qo = this.ctx.sensors.find((x) => x.kind === 'q' && x.x === L);
    if (!qi || !qo || s.z[qi.id] === undefined || s.z[qo.id] === undefined) return;
    const di = s.z[qi.id]! * this.prep.sigmaOf(qi.id)!;
    const dout = s.z[qo.id]! * this.prep.sigmaOf(qo.id)!;
    const v = di - dout;
    this.flowImbalance = Number.isFinite(this.flowImbalance) ? this.flowImbalance + ewmaAlpha(s.dt, 3) * (v - this.flowImbalance) : v;
  }

  /**
   * Место утечки. Первая оценка — по времени прихода волны (L3): она точна сразу, а стационарные
   * методы до затухания волн ошибаются. Оценка L3 запоминается на всё событие.
   * После установления (1,5 пробега волны) — выбранный в стратегии метод, сглаженный по времени.
   */
  private locate(s: PreparedSample, out: StatOut): void {
    if (this.tracker && !this.waveEst) {
      const src = this.tracker.source();
      if (src) {
        // интервал по точности времени прихода, расширенный ×1,5 до покрытия 90% (стенд, H-B13)
        const half = ((src.interval[1] - src.interval[0]) / 2) * WAVE_WIDEN;
        const L = this.ctx.config.geometry.length;
        this.waveEst = { x: src.x, interval: [Math.max(0, src.x - half), Math.min(L, src.x + half)] };
      }
    }
    if (s.t - this.locatedAt < 1) return;
    this.locatedAt = s.t;
    if (s.t - this.alarmStart <= 20) {
      for (const [id, f] of Object.entries(this.firstChanges(s.t, ARRIVAL_SUSTAIN_SEC))) {
        if (f.sign < 0 && !this.arrival.times.has(id) && this.ctx.sensors.some((v) => v.id === id && v.kind === 'p')) this.arrival.times.set(id, f.t);
      }
    }
    // дальние датчики: волна идёт до них дольше, чем держит история, — ловим приход по уровню «до события»,
    // запомненному в момент тревоги, до полного пробега волны + 10 с
    if (s.t - this.alarmStart <= this.ctx.config.geometry.length / this.sc.waveSpeed + 10) this.arrival.track(s.t, this.rawHist, this.sc.binSec);
    const L = this.ctx.config.geometry.length;
    const transit = L / this.sc.waveSpeed;
    const since = s.t - this.alarmStart;
    const method = this.spec.localization;
    // профиль (L2) считаем всегда — для стадий и стенда; сглаживается кривая стоимости (τ ≈ 10 с), а не границы
    if (method !== 'wave-timing') {
      const c = this.profileCosts(s);
      if (c) {
        const a = 0.1;
        this.profCosts = this.profCosts && this.profCosts.length === c.costs.length ? this.profCosts.map((v, j) => v + a * (c.costs[j]! - v)) : c.costs;
        this.profEst = method === 'hgl' ? this.locateBy('hgl', s) : this.lsq.fromCosts(this.profCosts, c.rates, L, PROFILE_DELTA);
      }
    }
    if (this.ml) {
      const f = this.locatorFeatures(s.t);
      const r = f ? this.ml.locate(f) : null;
      if (r) this.mlEst = r;
    }
    // от грубого к точному: волна (если фронт виден) → профиль после затухания волн → ML в первые секунды;
    // всё — в пересечении с отрезком по первому датчику (H-B13: покрытие 90–94% на тестовых seed)
    const statEst: LocationEstimate | null =
      out.location !== undefined ? { x: out.location, interval: out.locationInterval ?? [out.location, out.location] } : null;
    let cand: LocationEstimate | null = null;
    let stage: LocationStage = 'segment';
    if (this.waveEst) {
      cand = this.waveEst;
      stage = 'wave';
    } else if (statEst && method === 'wave-timing') {
      cand = statEst;
      stage = 'wave';
    } else if (this.profEst && since >= PROFILE_AFTER_TRANSITS * transit && this.profileTrusted()) {
      cand = this.profEst;
      stage = 'profile';
    } else if (this.mlEst && since < ML_UNTIL_TRANSITS * transit && this.segByArrival) {
      cand = this.mlEst;
      stage = 'ml';
    }
    const seg = this.segEst;
    let est: LocationEstimate | null = cand;
    if (cand && seg) {
      const lo = Math.max(cand.interval[0], seg.interval[0]);
      const hi = Math.min(cand.interval[1], seg.interval[1]);
      // противоречие с отрезком — доверяем отрезку: на стенде уточняющие стадии ошибались чаще
      // (например, волна при плавно нарастающей утечке)
      if (lo <= hi) est = { x: Math.min(hi, Math.max(lo, cand.x)), interval: [lo, hi], rate: cand.rate };
      else {
        est = { ...seg, x: Math.min(seg.interval[1], Math.max(seg.interval[0], this.profEst?.x ?? cand.x)) };
        cand = null;
      }
    } else if (!cand && seg) {
      // точка внутри отрезка — лучшая доступная оценка (профиль), а не сам датчик
      const px = this.profEst?.x ?? (seg.interval[0] + seg.interval[1]) / 2;
      est = { ...seg, x: Math.min(seg.interval[1], Math.max(seg.interval[0], px)) };
    }
    // две волны: зона охватывает оба места, пока событие не подтверждено (тогда оно разделится на две утечки)
    const key = [...this.arrival.times.entries()].map(([id, tt]) => `${id}${tt.toFixed(1)}`).join();
    if (key !== this.multiKey) {
      this.multiKey = key;
      this.multi = this.twoWaves();
    }
    if (this.multi) {
      const m = this.multi;
      est = { x: m.x1, interval: [Math.min(m.zone1[0], m.zone2[0]), Math.max(m.zone1[1], m.zone2[1])], rate: est?.rate };
      stage = 'wave';
      cand = est;
    }
    if (est) {
      this.location = { ...est, rate: est.rate ?? this.profEst?.rate };
      this.locStage = cand ? stage : 'segment';
    }
  }

  /** Профилю можно верить, если оценённая им утечка не меньше PROFILE_MIN_FRACTION расхода. */
  private profileTrusted(): boolean {
    const q = this.profEst?.rate;
    const nominal = this.prep.nominalFlow;
    return q !== undefined && nominal > 0 && q / nominal >= PROFILE_MIN_FRACTION;
  }

  /**
   * Первая оценка места — сразу при тревоге: волна от утечки раньше всех приходит к ближайшему
   * датчику давления, значит утечка в его «ячейке» — от середины до соседа слева до середины до
   * соседа справа, с запасом на неточность момента первого изменения (SEGMENT_MARGIN_SEC пробега волны).
   * Нет первых изменений (малая утечка) — ячейка датчика с наибольшим спадом давления.
   */
  private segmentAtAlarm(t: number): LocationEstimate | null {
    const L = this.ctx.config.geometry.length;
    const ps = this.ctx.sensors.filter((v) => v.kind === 'p' && this.rawHist.has(v.id)).sort((a, b) => a.x - b.x);
    if (ps.length < 2) return null;
    const first = this.firstChanges(t);
    let k = -1;
    let best = Infinity;
    ps.forEach((p, i) => {
      const f = first[p.id];
      if (f && f.sign < 0 && f.t < best) {
        best = f.t;
        k = i;
      }
    });
    if (k < 0) {
      const d = this.deltas();
      let most = 0;
      ps.forEach((p, i) => {
        const v = d[p.id];
        if (v !== undefined && v < most) {
          most = v;
          k = i;
        }
      });
    }
    if (k < 0) return { x: L / 2, interval: [0, L] };
    const margin = SEGMENT_MARGIN_SEC * this.sc.waveSpeed;
    // без первого изменения (малая утечка в шуме) датчик с наибольшим спадом указывает место ненадёжно:
    // на стенде отрезок вокруг него промахивался в 30–60% случаев — честнее сказать «весь участок»
    this.segByArrival = Number.isFinite(best);
    if (!this.segByArrival) return { x: ps[k]!.x, interval: [0, L] };
    const lo = k === 0 ? 0 : Math.max(0, (ps[k - 1]!.x + ps[k]!.x) / 2 - margin);
    const hi = k === ps.length - 1 ? L : Math.min(L, (ps[k]!.x + ps[k + 1]!.x) / 2 + margin);
    return { x: Math.min(hi, Math.max(lo, ps[k]!.x)), interval: [lo, hi] };
  }

  private profileCosts(s: PreparedSample): { costs: number[]; rates: number[] } | null {
    const twin = this.ctx.twin;
    if (!twin) return null;
    if (!this.lsq.ready) this.lsq.build(twin, this.ctx.config.geometry.length, this.prep.nominalFlow);
    const dr: Record<string, number> = {};
    for (const [id, w] of this.zHist) {
      const sg = this.prep.sigmaOf(id);
      if (sg && s.valid.has(id)) dr[id] = w.mean() * sg;
    }
    return this.lsq.costs(dr, (id) => this.prep.sigmaOf(id));
  }

  /** Сглаженная кривая стоимости профиля (диагностика, калибровка интервала). */
  get profileCostCurve(): number[] | null {
    return this.profCosts;
  }

  private locateBy(m: LocalizationMethod, s: PreparedSample): LocationEstimate | null {
    const L = this.ctx.config.geometry.length;
    const twin = this.ctx.twin;
    if (m === 'lsq' && twin) {
      if (!this.lsq.ready) this.lsq.build(twin, L, this.prep.nominalFlow);
      const dr: Record<string, number> = {};
      for (const [id, w] of this.zHist) {
        const sg = this.prep.sigmaOf(id);
        if (sg && s.valid.has(id)) dr[id] = w.mean() * sg;
      }
      return this.lsq.locate(dr, (id) => this.prep.sigmaOf(id), L);
    }
    if (m === 'hgl' && twin) {
      const at = (k: 'p' | 'q', x: number) => this.ctx.sensors.find((v) => v.kind === k && v.x === x)?.id;
      const ids = [at('p', 0), at('q', 0), at('p', L), at('q', L)];
      if (!ids.every((id) => id && this.rawHist.has(id))) return null;
      const v = ids.map((id) => this.rawHist.get(id!)!.meanLast(Math.round(5 / this.sc.binSec)));
      return locateHgl(twin, L, v[0]!, v[1]!, v[2]!, v[3]!);
    }
    return null;
  }

  private process(s: PreparedSample): DetectorOutput {
    const out = this.stat.update(s);
    this.tracker?.update(s);
    this.remember(s);
    this.updateFlowImbalance(s);
    if (!s.warm) return { t: s.t, score: out.score, threshold: out.threshold, z: s.z, unhealthySensors: this.prep.unhealthy(), phase: 'warmup', alarm: false };

    this.watchRegime(s.t);
    this.watchSensorFaults(s.t);
    const guard = s.t < this.leakGuardUntil ? this.leakGuardFactor : s.t < this.guardUntil ? this.opts.guardFactor ?? 1.5 : 1;
    const ratio = out.threshold > 0 ? out.score / (out.threshold * guard) : 0;
    const raw = !this.opts.silent && (out.alarm ?? ratio > 1);
    let phase: DetectorPhase = 'running';

    if (this.alarmed) {
      const canClear = s.t - this.alarmStart >= (this.opts.holdSec ?? 30);
      if (canClear && ratio < 0.5 && !out.alarm) {
        // событие закончилось само: утечку устранили до подтверждения (или это была не утечка)
        this.endEvent();
      } else if (
        s.t - this.alarmStart >= CONFIRM_AFTER_TRANSITS * (this.ctx.config.geometry.length / this.sc.waveSpeed) &&
        ratio >= 1 &&
        this.location &&
        this.settled(s.t)
      ) {
        this.confirmLeak(s.t);
      }
    } else if (raw) {
      const onset = out.onset;
      const sig = classifyEvent({
        sensors: this.ctx.sensors,
        length: this.ctx.config.geometry.length,
        delta: this.deltas(),
        first: this.firstChanges(s.t),
        activeChannels: this.activeChannels(),
      });
      if (sig.cls === 'sensor-fault') {
        // один датчик против всех: тревогу не даём, решение — за монитором отказов (watchSensorFaults)
        if (Number.isNaN(this.holdUntil)) this.holdUntil = s.t + this.faultHoldSec;
        phase = 'suspect';
      } else if (
        this.spec.signatureFilter &&
        (sig.cls === 'pump-change' || sig.cls === 'valve-change') &&
        sig.confidence >= SUPPRESS_CONFIDENCE &&
        // известное событие режима уже учтено защитой (порог повышен) — повторно не подавляем
        !(s.t < this.guardUntil)
      ) {
        this.setEvent(sig.cls, s.t);
        this.stat.rearm();
        this.prep.rebaseline(s.t);
        this.holdUntil = NaN;
      } else if (sig.cls === 'unknown' && (Number.isNaN(this.unknownSince) || s.t - this.unknownSince < (this.opts.confirmSec ?? 2))) {
        // нет признаков утечки — тревога только если превышение держится confirmSec подряд
        if (Number.isNaN(this.unknownSince)) this.unknownSince = s.t;
        phase = 'suspect';
      } else {
        this.alarmed = true;
        this.alarmStart = s.t;
        this.leakId = `L${++this.leakSeq}`;
        this.arrival.clear();
        this.captureAlarmPre();
        this.arrival.capture(s.t, this.ctx.sensors, this.rawHist, (n) => this.preWindow(n), (id) => this.prep.rawStats(id)?.noise, this.sc.binSec);
        this.segByArrival = false;
        this.segEst = this.segmentAtAlarm(s.t);
        this.onset = onset;
        this.holdUntil = NaN;
        this.unknownSince = NaN;
        this.setEvent(sig.cls === 'unknown' ? 'unknown' : 'leak', Infinity);
      }
    } else {
      this.holdUntil = NaN;
      this.unknownSince = NaN;
    }

    if (this.alarmed) {
      phase = 'alarm';
      this.prep.freeze(true);
      this.locate(s, out);
    } else if (ratio > 0.5 || !Number.isNaN(this.holdUntil)) {
      phase = 'suspect';
      this.prep.freeze(true);
    } else {
      // идёт возможное снятие утечек — норму не подстраиваем, пока не решим, что именно сняли
      this.prep.freeze(s.t < this.recovery.holdUntil);
    }

    if (!this.alarmed && this.confirmed.length) this.watchRecovery(s.t);
    const active = this.alarmed || this.confirmed.length > 0;
    if (active) phase = 'alarm';

    // порог в выходе — с учётом защиты от переходного режима (его видно на графике)
    const result: DetectorOutput = {
      t: s.t,
      score: out.score,
      threshold: out.threshold * guard,
      z: s.z,
      unhealthySensors: this.prep.unhealthy(),
      phase,
      alarm: active,
    };
    if (s.t < this.eventUntil || this.alarmed) result.eventClass = this.eventClass;
    else if (active) result.eventClass = 'leak';
    const lastConfirmed = this.confirmed.at(-1);
    if (this.alarmed && this.location) {
      result.location = this.location.x;
      result.locationInterval = this.location.interval;
      result.locationStage = this.locStage;
    } else if (!this.alarmed && lastConfirmed?.location !== undefined) {
      result.location = lastConfirmed.location;
      if (lastConfirmed.locationInterval) result.locationInterval = lastConfirmed.locationInterval;
      if (lastConfirmed.locationStage) result.locationStage = lastConfirmed.locationStage;
    }
    // баланс расходов осмыслен, когда волна от утечки дошла до обоих концов (≈ один пробег)
    const flowsSettled = s.t - this.alarmStart >= this.ctx.config.geometry.length / this.sc.waveSpeed;
    const rate = out.leakRate ?? this.location?.rate ?? (flowsSettled && Number.isFinite(this.flowImbalance) ? Math.max(0, this.flowImbalance) : undefined);
    if (this.alarmed) this.lastRate = rate ?? this.lastRate;
    if (this.alarmed && rate !== undefined) result.leakRate = rate;
    else if (!this.alarmed && lastConfirmed?.leakRate !== undefined) result.leakRate = lastConfirmed.leakRate;
    if (this.alarmed && this.onset !== undefined) result.onsetTime = this.onset;
    if (active) {
      const leaks: ActiveLeak[] = this.confirmed.map(({ delta: _d, ...l }) => l);
      if (this.alarmed) {
        leaks.push({
          id: this.leakId,
          tAlarm: this.alarmStart,
          state: 'detecting',
          ...(this.location ? { location: this.location.x, locationInterval: this.location.interval, locationStage: this.locStage } : {}),
          ...(rate !== undefined ? { leakRate: rate } : {}),
        });
      }
      result.leaks = leaks;
    }
    const contrib = this.contributions(s, out);
    if (contrib.length) result.contributions = contrib;
    return result;
  }

  /** Закончить текущее событие: сбросить оценки места, перевзвести статистику, разморозить норму. */
  private endEvent(): void {
    this.alarmed = false;
    this.location = null;
    this.waveEst = null;
    this.segEst = null;
    this.profEst = null;
    this.profCosts = null;
    this.mlEst = null;
    this.lsq = new LsqLocator();
    this.stat.rearm();
    this.tracker?.clear();
    this.prep.freeze(false);
    this.settle.reset();
    this.lastRate = undefined;
    this.multi = null;
    this.multiKey = '';
  }

  /** Защита после подтверждения или устранения утечки: порог выше пропорционально её вкладу. */
  private startLeakGuard(t: number, delta: Record<string, number>): void {
    const f = leakGuardFactor(delta, this.sigma);
    this.leakGuardFactor = t < this.leakGuardUntil ? Math.max(this.leakGuardFactor, f) : f;
    this.leakGuardUntil = Math.max(this.leakGuardUntil, t + LEAK_GUARD_SCALE * this.guardSec);
  }

  /** Средние невязки (СИ) давлений и расходов за последние LEAK_WINDOW_SEC по каналам с полным окном. */
  private longResiduals(): Record<string, number> {
    const out: Record<string, number> = {};
    const n = Math.round(LEAK_WINDOW_SEC / this.sc.binSec);
    for (const [id, w] of this.zLong) {
      // температура после крупной утечки меняется часами (нефть идёт по трубе ~9 ч) — в вклад утечки
      // и проверку установления берём только давления и расходы
      if (this.ctx.sensors.find((v) => v.id === id)?.kind === 'T') continue;
      const sg = this.prep.sigmaOf(id);
      if (sg && w.length >= n) out[id] = w.mean() * sg;
    }
    return out;
  }

  /**
   * Установился ли отклик утечки. Пока после утечки перестраиваются расход и давления, её вклад ещё меняется —
   * запомнить его рано: остаток дрейфа выглядел бы как новая утечка.
   */
  private settled(t: number): boolean {
    if (this.settle.due(t)) this.settle.update(t, this.longResiduals(), this.sigma);
    return this.settle.settled;
  }

  /** Две волны видны в текущем событии: одна утечка приходы не объясняет, пара — объясняет. */
  private twoWaves(): ArrivalSources | null {
    const pts = this.arrival.points(this.ctx.sensors);
    return twoWaves(arrivalSources(pts, this.ctx.config.geometry.length, this.sc.waveSpeed, SPLIT_MIN_SEP));
  }

  /** В момент тревоги: средний сырой замер «до события» по всем датчикам. */
  private captureAlarmPre(): void {
    this.alarmPre.clear();
    for (const [id, w] of this.rawHist) {
      const win = this.preWindow(w.length);
      const noise = this.prep.rawStats(id)?.noise;
      if (win && noise) this.alarmPre.set(id, { pre: w.meanRange(win[0], win[1]), noise, n: win[1] - win[0] });
    }
  }

  /** Изменение сырого замера с начала события (среднее за 10 с минус «до»), в долях шума разности. */
  private rawChange(id: string | undefined): number | undefined {
    if (!id) return undefined;
    const a = this.alarmPre.get(id);
    const w = this.rawHist.get(id);
    if (!a || !w) return undefined;
    const n = Math.min(w.length, Math.round(LEAK_WINDOW_SEC / this.sc.binSec));
    if (n < 2) return undefined;
    return (w.meanRange(0, n) - a.pre) / (a.noise * Math.sqrt(1 / n + 1 / a.n));
  }

  /** Признаки текущего события «утечка или отказ датчика» (H-B19); вне тревоги — null. */
  eventFeatures(): Record<EventFeatureName, number> | null {
    if (!this.alarmed) return null;
    const delta = this.longResiduals();
    const ids = Object.keys(delta);
    if (!ids.length) return null;
    const zMean: Record<string, number> = {};
    const signs: Record<string, number> = {};
    for (const id of ids) {
      zMean[id] = delta[id]! / (this.prep.sigmaOf(id) ?? 1);
      signs[id] = this.prep.signs.get(id) ?? 0;
    }
    const L = this.ctx.config.geometry.length;
    // граничные для двойника — датчики давления и расхода без невязки (их замер задаёт модель)
    const boundary = this.ctx.sensors.filter((v) => (v.kind === 'p' || v.kind === 'q') && !(v.id in zMean) && this.alarmPre.has(v.id));
    const qIn = this.ctx.sensors.find((v) => v.kind === 'q' && v.x <= 1)?.id;
    const qOut = this.ctx.sensors.find((v) => v.kind === 'q' && v.x >= L - 1)?.id;
    const sh = this.shapesFor(ids);
    const fit = sh ? fitOneOrTwo(delta, ids, sh, this.sigma, L) : null;
    const ps = this.ctx.sensors.filter((v) => v.kind === 'p');
    const qi = this.rawChange(qIn);
    const qo = this.rawChange(qOut);
    return eventFeatures({
      zMean,
      signs,
      boundaryDelta: boundary.map((v) => this.rawChange(v.id) ?? 0),
      flowDelta: { ...(qi !== undefined ? { qIn: qi } : {}), ...(qo !== undefined ? { qOut: qo } : {}) },
      arrivals: ps.filter((v) => this.arrival.times.has(v.id)).length,
      pressures: ps.length,
      fitExplained: fit && fit.yy > 0 ? 1 - fit.one.cost / fit.yy : undefined,
    });
  }

  /** Отклики модели на утечку по каналам ids (локатор строится при первом обращении). */
  private shapesFor(ids: string[]): Shapes | null {
    const twin = this.ctx.twin;
    if (!twin) return null;
    if (!this.lsq.ready) this.lsq.build(twin, this.ctx.config.geometry.length, this.prep.nominalFlow);
    return this.lsq.shapes(ids, this.sigma);
  }

  /** Диагностика последнего подбора «одна или две» (для стенда и калибровки). */
  lastSplit: { cost1: number; cost2: number; yy: number; x1: number; x2?: number; xb?: number; q1?: number; q2?: number; qOne: number } | null = null;

  /**
   * Подтвердить утечку: место установилось, отклонение держится и больше не меняется. Её вклад в невязки
   * уходит в норму — детектор снова готов ловить следующую, а эта остаётся в списке активных до устранения.
   * Две волны по приходу или пара, заметно лучше одной по отклику, — событие делится на две утечки.
   */
  private confirmLeak(t: number): void {
    const delta = this.longResiduals();
    if (!Object.keys(delta).length || !this.location) return;
    if (this.rejectAsFault(t)) return;
    const ids = Object.keys(delta);
    const L = this.ctx.config.geometry.length;
    const sh = this.shapesFor(ids);
    const fit = sh ? fitOneOrTwo(delta, ids, sh, this.sigma, L) : null;
    if (fit) {
      this.lastSplit = {
        cost1: fit.one.cost,
        cost2: fit.two?.cost ?? Infinity,
        yy: fit.yy,
        x1: fit.xs[fit.one.j]!,
        qOne: fit.one.q,
        ...(fit.two ? { x2: fit.xs[fit.two.i]!, xb: fit.xs[fit.two.j]!, q1: fit.two.qi, q2: fit.two.qj } : {}),
      };
    }
    if (sh && this.multi) {
      const m = this.multi;
      const r = ratesAt(delta, ids, sh, this.sigma, [m.x1, m.x2]);
      if (r) {
        const [di, dj] = splitDelta(delta, ids, sh.h[r.i]!, r.qi, this.sigma);
        this.confirmPair(t, delta, [{ x: m.x1, interval: m.zone1, q: r.qi, d: di }, { x: m.x2, interval: m.zone2, q: r.qj, d: dj }], 'wave');
        return;
      }
    }
    const pair = sh && fit ? acceptPair(fit, L) : null;
    if (sh && pair) {
      const [di, dj] = splitDelta(delta, ids, sh.h[pair[0].j]!, pair[0].q, this.sigma);
      this.confirmPair(t, delta, [{ ...pair[0], d: di }, { ...pair[1], d: dj }], 'profile');
      return;
    }
    this.prep.shiftBaseline(delta);
    const l = this.location;
    const rate = this.lastRate ?? l.rate;
    this.confirmed.push({
      id: this.leakId,
      tAlarm: this.alarmStart,
      location: l.x,
      locationInterval: l.interval,
      locationStage: this.locStage,
      ...(rate !== undefined ? { leakRate: rate } : {}),
      state: 'confirmed',
      delta,
    });
    this.afterConfirm(t, delta);
  }

  /** Вероятность утечки по классификатору при последнем подтверждении (диагностика, стенд). */
  lastLeakProbability: number | undefined;

  /**
   * Классификатор считает событие отказом датчика (H-B19): датчик исключается, событие закрывается
   * без утечки, норма коротко перенастраивается. Датчик — граничный для двойника, если его замер
   * заметно скачнул с начала события, иначе — канал с наибольшим отклонением от модели.
   */
  private rejectAsFault(t: number): boolean {
    const m = this.opts.eventClassifier;
    if (!m) return false;
    const f = this.eventFeatures();
    if (!f) return false;
    const p = leakProbability(m, f);
    this.lastLeakProbability = p;
    if (p >= m.threshold) return false;
    const delta = this.longResiduals();
    let id: string | undefined;
    let best = 5;
    for (const v of this.ctx.sensors) {
      if ((v.kind !== 'p' && v.kind !== 'q') || v.id in delta) continue;
      const d = Math.abs(this.rawChange(v.id) ?? 0);
      if (d > best) {
        best = d;
        id = v.id;
      }
    }
    if (!id) {
      let top = 0;
      for (const [k, v] of Object.entries(delta)) {
        const z = Math.abs(v / (this.prep.sigmaOf(k) ?? 1));
        if (z > top) {
          top = z;
          id = k;
        }
      }
    }
    if (id) this.prep.exclude(id, 'отказ датчика (классификатор событий)');
    this.zHist.clear();
    this.zLong.clear();
    this.endEvent();
    this.prep.rebaseline(t);
    this.setEvent('sensor-fault', t);
    return true;
  }

  /** Подтвердить событие как две утечки (вклады в сумме — delta). */
  private confirmPair(
    t: number,
    delta: Record<string, number>,
    parts: Array<{ x: number; interval: [number, number]; q: number; d: Record<string, number> }>,
    stage: LocationStage,
  ): void {
    this.prep.shiftBaseline(delta);
    const tAlarm = this.alarmStart;
    const ids = [this.leakId, `L${++this.leakSeq}`];
    parts.forEach((k, n) => {
      this.confirmed.push({ id: ids[n]!, tAlarm, location: k.x, locationInterval: k.interval, locationStage: stage, leakRate: k.q, state: 'confirmed', delta: k.d });
    });
    this.afterConfirm(t, delta);
  }

  private afterConfirm(t: number, delta: Record<string, number>): void {
    this.zHist.clear();
    this.zLong.clear();
    this.recoverAt = t;
    this.endEvent();
    // остаток переходного процесса после утечки — как после смены режима: порог временно выше
    this.startLeakGuard(t, delta);
  }

  /**
   * Устранение утечек — одной, нескольких или всех сразу (раз в секунду, вне тревоги). Какие сняли — решает
   * RecoveryWatcher; их вклады уходят из нормы. Сняли все — норма возвращается к исходной полностью.
   */
  private watchRecovery(t: number): void {
    if (t - this.recoverAt < 1) return;
    this.recoverAt = t;
    const y = this.longResiduals();
    if (!Object.keys(y).length) return;
    const L = this.ctx.config.geometry.length;
    const qIn = this.ctx.sensors.find((v) => v.kind === 'q' && v.x <= 1)?.id;
    const qOut = this.ctx.sensors.find((v) => v.kind === 'q' && v.x >= L - 1)?.id;
    const mask = this.recovery.check(t, { y, deltas: this.confirmed.map((k) => k.delta), sigma: this.sigma, qIn, qOut }, 2 * this.guardSec);
    if (!mask) return;
    const removed = this.confirmed.filter((_, k) => mask & (1 << k));
    const total: Record<string, number> = {};
    for (const k of removed) for (const [id, d] of Object.entries(k.delta)) total[id] = (total[id] ?? 0) + d;
    this.prep.shiftBaseline(total, -1);
    // пока утечки были активны, норма медленно подстраивалась под мелкий дрейф — он не входит в их вклады;
    // сдвиг уже установился, поэтому коротко перенастраиваем норму по текущим замерам (как после смены режима)
    this.prep.rebaseline(t);
    this.confirmed = this.confirmed.filter((_, k) => !(mask & (1 << k)));
    this.removalUntil = Math.max(this.removalUntil, t + this.guardSec);
    this.zHist.clear();
    this.zLong.clear();
    this.stat.rearm();
    this.tracker?.clear();
    this.startLeakGuard(t, total);
  }

  private setEvent(cls: EventClass, until: number): void {
    this.eventClass = cls;
    this.eventUntil = until === Infinity ? Infinity : until + 10;
  }

  private contributions(s: PreparedSample, out: StatOut): Array<{ sensorId: string; share: number }> {
    const src: Record<string, number> = {};
    for (const [id, e] of Object.entries(s.e)) if (id !== SUM && e > 0) src[id] = e;
    if (!Object.keys(src).length && out.channels) for (const [id, v] of Object.entries(out.channels)) if (id !== SUM && v > 0) src[id] = v;
    const total = Object.values(src).reduce((a, b) => a + b, 0);
    if (!(total > 0)) return [];
    return Object.entries(src)
      .map(([sensorId, v]) => ({ sensorId, share: v / total }))
      .sort((a, b) => b.share - a.share);
  }
}

/** Детектор по стратегии (файл strategy.selected.json или её часть). */
export function createDetector(spec: StrategySpec, opts?: PipelineOptions): DetectionPipeline {
  return new DetectionPipeline(spec, opts);
}

/** Стратегия по имени детектора с параметрами по умолчанию. */
export function defaultStrategy(name: string, overrides: Partial<StrategySpec> = {}): StrategySpec {
  const meta = REGISTRY[name];
  if (!meta) throw new Error(`неизвестный детектор «${name}»`);
  return {
    strategy: name as StrategySpec['strategy'],
    params: { ...meta.defaults },
    localization: name === 'npw' ? 'wave-timing' : 'lsq',
    signatureFilter: true,
    warmupSec: 60,
    ...overrides,
  };
}
