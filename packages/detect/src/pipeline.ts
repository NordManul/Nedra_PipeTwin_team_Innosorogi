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
/** Окно для вклада утечки и проверки её устранения, с. */
const LEAK_WINDOW_SEC = 10;
/** Отклик установился: средние за окно сдвинулись меньше max(SETTLE_Z σ, SETTLE_REL·отклонение) по всем каналам, SETTLE_HITS сравнений подряд. */
const SETTLE_Z = 0.5;
const SETTLE_HITS = 3;
const SETTLE_REL = 0.15;
/** Устранение: невязка вернулась на вклад утечки с ошибкой меньше этой доли, RECOVER_HITS проверок подряд (раз в секунду). */
const RECOVER_TOL = 0.5;
const RECOVER_HITS = 5;
/** Допуск баланса расходов при снятии: доля от суммарного расхода снятых утечек (или 3 шума баланса). */
const BALANCE_REL = 0.3;
/**
 * Защитное окно после подтверждения и после устранения утечки: длительность — в долях окна смены режима.
 * После утечки расход и давления перестраиваются минутами, и остаток дрейфа тем больше, чем крупнее утечка,
 * поэтому порог поднимается пропорционально вкладу утечки: ×(1 + LEAK_GUARD_K·|вклад в σ|), в пределах [1,5; 4].
 */
const LEAK_GUARD_SCALE = 2;
const LEAK_GUARD_K = 0.2;
/** Две одновременные утечки различаем, если они дальше друг от друга, чем SPLIT_MIN_SEP, м. */
const SPLIT_MIN_SEP = 4000;
/**
 * Делим событие на две утечки, если пара объясняет отклик заметно лучше одной: выигрыш (в долях шума)
 * больше SPLIT_GAIN, ошибка пары меньше SPLIT_RATIO от ошибки одной, каждая утечка — не меньше
 * SPLIT_MIN_SHARE от суммы. На одиночных утечках стенда выигрыш не превышал 0,64.
 * Интервал каждой — места, где ошибка пары не больше минимума + SPLIT_ZONE_FRAC·выигрыш.
 */
const SPLIT_GAIN = 1;
const SPLIT_RATIO = 0.3;
const SPLIT_MIN_SHARE = 0.15;
const SPLIT_ZONE_FRAC = 0.2;
/**
 * Две волны: времена прихода спада давления к датчикам не объясняются одним источником (RMS больше
 * ARR_SINGLE_TOL, с), а парой источников — объясняются (RMS меньше ARR_PAIR_TOL и вдвое лучше одного).
 * Ложный «приход» у насоса пара не объясняет — одиночная утечка не делится.
 * Зона каждой — места, где RMS пары не больше минимума + ARR_ZONE_TOL.
 */
