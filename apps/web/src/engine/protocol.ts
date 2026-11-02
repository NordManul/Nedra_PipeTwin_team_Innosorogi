/**
 * Сообщения между основным потоком и воркерами (WP-C5).
 *
 *   воркер симуляции  ──кадры, правда, профиль──▶  основной поток  ──ТОЛЬКО кадры──▶  воркер детектора
 *                                                   ◀──прогноз, выход детектора, карточки──
 *
 * Детектор живёт в отдельном воркере со своим twin и получает только кадры датчиков
 * (граница честности, ТЗ раздел 3.5). Журнал этих сообщений показывается на экране.
 */
import type {
  ActionRule,
  CalibrationResult,
  ControlAction,
  DetectorOutput,
  EventCard,
  GroundTruth,
  LeakLabelsFile,
  PipeProfile,
  PipelineConfig,
  RequirementCheck,
  ScenarioEvent,
  SensorFrame,
  SensorSpec,
  StrategySpec,
  TwinPrediction,
} from '@pipetwin/core/contracts';

// ---------------------------------------------------------------- воркер симуляции

export type SimCommand =
  | { type: 'init'; config: PipelineConfig; seed: number; speed: number }
  | { type: 'replay'; frames: SensorFrame[]; sensors: SensorSpec[]; labels?: LeakLabelsFile; speed: number }
  | { type: 'leak'; x: number; sizePct: number; rampSec: number }
  /** Утечка в случайном месте со скрытой задержкой (слепой режим). */
  | { type: 'blindLeak'; sizePct: number; minDelaySec: number; maxDelaySec: number }
  | { type: 'clearLeaks' }
  | { type: 'control'; action: ControlAction }
  | { type: 'speed'; value: number }
  | { type: 'pause'; value: boolean }
  /** Перемотка записи (только replay). */
  | { type: 'seek'; t: number };

/** Утечка, как её видит интерфейс (правда — только для секундомера и маркера). */
export interface LeakInfo {
  id: string;
  x: number;
  tStart: number;
  sizePct?: number;
  rate?: number;
  /** Слепой режим: место и время не показываются до обнаружения. */
  hidden: boolean;
}

export type SimMessage =
  | { type: 'ready'; mode: 'sim' | 'replay'; waveSpeed: number; duration?: number; sensors: SensorSpec[] }
  | {
      type: 'batch';
      t: number;
      frames: SensorFrame[];
      profile?: PipeProfile;
      leaks: LeakInfo[];
      truth: GroundTruth;
      log: string[];
      /** Новые события сессии во времени plant — для экспорта сценария (WP-C6). */
      events: ScenarioEvent[];
      done: boolean;
      /** Длительность записи (replay), с. */
      duration?: number;
    }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------- воркер детектора

export type DetectCommand =
  | { type: 'init'; config: PipelineConfig; strategy: StrategySpec; rules: ActionRule[] }
  | { type: 'strategy'; strategy: StrategySpec }
  /** Единственный канал данных к детектору: кадры датчиков. */
  | { type: 'frames'; frames: SensorFrame[] }
  | { type: 'calibrate'; unknowns: string[]; windowSec: number };

export type DetectMessage =
  | { type: 'ready'; strategy: StrategySpec; checks: Record<string, RequirementCheck> }
  | {
      type: 'batch';
      preds: TwinPrediction[];
      outs: DetectorOutput[];
      /** Новые и обновлённые карточки событий. */
      cards: EventCard[];
      twinProfile?: PipeProfile;
    }
  | { type: 'calibrated'; result: CalibrationResult }
  | { type: 'error'; message: string };
