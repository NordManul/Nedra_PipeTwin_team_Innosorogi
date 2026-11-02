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
    this.last = null;
    this.alarmed = false;
    this.eventClass = undefined;
    this.holdUntil = NaN;
    this.location = null;
    this.waveEst = null;
    this.flowImbalance = NaN;
    this.onset = undefined;
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
    for (const [id, z] of Object.entries(s.z)) {
      let w = this.zHist.get(id);
      if (!w) this.zHist.set(id, (w = new RollingWindow(nz)));
      w.push(z);
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
  private firstChanges(t: number): Record<string, FirstChange> {
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
      for (let i = win[0] - nMa; i >= 0; i--) {
        const ma = w.meanRange(i, i + nMa);
        if (Math.abs(ma - pre) > lim && Math.sign(ma - pre) === Math.sign(d)) {
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
      if (e.leakLike(dp, this.step(e.q))) continue;
      if (t - this.lastRegimeT > 5) {
        this.setEvent(e.cls, t);
        // новая рабочая точка: накопленное до события больше не относится к делу
        if (!this.alarmed) this.stat.rearm();
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
      if (src) this.waveEst = { x: src.x, interval: src.interval };
    }
    if (s.t - this.locatedAt < 1) return;
    this.locatedAt = s.t;
    const L = this.ctx.config.geometry.length;
    const settled = s.t - this.alarmStart >= (1.5 * L) / this.sc.waveSpeed;
    const method = this.spec.localization;
    const statEst: LocationEstimate | null =
      out.location !== undefined ? { x: out.location, interval: out.locationInterval ?? [out.location, out.location] } : null;
    let est: LocationEstimate | null;
    if (method === 'wave-timing' || !settled) {
      // до затухания волн стационарные методы не годятся: только волна или оценка самого детектора
      est = this.waveEst ?? statEst;
    } else {
      let steady: LocationEstimate | null = null;
      for (const m of [...new Set<LocalizationMethod>([method, 'lsq', 'hgl'])]) {
        steady = this.locateBy(m, s);
        if (steady) break;
      }
      if (steady && this.location && this.location !== this.waveEst) {
        // сглаживание стационарной оценки (τ ≈ 10 с), чтобы маркер не прыгал
        const a = 0.1;
        const prev = this.location;
        steady = {
          x: prev.x + a * (steady.x - prev.x),
          interval: [prev.interval[0] + a * (steady.interval[0] - prev.interval[0]), prev.interval[1] + a * (steady.interval[1] - prev.interval[1])],
          rate: steady.rate,
        };
      }
      est = combine(steady, this.waveEst) ?? statEst;
    }
    if (est) this.location = est;
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
    const guard = s.t < this.guardUntil ? this.opts.guardFactor ?? 1.5 : 1;
    const ratio = out.threshold > 0 ? out.score / (out.threshold * guard) : 0;
    const raw = !this.opts.silent && (out.alarm ?? ratio > 1);
    let phase: DetectorPhase = 'running';

    if (this.alarmed) {
      const canClear = s.t - this.alarmStart >= (this.opts.holdSec ?? 30);
      if (canClear && ratio < 0.5 && !out.alarm) {
        this.alarmed = false;
        this.location = null;
        this.waveEst = null;
        this.lsq = new LsqLocator();
        this.stat.rearm();
        this.prep.freeze(false);
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
      this.prep.freeze(false);
    }

    // порог в выходе — с учётом защиты от переходного режима (его видно на графике)
    const result: DetectorOutput = {
      t: s.t,
      score: out.score,
      threshold: out.threshold * guard,
      z: s.z,
      unhealthySensors: this.prep.unhealthy(),
      phase,
      alarm: this.alarmed,
    };
    if (s.t < this.eventUntil || this.alarmed) result.eventClass = this.eventClass;
    if (this.alarmed && this.location) {
      result.location = this.location.x;
      result.locationInterval = this.location.interval;
    }
    // баланс расходов осмыслен, когда волна от утечки дошла до обоих концов (≈ один пробег)
    const flowsSettled = s.t - this.alarmStart >= this.ctx.config.geometry.length / this.sc.waveSpeed;
    const rate = out.leakRate ?? this.location?.rate ?? (flowsSettled && Number.isFinite(this.flowImbalance) ? Math.max(0, this.flowImbalance) : undefined);
    if (this.alarmed && rate !== undefined) result.leakRate = rate;
    if (this.alarmed && this.onset !== undefined) result.onsetTime = this.onset;
    const contrib = this.contributions(s, out);
    if (contrib.length) result.contributions = contrib;
    return result;
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

/** Объединить две оценки места с весами 1/ширина² интервала (точная оценка доминирует). */
function combine(a: LocationEstimate | null, b: LocationEstimate | null): LocationEstimate | null {
  if (!a || !b) return a ?? b;
  const wa = 1 / Math.max(100, (a.interval[1] - a.interval[0]) / 2) ** 2;
  const wb = 1 / Math.max(100, (b.interval[1] - b.interval[0]) / 2) ** 2;
  const x = (wa * a.x + wb * b.x) / (wa + wb);
  const half = 1 / Math.sqrt(wa + wb);
  return { x, interval: [x - half, x + half], rate: a.rate ?? b.rate };
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