const ARR_SINGLE_TOL = 0.8;
/** Приход волны засчитываем, если спад держится столько секунд (шумовой выброс — нет). */
const ARRIVAL_SUSTAIN_SEC = 2;
const ARR_PAIR_TOL = 1.5;
const ARR_ZONE_TOL = 2;

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
  /** Моменты прихода волны (первого спада давления) по датчикам — запоминаются в первые 20 с тревоги. */
  private arrivals = new Map<string, number>();
  /** Уровень давления «до события» и порог по датчикам — для прихода волны после тревоги. */
  private arrPre = new Map<string, { pre: number; lim: number }>();
  private arrScanT = -Infinity;
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
  /** Набор снятых утечек, который держится в последних проверках (битовая маска по confirmed), и сколько раз подряд. */
  private recoverMask = 0;
  private recoverHits = 0;
  /** Идёт снятие утечек: скачки на концах трубы не считаем сменой режима. */
  private removalUntil = -Infinity;
  /** Снимок невязок для проверки, что сдвиг после снятия утечек установился. */
  private recoverSnap: { t: number; r: Record<string, number> } | null = null;
  private recoverStable = 0;
  /** До какого времени держать норму замороженной: показания сдвинулись при известных утечках. */
  private recoverHoldUntil = -Infinity;
  /** Две волны в текущем событии (одновременные утечки) — по временам прихода. */
  private multi: NonNullable<ReturnType<DetectionPipeline['arrivalSources']>> | null = null;
  private multiKey = '';
  /** Снимки средних невязок раз в LEAK_WINDOW_SEC — проверка, что отклик утечки установился. */
  private settleSnap: { t: number; r: Record<string, number> } | null = null;
  private settleHits = 0;
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
    this.recoverMask = 0;
    this.recoverHits = 0;
    this.removalUntil = -Infinity;
    this.recoverSnap = null;
    this.recoverStable = 0;
    this.recoverHoldUntil = -Infinity;
    this.settleSnap = null;
    this.settleHits = 0;
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
    const first: Record<string, number | undefined> = Object.fromEntries(this.arrivals);
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
        if (f.sign < 0 && !this.arrivals.has(id) && this.ctx.sensors.some((v) => v.id === id && v.kind === 'p')) this.arrivals.set(id, f.t);
      }
    }
    // дальние датчики: волна идёт до них дольше, чем держит история, — ловим приход по уровню «до события»,
    // запомненному в момент тревоги, до полного пробега волны + 10 с
    if (s.t - this.alarmStart <= this.ctx.config.geometry.length / this.sc.waveSpeed + 10) this.trackArrivals(s.t);
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
    const key = [...this.arrivals.entries()].map(([id, tt]) => `${id}${tt.toFixed(1)}`).join();
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
        this.arrivals.clear();
        this.captureArrivalLevels();
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
      this.prep.freeze(s.t < this.recoverHoldUntil);
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
    this.settleSnap = null;
    this.settleHits = 0;
    this.lastRate = undefined;
    this.multi = null;
    this.multiKey = '';
  }

  private startLeakGuard(t: number, delta: Record<string, number>): void {
    let n2 = 0;
    for (const [id, d] of Object.entries(delta)) {
      const sg = this.prep.sigmaOf(id);
      if (sg) n2 += (d / sg) ** 2;
    }
    const f = Math.min(4, Math.max(1.5, 1 + LEAK_GUARD_K * Math.sqrt(n2)));
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
   * Установился ли отклик утечки: раз в LEAK_WINDOW_SEC сравниваем средние невязки с прошлым снимком.
   * Пока после утечки перестраиваются расход и давления, её вклад ещё меняется — запомнить его рано:
   * остаток дрейфа выглядел бы как новая утечка.
   */
  private settled(t: number): boolean {
    if (this.settleSnap && t - this.settleSnap.t < LEAK_WINDOW_SEC) return this.settleHits >= SETTLE_HITS;
    const r = this.longResiduals();
    const prev = this.settleSnap;
    this.settleSnap = { t, r };
    if (!prev) return false;
    let ok = true;
    for (const [id, v] of Object.entries(r)) {
      const sg = this.prep.sigmaOf(id);
      if (!sg || prev.r[id] === undefined) continue;
      // допуск — SETTLE_Z σ или SETTLE_REL от самого отклонения (у крупной утечки медленные колебания больше)
      if (Math.abs(v - prev.r[id]!) > Math.max(SETTLE_Z * sg, SETTLE_REL * Math.abs(v))) ok = false;
    }
    this.settleHits = ok ? this.settleHits + 1 : 0;
    return this.settleHits >= SETTLE_HITS;
  }

  /** В момент тревоги: уровень «до события» по датчикам давления (окно preWindow истории). */
  private captureArrivalLevels(): void {
    this.arrPre.clear();
    const nMa = Math.max(1, Math.round(1 / this.sc.binSec));
    for (const v of this.ctx.sensors) {
      if (v.kind !== 'p') continue;
      const w = this.rawHist.get(v.id);
      const noise = this.prep.rawStats(v.id)?.noise;
      const win = w ? this.preWindow(w.length) : null;
      if (!w || !noise || !win) continue;
      this.arrPre.set(v.id, { pre: w.meanRange(win[0], win[1]), lim: (4 * noise) / Math.sqrt(nMa) });
    }
    this.arrScanT = this.alarmStart;
  }

  /**
   * Приход волны на датчики, ещё не увидевшие её: скользящее среднее за 1 с ушло вниз от уровня «до события»
   * дальше порога и держится ARRIVAL_SUSTAIN_SEC. Просматриваем только новые отсчёты с прошлой проверки.
   */
  private trackArrivals(t: number): void {
    const bin = this.sc.binSec;
    const nMa = Math.max(1, Math.round(1 / bin));
    const nSus = Math.round(ARRIVAL_SUSTAIN_SEC / bin);
    const nNew = Math.max(1, Math.round((t - this.arrScanT) / bin));
    this.arrScanT = t;
    for (const [id, { pre, lim }] of this.arrPre) {
      if (this.arrivals.has(id)) continue;
      const w = this.rawHist.get(id);
      if (!w) continue;
      // кандидаты — отсчёты, у которых уже есть nSus более новых для проверки устойчивости
      for (let i = Math.min(w.length - nMa, nSus + nNew); i >= nSus; i--) {
        const ma = w.meanRange(i, i + nMa);
        if (!(pre - ma > lim)) continue;
        let held = true;
        for (let k = 1; k <= nSus && held; k++) if (!(pre - w.meanRange(i - k, i - k + nMa) > lim / 2)) held = false;
        if (held) {
          this.arrivals.set(id, t - (i + nMa / 2) * bin);
          break;
        }
      }
    }
  }

  /**
   * Сколько источников объясняют времена прихода волны: один (t_i = t0 + |x_i − x|/a, допускаем один выброс)
   * или два одновременных (t_i = t0 + min(|x_i − x1|, |x_i − x2|)/a). Нужно 4+ датчика давления с приходом.
   */
  private arrivalSources(): { rms1: number; x1: number; x2: number; rms2: number; zone1: [number, number]; zone2: [number, number] } | null {
    const L = this.ctx.config.geometry.length;
    const a = this.sc.waveSpeed;
    const pts = this.ctx.sensors.filter((v) => v.kind === 'p' && this.arrivals.has(v.id)).map((v) => ({ x: v.x, t: this.arrivals.get(v.id)! }));
    if (pts.length < 4) return null;
    const step = 250;
    const grid: number[] = [];
    for (let x = 0; x <= L + 1e-9; x += step) grid.push(x);
    // ложный «приход» бывает только на концах трубы (у насоса и задвижки) — отбросить разрешено лишь такой датчик:
    // промежуточный датчик нельзя, иначе при неизвестном моменте начала одна утечка «объясняет» три датчика из четырёх
    const atEnd = pts.map((p) => p.x <= 1 || p.x >= L - 1);
    const rmsOf = (dist: (xi: number) => number, drop: boolean) => {
      const d = pts.map((p) => p.t - dist(p.x) / a);
      const fit = (keep: boolean[]) => {
        const v = d.filter((_, k) => keep[k]);
        const sorted = [...v].sort((u, w) => u - w);
        const t0 = sorted[Math.floor(sorted.length / 2)]!;
        return Math.sqrt(v.reduce((acc, x) => acc + (x - t0) ** 2, 0) / v.length);
      };
      let best = fit(pts.map(() => true));
      if (drop && pts.length >= 5) for (let k = 0; k < pts.length; k++) if (atEnd[k]) best = Math.min(best, fit(pts.map((_, q) => q !== k)));
      return best;
    };
    let rms1 = Infinity;
    for (const x of grid) rms1 = Math.min(rms1, rmsOf((xi) => Math.abs(xi - x), true));
    let best = { i: 0, j: 0, rms: Infinity };
    const m = grid.length;
    const pair: Float64Array = new Float64Array(m * m).fill(Infinity);
    const minSep = Math.round(SPLIT_MIN_SEP / step);
    for (let i = 0; i < m; i++) {
      for (let j = i + minSep; j < m; j++) {
        // пара — 3 параметра: отбросить датчик можно, только если останется 4+
        const r = rmsOf((xi) => Math.min(Math.abs(xi - grid[i]!), Math.abs(xi - grid[j]!)), pts.length >= 5);
        pair[i * m + j] = r;
        if (r < best.rms) best = { i, j, rms: r };
      }
    }
    const lim = best.rms + ARR_ZONE_TOL;
    let lo1 = best.i;
    let hi1 = best.i;
    while (lo1 > 0 && pair[(lo1 - 1) * m + best.j]! <= lim) lo1--;
    while (hi1 + 1 < best.j - minSep + 1 && pair[(hi1 + 1) * m + best.j]! <= lim) hi1++;
    let lo2 = best.j;
    let hi2 = best.j;
    while (lo2 - 1 >= best.i + minSep && pair[best.i * m + lo2 - 1]! <= lim) lo2--;
    while (hi2 < m - 1 && pair[best.i * m + hi2 + 1]! <= lim) hi2++;
    return {
      rms1,
      x1: grid[best.i]!,
      x2: grid[best.j]!,
      rms2: best.rms,
      zone1: [Math.max(0, grid[lo1]! - step), Math.min(L, grid[hi1]! + step)],
      zone2: [Math.max(0, grid[lo2]! - step), Math.min(L, grid[hi2]! + step)],
    };
  }

  /** Две волны видны: одна утечка их не объясняет, пара — объясняет. */
  private twoWaves(): ReturnType<DetectionPipeline['arrivalSources']> {
    const r = this.arrivalSources();
    return r && r.rms1 > ARR_SINGLE_TOL && r.rms2 < ARR_PAIR_TOL && r.rms2 < 0.5 * r.rms1 ? r : null;
  }

  /**
   * Одна утечка или две одновременные: подбор по откликам модели на сетке мест.
   * y — вклад события (СИ, давления и расходы). Возвращает лучшие одиночную и парную подгонки
   * (ошибки — в долях шума, q — м³/с) и кривые ошибки для интервалов.
   */
  private fitOneOrTwo(y: Record<string, number>): {
    one: { j: number; q: number; cost: number };
    two: { i: number; j: number; qi: number; qj: number; cost: number } | null;
    /** |y|² — полный отклик события в долях шума. */
    yy: number;
    xs: number[];
    costI: number[];
    costJ: number[];
  } | null {
    const twin = this.ctx.twin;
    if (!twin) return null;
    if (!this.lsq.ready) this.lsq.build(twin, this.ctx.config.geometry.length, this.prep.nominalFlow);
    const ids = Object.keys(y);
    const sig = (id: string) => this.prep.sigmaOf(id);
    const sh = this.lsq.shapes(ids, sig);
    if (!sh) return null;
    const yv = ids.map((id) => y[id]! / (sig(id) ?? 1));
    const dot = (a: number[], b: number[]) => a.reduce((acc, v, k) => acc + v * b[k]!, 0);
    const yy = dot(yv, yv);
    const H = sh.h;
    const n = H.length;
    const hh = H.map((h) => dot(h, h));
    const hy = H.map((h) => dot(h, yv));
    let one = { j: 0, q: 0, cost: Infinity };
    for (let j = 0; j < n; j++) {
      const q = hh[j]! > 0 ? Math.max(0, hy[j]! / hh[j]!) : 0;
      const cost = yy - 2 * q * hy[j]! + q * q * hh[j]!;
      if (cost < one.cost) one = { j, q, cost };
    }
    const L = this.ctx.config.geometry.length;
    const minSep = Math.max(2, Math.round((SPLIT_MIN_SEP * n) / L));
    let two: { i: number; j: number; qi: number; qj: number; cost: number } | null = null;
    const pairCost = (i: number, j: number) => {
      const a = hh[i]!;
      const b = dot(H[i]!, H[j]!);
      const c = hh[j]!;
      const det = a * c - b * b;
      if (!(det > 1e-12)) return null;
      const qi = (c * hy[i]! - b * hy[j]!) / det;
      const qj = (a * hy[j]! - b * hy[i]!) / det;
      if (qi <= 0 || qj <= 0) return null;
      return { qi, qj, cost: yy - 2 * (qi * hy[i]! + qj * hy[j]!) + qi * qi * a + 2 * qi * qj * b + qj * qj * c };
    };
    for (let i = 0; i < n; i++) {
      for (let j = i + minSep; j < n; j++) {
        const r = pairCost(i, j);
        if (r && (!two || r.cost < two.cost)) two = { i, j, ...r };
      }
    }
    const costI: number[] = [];
    const costJ: number[] = [];
    if (two) {
      for (let k = 0; k < n; k++) {
        costI.push(Math.abs(k - two.j) >= minSep ? pairCost(k, two.j)?.cost ?? Infinity : Infinity);
        costJ.push(Math.abs(k - two.i) >= minSep ? pairCost(two.i, k)?.cost ?? Infinity : Infinity);
      }
    }
    return { one, two, yy, xs: sh.xs, costI, costJ };
  }

  /**
   * Две одновременные утечки: пара объясняет отклик заметно лучше одной. Событие делится на две подтверждённые
   * утечки со своими местами, интервалами, расходами и вкладами (вклад второй — остаток, чтобы сумма была точной).
   */
  private trySplit(t: number, delta: Record<string, number>, fit: NonNullable<ReturnType<DetectionPipeline['fitOneOrTwo']>>): boolean {
    const two = fit.two!;
    const gain = fit.one.cost - two.cost;
    if (!(gain > SPLIT_GAIN && two.cost < SPLIT_RATIO * fit.one.cost && Math.min(two.qi, two.qj) >= SPLIT_MIN_SHARE * (two.qi + two.qj))) return false;
    const L = this.ctx.config.geometry.length;
    const half = L / fit.xs.length / 2;
    const zone = (curve: number[], at: number): [number, number] => {
      const lim = two.cost + SPLIT_ZONE_FRAC * gain;
      let lo = at;
      let hi = at;
      while (lo > 0 && curve[lo - 1]! <= lim) lo--;
      while (hi < curve.length - 1 && curve[hi + 1]! <= lim) hi++;
      return [Math.max(0, fit.xs[lo]! - half), Math.min(L, fit.xs[hi]! + half)];
    };
    const ids = Object.keys(delta);
    const sh = this.lsq.shapes(ids, (id) => this.prep.sigmaOf(id))!;
    const di: Record<string, number> = {};
    const dj: Record<string, number> = {};
    ids.forEach((id, k) => {
      const sg = this.prep.sigmaOf(id) ?? 0;
      di[id] = two.qi * sh.h[two.i]![k]! * sg;
      dj[id] = delta[id]! - di[id]!;
    });
    this.prep.shiftBaseline(delta);
    const tAlarm = this.alarmStart;
    const first = { id: this.leakId, x: fit.xs[two.i]!, iv: zone(fit.costI, two.i), q: two.qi, d: di };
    const second = { id: `L${++this.leakSeq}`, x: fit.xs[two.j]!, iv: zone(fit.costJ, two.j), q: two.qj, d: dj };
    for (const k of [first, second]) {
      this.confirmed.push({ id: k.id, tAlarm, location: k.x, locationInterval: k.iv, locationStage: 'profile', leakRate: k.q, state: 'confirmed', delta: k.d });
    }
    this.zHist.clear();
    this.zLong.clear();
    this.recoverAt = t;
    this.endEvent();
    this.startLeakGuard(t, delta);
    return true;
  }

  /**
   * Разделить событие на две утечки в заданных местах: расходы — подбор пары по откликам модели (оба > 0),
   * вклады — q·отклик для первой и остаток для второй (сумма точная).
   */
  private splitAt(t: number, delta: Record<string, number>, xs: [number, number], zones: Array<[number, number]>, stage: LocationStage): boolean {
    const twin = this.ctx.twin;
    if (!twin) return false;
    if (!this.lsq.ready) this.lsq.build(twin, this.ctx.config.geometry.length, this.prep.nominalFlow);
    const ids = Object.keys(delta);
    const sh = this.lsq.shapes(ids, (id) => this.prep.sigmaOf(id));
    if (!sh) return false;
    const near = (x: number) => sh.xs.reduce((b, v, k) => (Math.abs(v - x) < Math.abs(sh.xs[b]! - x) ? k : b), 0);
    const [i, j] = [near(xs[0]), near(xs[1])];
    if (i === j) return false;
    const yv = ids.map((id) => delta[id]! / (this.prep.sigmaOf(id) ?? 1));
    const dot = (a: number[], b: number[]) => a.reduce((acc, v, k) => acc + v * b[k]!, 0);
    const hi = sh.h[i]!;
    const hj = sh.h[j]!;
    const A = dot(hi, hi);
    const B = dot(hi, hj);
    const C = dot(hj, hj);
    const det = A * C - B * B;
    if (!(det > 1e-12)) return false;
    let qi = (C * dot(hi, yv) - B * dot(hj, yv)) / det;
    let qj = (A * dot(hj, yv) - B * dot(hi, yv)) / det;
    // если подбор пары отдал одной утечке отрицательный расход — делим поровну по откликам (обе волны видны)
    if (!(qi > 0 && qj > 0)) {
      const q = Math.max(0, dot(hi, yv) + dot(hj, yv)) / Math.max(1e-12, A + 2 * B + C);
      qi = q;
      qj = q;
    }
    const di: Record<string, number> = {};
    const dj: Record<string, number> = {};
    ids.forEach((id, k) => {
      di[id] = qi * hi[k]! * (this.prep.sigmaOf(id) ?? 0);
      dj[id] = delta[id]! - di[id]!;
    });
    this.prep.shiftBaseline(delta);
    const tAlarm = this.alarmStart;
    const parts = [
      { id: this.leakId, x: xs[0], iv: zones[0]!, q: qi, d: di },
      { id: `L${++this.leakSeq}`, x: xs[1], iv: zones[1]!, q: qj, d: dj },
    ];
    for (const k of parts) this.confirmed.push({ id: k.id, tAlarm, location: k.x, locationInterval: k.iv, locationStage: stage, leakRate: k.q, state: 'confirmed', delta: k.d });
    this.zHist.clear();
    this.zLong.clear();
    this.recoverAt = t;
    this.endEvent();
    this.startLeakGuard(t, delta);
    return true;
  }

  /** Диагностика последнего подбора «одна или две» (для стенда и калибровки). */
  lastSplit: { cost1: number; cost2: number; yy: number; x1: number; x2?: number; xb?: number; q1?: number; q2?: number; qOne: number } | null = null;

  /**
   * Подтвердить утечку: место установилось, отклонение держится и больше не меняется. Её вклад в невязки
   * уходит в норму — детектор снова готов ловить следующую, а эта остаётся в списке активных до устранения.
   */
  private confirmLeak(t: number): void {
    const delta = this.longResiduals();
    if (!Object.keys(delta).length || !this.location) return;
    const fit = this.fitOneOrTwo(delta);
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
    if (this.multi && this.splitAt(t, delta, [this.multi.x1, this.multi.x2], [this.multi.zone1, this.multi.zone2], 'wave')) return;
    if (fit?.two && this.trySplit(t, delta, fit)) return;
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
    this.zHist.clear();
    this.zLong.clear();
    this.recoverAt = t;
    this.endEvent();
    // остаток переходного процесса после утечки — как после смены режима: порог временно выше
    this.startLeakGuard(t, delta);
  }

  /**
   * Устранение утечек — одной, нескольких или всех сразу. Сдвиг невязок y (относительно нормы, в которую
   * входят вклады подтверждённых утечек) объясняем набором снятых утечек R: y ≈ −Σ_{k∈R} Δ_k.
   * Перебираем все наборы (до 2^10), берём лучший; принимаем, если он объясняет сдвиг с ошибкой меньше
   * RECOVER_TOL от величины Σ_R Δ и держится RECOVER_HITS проверок подряд. Сняли все — норма возвращается
   * к исходной полностью.
   */
  private watchRecovery(t: number): void {
    if (t - this.recoverAt < 1) return;
    this.recoverAt = t;
    const y = this.longResiduals();
    const ids = Object.keys(y);
    if (!ids.length) return;
    const sg = ids.map((id) => this.prep.sigmaOf(id) ?? 0);
    const yv = ids.map((id, i) => (sg[i]! > 0 ? y[id]! / sg[i]! : 0));
    const dv = this.confirmed.map((k) => ids.map((id, i) => (sg[i]! > 0 ? (k.delta[id] ?? 0) / sg[i]! : 0)));
    const n = this.confirmed.length;
    // баланс расходов (вход − выход) — прямо суммарный расход утечек: по нему видно, сколько утечек сняли,
    // даже когда в давлениях вклад малой утечки тонет в шуме и в неточности модели после крупной
    const L = this.ctx.config.geometry.length;
    const qIn = this.ctx.sensors.find((v) => v.kind === 'q' && v.x <= 1)?.id;
    const qOut = this.ctx.sensors.find((v) => v.kind === 'q' && v.x >= L - 1)?.id;
    const hasBal = !!qIn && !!qOut && y[qIn] !== undefined && y[qOut] !== undefined;
    const by = hasBal ? y[qIn!]! - y[qOut!]! : 0;
    const bk = this.confirmed.map((k) => (hasBal ? (k.delta[qIn!] ?? 0) - (k.delta[qOut!] ?? 0) : 0));
    // шум баланса на среднем за окно: расходомеры инерционны, независимых отсчётов ≈ 1 в секунду
    const balNoise = hasBal ? Math.hypot(this.prep.sigmaOf(qIn!) ?? 0, this.prep.sigmaOf(qOut!) ?? 0) / Math.sqrt(LEAK_WINDOW_SEC) : 0;
    // давления: шум среднего за окно по всем каналам, в долях σ
    const pAbs = (3 * Math.sqrt(ids.length)) / Math.sqrt(LEAK_WINDOW_SEC);
    const evalSet = (mask: number) => {
      let err = 0;
      let size = 0;
      let bsum = 0;
      for (let k = 0; k < n; k++) if (mask & (1 << k)) bsum += bk[k]!;
      for (let i = 0; i < ids.length; i++) {
        let sum = 0;
        for (let k = 0; k < n; k++) if (mask & (1 << k)) sum += dv[k]![i]!;
        err += (yv[i]! + sum) ** 2;
        size += sum * sum;
      }
      const sb = Math.max(3 * balNoise, BALANCE_REL * Math.abs(bsum));
      const bmis = hasBal && sb > 0 ? Math.abs(by + bsum) / sb : 0;
      err = Math.sqrt(err);
      size = Math.sqrt(size);
      // счёт набора: давления (в долях вклада) и баланс (в долях допуска)
      const score = (err / Math.max(size, 1e-9)) ** 2 + bmis ** 2;
      const ok = bmis < 1 && err < Math.max(RECOVER_TOL * size, hasBal ? pAbs : 0);
      return { err, size, score, ok };
    };
    let bestMask = 0;
    let best = { err: Infinity, size: 0, score: Infinity, ok: false };
    if (n <= 10) {
      for (let mask = 1; mask < 1 << n; mask++) {
        const r = evalSet(mask);
        if (r.score < best.score) {
          best = r;
          bestMask = mask;
        }
      }
    } else {
      // много утечек: жадно добавляем ту, что сильнее всего уменьшает счёт
      let mask = 0;
      let cur = Infinity;
      for (;;) {
        let pick = -1;
        let pickScore = cur;
        for (let k = 0; k < n; k++) {
          if (mask & (1 << k)) continue;
          const e = evalSet(mask | (1 << k)).score;
          if (e < pickScore) {
            pickScore = e;
            pick = k;
          }
        }
        if (pick < 0) break;
        mask |= 1 << pick;
        cur = pickScore;
      }
      bestMask = mask;
      if (mask) best = evalSet(mask);
    }
    // заметный сдвиг (баланс или давления) — держим норму замороженной до решения (не дольше 2 окон защиты)
    const shiftP = Math.hypot(...yv);
    const shifted = (hasBal && Math.abs(by) > 3 * balNoise) || shiftP > pAbs;
    if (shifted) {
      if (!(t < this.recoverHoldUntil)) this.recoverHoldUntil = t + 2 * this.guardSec;
    } else this.recoverHoldUntil = -Infinity;
    // сдвиг должен установиться: пока идёт переходный процесс от снятия дальней утечки, набор ещё неполон
    if (!this.recoverSnap || t - this.recoverSnap.t >= LEAK_WINDOW_SEC) {
      const prev = this.recoverSnap;
      this.recoverSnap = { t, r: y };
      let stable = !!prev;
      if (prev) {
        for (const id of ids) {
          const sgi = this.prep.sigmaOf(id);
          if (!sgi || prev.r[id] === undefined) continue;
          if (Math.abs(y[id]! - prev.r[id]!) > Math.max(SETTLE_Z * sgi, SETTLE_REL * Math.abs(y[id]!))) stable = false;
        }
      }
      this.recoverStable = stable ? this.recoverStable + 1 : 0;
    }
    const ok = bestMask !== 0 && best.size > 0 && best.ok && this.recoverStable >= 2;
    this.recoverHits = ok && bestMask === this.recoverMask ? this.recoverHits + 1 : ok ? 1 : 0;
    this.recoverMask = ok ? bestMask : 0;
    if (this.recoverHits < RECOVER_HITS) return;
    const removed = this.confirmed.filter((_, k) => bestMask & (1 << k));
    const total: Record<string, number> = {};
    for (const k of removed) for (const [id, d] of Object.entries(k.delta)) total[id] = (total[id] ?? 0) + d;
    this.prep.shiftBaseline(total, -1);
    // пока утечки были активны, норма медленно подстраивалась под мелкий дрейф — он не входит в их вклады;
    // сдвиг уже установился, поэтому коротко перенастраиваем норму по текущим замерам (как после смены режима)
    this.prep.rebaseline(t);
    this.confirmed = this.confirmed.filter((_, k) => !(bestMask & (1 << k)));
    this.recoverHits = 0;
    this.recoverMask = 0;
    this.recoverSnap = null;
    this.recoverStable = 0;
    this.recoverHoldUntil = -Infinity;
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
