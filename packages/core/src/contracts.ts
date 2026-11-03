/**
 * PipeTwin — контракты между модулями.
 *
 * Только описания типов, без логики. Подробное описание каждого контракта,
 * правила и примеры — в docs/contracts.md. Формы файлов на диске
 * дополнительно описаны JSON Schema в каталоге schemas/.
 *
 * Правила (ТЗ, раздел 7.2):
 *  1. Внутри системы всё в СИ: Па (абсолютное давление), К, м, м³/с, с, кг/м³, Па·с.
 *     Перевод единиц — только на границе (импорт, загрузчик конфига, интерфейс).
 *  2. Время — секунды от начала потока (float), а не номер отсчёта.
 *  3. Датчики адресуются строковым id ("p_km12"), а не индексом массива.
 *  4. Детектор никогда не импортирует plant и не получает ничего, что знает об утечке.
 *  5. Добавить необязательное поле — можно, предупредив остальных.
 *     Переименовать или удалить — только с согласия всех троих.
 *     Каждое изменение этого файла — отдельный коммит с префиксом `contracts:`.
 */

// ============================================================================
// 0. Общие типы
// ============================================================================

/** Версия формата контрактов. Повышается при несовместимом изменении. */
export const CONTRACTS_VERSION = 1 as const;

/** Секунды от начала потока (модельное время или время записи). */
export type Seconds = number;

/** Строковый идентификатор датчика: латиница, цифры, `_` и `-`, начинается с буквы. */
export type SensorId = string;

/** Род измеряемой величины: давление, температура, объёмный расход. */
export type SensorKind = 'p' | 'T' | 'q';

/** Значения по датчикам: id датчика → число в СИ. */
export type SensorValues = Record<SensorId, number>;

/**
 * Кусочно-заданная функция времени для граничных условий и уставок.
 * Число — постоянное значение. Точки [t, value] сортированы по t;
 * до первой точки — значение первой, после последней — значение последней.
 */
export type Schedule =
  | number
  | {
      points: Array<[t: Seconds, value: number]>;
      /** 'linear' — линейная интерполяция, 'step' — значение держится до следующей точки. */
      interp: 'linear' | 'step';
    };

// ============================================================================
// 1. Статусы параметров (ТЗ, раздел 8, правило 1; WP-A1)
// ============================================================================

/**
 * Откуда взялось значение параметра:
 *  - given      — дали организаторы / явно указано во входном конфиге;
 *  - default    — взято из библиотеки значений по умолчанию;
 *  - calibrated — подобрано калибровкой по данным без утечки.
 */
export type ParamStatus = 'given' | 'default' | 'calibrated';

/**
 * Метаданные одного числового параметра разрешённого конфига.
 * Сами значения лежат в PipelineConfig как обычные числа в СИ,
 * а это — сопроводительная информация для интерфейса, логов и калибровки.
 */
export interface ParamMeta {
  /** Путь к полю в PipelineConfig через точку: "geometry.roughness", "sensors.p_km10.noiseStd". */
  path: string;
  /** Значение в СИ (совпадает со значением в PipelineConfig). */
  value: number;
  status: ParamStatus;
  /** Как было записано во входе, до перевода в СИ: "0,08 мм", "12 bar". */
  original?: string;
  /** Откуда значение: имя файла и лист/строка, "library:steel-old", "calibration:2026-11-06T12:00Z". */
  source?: string;
  /** Для calibrated: стандартная ошибка оценки в СИ. */
  std?: number;
  /** Предупреждения по параметру: «не определяется по имеющимся датчикам» и т. п. */
  warnings?: string[];
}

// ============================================================================
// 2. PipelineConfig — труба, среда, датчики, граничные условия
//    Создаёт: C (импорт), A (схема и resolveConfig). Используют: A, B, C.
// ============================================================================

/** Модель плотности ρ(T), кг/м³. */
export type DensityModel =
  | { model: 'constant'; rho: number }
  /** ρ(T) = rho20 − xi·(T − 293.15). xi, кг/(м³·К). */
  | { model: 'linear'; rho20: number; xi: number };

/** Модель вязкости. Все варианты дают кинематическую вязкость ν(T), м²/с; μ = ρ·ν. */
export type ViscosityModel =
  | { model: 'constant'; nu: number }
  /** Филонов–Рейнольдс: ν(T) = nu0·exp(−u·(T − T0)). u, 1/К. */
  | { model: 'filonov-reynolds'; nu0: number; T0: number; u: number }
  /** Вальтер (ASTM D341) по двум точкам [T, ν]. */
  | { model: 'walther'; points: [[T: number, nu: number], [T: number, nu: number]] };

/** Формула коэффициента трения (WP-A3). */
export type FrictionModel = 'colebrook' | 'swamee-jain' | 'haaland';

/** Режим расчёта тепла в plant (WP-A6). */
export type ThermalMode = 'none' | 'quasi-steady' | 'advection';

export interface Geometry {
  /** Длина участка, м. */
  length: number;
  /** Внутренний диаметр, м. */
  diameter: number;
  /** Толщина стенки, м. */
  wallThickness: number;
  /** Модуль упругости материала стенки, Па (сталь ≈ 2,1·10¹¹). Нужен для скорости волны. */
  wallModulus: number;
  /** Абсолютная эквивалентная шероховатость, м. */
  roughness: number;
  /**
   * Профиль высот: точки [x, z] в м, x по возрастанию от 0 до length.
   * Между точками — линейная интерполяция. Один элемент = горизонтальная труба.
   */
  elevation: Array<[x: number, z: number]>;
}

export interface Fluid {
  /** Имя из библиотеки или произвольное: "light-crude", "diesel", "water". */
  name: string;
  /** Фаза среды. 'gas' — заготовка WP-A9. */
  phase: 'liquid' | 'gas';
  density: DensityModel;
  viscosity: ViscosityModel;
  /** Удельная теплоёмкость, Дж/(кг·К). */
  heatCapacity: number;
  /** Объёмный модуль упругости жидкости K, Па. */
  bulkModulus: number;
  /** Давление насыщенных паров, Па (абс.). Ниже — разрыв сплошности, plant ограничивает давление. */
  vaporPressure: number;
}

export interface Thermal {
  /** Температура окружающей среды (грунта или воздуха), К. */
  ambientTemp: number;
  /** Полный коэффициент теплопередачи k, Вт/(м²·К), отнесён к внутреннему диаметру. */
  heatTransferCoef: number;
}

/**
 * Граничное условие на входе участка (для plant).
 *  - pressure: задано давление;
 *  - flow:     задан объёмный расход;
 *  - pump:     насос с характеристикой H = H0·s² − b·Q², s — относительная частота вращения.
 */
export type InletBoundary =
  | { type: 'pressure'; pressure: Schedule }
  | { type: 'flow'; flow: Schedule }
  | {
      type: 'pump';
      /** Давление на всасе, Па (абс.). */
      suctionPressure: Schedule;
      /** Напор при нулевой подаче и s = 1, м. */
      H0: number;
      /** Коэффициент характеристики, с²/м⁵. */
      b: number;
      /** Относительная частота вращения s, по умолчанию 1. */
      speed?: Schedule;
    };

/**
 * Граничное условие на выходе участка (для plant).
 *  - pressure: задано давление;
 *  - flow:     задан расход;
 *  - valve:    задвижка перед резервуаром: Q = Cv·τ(t)·sqrt(Δp/ρ);
 *  - closed:   заглушка (Q = 0).
 */
export type OutletBoundary =
  | { type: 'pressure'; pressure: Schedule }
  | { type: 'flow'; flow: Schedule }
  | {
      type: 'valve';
      /** Давление за задвижкой, Па (абс.). */
      downstreamPressure: Schedule;
      /** Пропускная способность при полном открытии, м². */
      cv: number;
      /** Степень открытия τ ∈ [0, 1]. */
      opening: Schedule;
    }
  | { type: 'closed' };

export interface Boundary {
  inlet: InletBoundary;
  outlet: OutletBoundary;
  /** Температура продукта на входе, К. */
  inletTemp: Schedule;
}

/**
 * Описание одного датчика в разрешённом конфиге (всё в СИ).
 * Параметры «порчи» сигнала (WP-A7) использует только модель датчиков plant;
 * для записей (replay) они оцениваются по данным и носят справочный характер.
 */
export interface SensorSpec {
  id: SensorId;
  kind: SensorKind;
  /** Положение от входа, м. 0 — вход, geometry.length — выход. */
  x: number;
  /** Подпись для интерфейса: "PT-101, км 10". */
  label?: string;
  /** СКО шума в единицах величины (Па, К или м³/с). */
  noiseStd: number;
  /** Постоянная времени запаздывания первого порядка, с. 0 — без запаздывания. */
  lagSec: number;
  /** Скорость дрейфа, единицы величины в секунду. */
  drift?: number;
  /** Постоянное смещение показаний, единицы величины. Кандидат на калибровку. */
  bias?: number;
  /** Шаг квантования (разрешение прибора), единицы величины. */
  quantum?: number;
  /** Диапазон шкалы [min, max] в СИ. Выход за него — флаг здоровья датчика. */
  range?: [min: number, max: number];
  /** Вероятность пропуска отсчёта, 0..1. */
  dropoutProb?: number;
  /** Вероятность выброса на отсчёт, 0..1. */
  outlierProb?: number;
  /** Амплитуда выброса в долях noiseStd. */
  outlierScale?: number;
  /** СКО дрожания метки времени, с. */
  timeJitterSec?: number;
}

/**
 * Какие замеры twin берёт как граничные условия (WP-A4).
 *  - 'auto' — выбрать по наличию датчиков в порядке p_in+q_in, p_in+p_out, p_out+q_out.
 * Остальные датчики twin прогнозирует, и по ним считается невязка.
 */
export type TwinBoundaryMode = 'auto' | 'p_in+q_in' | 'p_in+p_out' | 'p_out+q_out';

export interface TwinSettings {
  /**
   * Тип модели twin:
   *  - 'transient' — нестационарная модель (MOC без утечки), граничные условия — замеры давления
   *    (или расхода) на концах; повторяет волны от смены режима, поэтому не путает режим с утечкой;
   *  - 'steady' — квазистационарная модель «как у диспетчера» (ТЗ, WP-A4).
   * По умолчанию 'transient', если на обоих концах есть датчик давления или расхода, иначе 'steady'.
   */
  model?: 'steady' | 'transient';
  /** Для steady-модели: какие замеры брать как граничные условия. */
  boundaryMode: TwinBoundaryMode;
  /**
   * Постоянная времени фильтра первого порядка на граничных замерах нестационарного twin, с.
   * 0 или нет — без фильтра. Меньше шума в прогнозах, но прогноз запаздывает на эту величину.
   */
  inputFilterSec?: number;
  /**
   * Вид фильтра граничных замеров (при inputFilterSec > 0): 'ema' — первого порядка;
   * 'kalman' — оценка уровня со сбросом при манёвре (рампа насоса, задвижки), без запаздывания на переходах.
   */
  inputFilter?: 'ema' | 'kalman';
  /** Явный выбор граничных датчиков; без них — датчики нужного рода с x = 0 / x = length. */
  inletPressureSensor?: SensorId;
  outletPressureSensor?: SensorId;
  flowSensor?: SensorId;
  inletTempSensor?: SensorId;
}

export interface Numerics {
  /** Шаг расчётной сетки, м. Для plant шаг по времени Δt = dx / a. */
  dx: number;
  frictionModel: FrictionModel;
  thermalMode: ThermalMode;
  /** Принудительная скорость волны, м/с. Без неё — формула Жуковского–Кортевега. */
  waveSpeed?: number;
}

/**
 * Разрешённый конфиг трубы: все поля заполнены, всё в СИ.
 * Получается из PipelineConfigInput функцией resolveConfig (WP-A1).
 * Именно его получают twin, plant, детекторы и интерфейс.
 */
export interface PipelineConfig {
  schemaVersion: typeof CONTRACTS_VERSION;
  meta: { name: string; description?: string };
  geometry: Geometry;
  fluid: Fluid;
  thermal: Thermal;
  boundary: Boundary;
  sensors: SensorSpec[];
  /** Частота опроса датчиков, Гц (номинальная; реальные метки времени могут гулять). */
  sampling: { rateHz: number };
  /** Атмосферное давление, Па. Для перевода избыточного давления в абсолютное и для q_leak. */
  ambientPressure: number;
  twin: TwinSettings;
  numerics: Numerics;
}

/**
 * Результат resolveConfig: конфиг + статусы всех числовых параметров.
 * `calibrationCandidates` — пути параметров со статусом default,
 * которые имеет смысл уточнить калибровкой.
 */
export interface ResolvedConfig {
  config: PipelineConfig;
  params: ParamMeta[];
  calibrationCandidates: string[];
  warnings: string[];
}

/**
 * Числовое поле во входном (необработанном) конфиге. Допускаются:
 *  - число — уже в СИ, статус given;
 *  - строка с единицей — "1,2 МПа", "530 мм", "45 сСт", "60 °C";
 *  - объект — значение, единица, статус и источник явно.
 */
export type QuantityInput =
  | number
  | string
  | { value: number | string; unit?: string; status?: ParamStatus; source?: string };

/**
 * Входной конфиг в том виде, в каком его пишет человек или импорт C.
 * Любое поле может отсутствовать — resolveConfig дополнит из библиотеки
 * и пометит статусом default. Точная форма — schemas/pipeline.schema.json.
 * Тип намеренно нестрогий: валидацию делает zod-схема A, а не компилятор.
 */
export interface PipelineConfigInput {
  schemaVersion: typeof CONTRACTS_VERSION;
  meta?: { name?: string; description?: string };
  geometry?: Record<string, unknown>;
  fluid?: Record<string, unknown>;
  thermal?: Record<string, unknown>;
  boundary?: Record<string, unknown>;
  sensors?: Array<Record<string, unknown>>;
  sampling?: Record<string, unknown>;
  ambientPressure?: QuantityInput;
  twin?: Partial<TwinSettings>;
  numerics?: Partial<Numerics>;
}

// ============================================================================
// 3. SensorFrame — показания всех датчиков в момент t
//    Создаёт: A (plant) или C (запись, поток). Используют: B, C.
// ============================================================================

export interface SensorFrame {
  /** Время кадра, с от начала потока. Строго возрастает от кадра к кадру. */
  t: Seconds;
  /** id датчика → значение в СИ. Датчик без отсчёта в этом кадре может отсутствовать. */
  values: SensorValues;
  /** false — пропуск или сбой; отсутствие ключа = true. Значение при false не используется. */
  valid?: Record<SensorId, boolean>;
}

// ============================================================================
// 4. Twin — модель без утечки и её прогноз
//    Создаёт: A (twin). Используют: B, C.
// ============================================================================

export interface TwinPrediction {
  /** Время кадра, по которому сделан прогноз. Совпадает с SensorFrame.t. */
  t: Seconds;
  /** Ожидаемые значения на датчиках, СИ. */
  values: SensorValues;
  /**
   * Датчики, взятые как граничные условия. Их прогноз равен замеру по построению,
   * невязка по ним всегда ноль — детекторы должны их исключать.
   */
  inputs: SensorId[];
  /** false — twin не смог посчитать (нет граничных замеров, не сошёлся расчёт). */
  ok: boolean;
  /** Причина, если ok = false. */
  error?: string;
  /**
   * Чувствительности ∂прогноз/∂параметр (WP-A4): путь параметра → (датчик → производная в СИ).
   * Считаются по запросу, могут отсутствовать.
   */
  sensitivities?: Record<string, SensorValues>;
}

/** Профиль по узлам сетки: для отрисовки схемы трубы и для эталонных тестов. */
export interface PipeProfile {
  t: Seconds;
  /** Координаты узлов, м. */
  x: Float64Array;
  /** Давление, Па (абс.). */
  p: Float64Array;
  /** Объёмный расход, м³/с. */
  q: Float64Array;
  /** Температура, К. */
  T: Float64Array;
}

/** Цифровой двойник: принимает только кадры датчиков. */
export interface TwinModel {
  reset(cfg: PipelineConfig): void;
  /** Прогноз на датчиках по граничным замерам из кадра. */
  predict(frame: SensorFrame): TwinPrediction;
  /** Отклик датчиков на гипотетическую утечку q (м³/с) в точке x (м) — для локализации L2. */
  leakResponse?(x: number, q: number): SensorValues;
  /** Последний рассчитанный профиль — для интерфейса; undefined — расчёта ещё не было. */
  profile?(): PipeProfile | undefined;
  /**
   * Стационарный профиль без утечки от одного конца трубы при заданных давлении (Па) и расходе (м³/с)
   * на этом конце — для локализации L1 (пересечение линий гидравлического уклона).
   */
  steadyProfileFrom?(end: 'inlet' | 'outlet', p: number, q: number): PipeProfile;
}

// ============================================================================
// 5. Утечки и правда — то, что знает только plant
//    Детектору эти типы не передаются никогда.
// ============================================================================

/** Утечка, внедряемая в plant: истечение через отверстие q = Cd·A·sqrt(2·p_изб/ρ). */
export interface LeakEvent {
  id: string;
  /** Место, м от входа. */
  x: number;
  /** Площадь отверстия при полном развитии, м². */
  area: number;
  /** Коэффициент расхода отверстия, обычно 0,6–0,65. */
  cd: number;
  /** Начало утечки, с. */
  tStart: Seconds;
  /** Время линейного нарастания площади от 0 до area, с. 0 — мгновенно. */
  rampSec: number;
}

/** Ручное управление режимом на демо и в сценариях (жюри «крутит насос»). */
export type ControlAction =
  | { type: 'pump'; changePct: number; rampSec?: number }
  | { type: 'valve'; opening: number; rampSec?: number }
  | { type: 'noise'; scale: number }
  | { type: 'sensor-fault'; sensorId: SensorId; mode: SensorFaultMode; magnitude?: number; durationSec?: number };

/** Вид отказа датчика для сценариев и проверки WP-B3. */
export type SensorFaultMode = 'stuck' | 'step' | 'drift' | 'dropout' | 'spike';

/** Правда об утечке — для метрик стенда и секундомера интерфейса. */
export interface LeakTruth {
  id: string;
  x: number;
  tStart: Seconds;
  /** Конец утечки, с; нет — до конца потока. */
  tEnd?: Seconds;
  /** Расход утечки в установившемся режиме, м³/с. */
  rate?: number;
  /** Доля от расхода на входе до утечки, 0..1. */
  fraction?: number;
}

export interface GroundTruth {
  leaks: LeakTruth[];
  /** Режимные события без утечки (для подсчёта ложных тревог в E5). */
  regimeEvents: Array<{ t: Seconds; type: ControlAction['type'] }>;
}

// ============================================================================
// 6. DataSource — откуда идут кадры
//    Создают: A (SimulatedSource), C (ReplaySource, StreamSource). Используют: C, стенд.
// ============================================================================

export type DataSourceKind = 'simulated' | 'replay' | 'stream';

export interface DataSource {
  readonly kind: DataSourceKind;
  /** Датчики этого источника. Набор id совпадает с ключами SensorFrame.values. */
  readonly sensors: SensorSpec[];
  /** Номинальная частота опроса, Гц. */
  readonly sampleRateHz: number;
  /** Текущее модельное время источника, с. */
  readonly t: Seconds;
  /** true — данных больше не будет (запись кончилась, поток закрыт). */
  readonly done: boolean;
  /**
   * Продвинуть время на dt секунд и вернуть все кадры с t в (t_prev, t_prev + dt].
   * Пустой массив — новых отсчётов за этот интервал нет (это не конец данных).
   * Частота опроса, шаг расчёта plant и тик интерфейса не обязаны совпадать.
   */
  step(dt: Seconds): SensorFrame[];
  /** Вернуться к началу (для replay и simulated). */
  reset?(): void;
  /** Внедрить утечку. Только simulated. */
  injectLeak?(e: LeakEvent): void;
  /** Ручное управление режимом. Только simulated. */
  applyControl?(a: ControlAction): void;
  /** Правда об утечках — для стенда и секундомера; детектору не передаётся. */
  truth?(): GroundTruth;
  /** Полный профиль plant по узлам — для схемы трубы в интерфейсе. */
  profile?(): PipeProfile;
}

// ============================================================================
// 7. Detector — кадр + прогноз → тревога, место, объём
//    Создаёт: B. Используют: C, стенд.
// ============================================================================

/** Имена детекторов в реестре (ТЗ, WP-B2). */
export type DetectorName =
  | 'threshold' //   D1 — порог на сглаженной z
  | 'cusum' //       D2 — двусторонний CUSUM Пейджа
  | 'ewma' //        D3 — EWMA-карта
  | 'mass-balance' // D4 — баланс массы с поправкой на аккумуляцию
  | 'npw' //         D5 — волна отрицательного давления
  | 'kalman' //      D6 — фильтр Калмана с расширенным состоянием
  | 'fusion' //      D7 — слияние нескольких детекторов
  | 'rls' //         D8 — взаимное предсказание датчиков, без физики
  | 'pca'; //        D9 — PCA и статистика SPE, без физики

/** Методы локализации (ТЗ, WP-B4). */
/**
 * Стадия оценки места, от грубой к точной:
 *  segment — отрезок вокруг датчика, первым увидевшего спад давления (сразу при тревоге);
 *  wave    — по разнице времён прихода волны (секунды, если фронт виден);
 *  profile — по профилю давлений после затухания волн (десятки секунд);
 *  ml      — по обученной на симуляторе модели (k ближайших соседей).
 */
export type LocationStage = 'segment' | 'wave' | 'profile' | 'ml';

/** Активная утечка в выходе детектора. */
export interface ActiveLeak {
  /** Номер утечки за сессию: «L1», «L2»… */
  id: string;
  /** Время тревоги по этой утечке, с. */
  tAlarm: Seconds;
  location?: number;
  locationInterval?: [lo: number, hi: number];
  locationStage?: LocationStage;
  /** Оценка расхода утечки, м³/с. */
  leakRate?: number;
  /**
   * detecting — событие в развитии, место уточняется;
   * confirmed — место установилось, вклад утечки учтён в норме: детектор готов ловить следующую.
   */
  state: 'detecting' | 'confirmed';
}

export type LocalizationMethod =
  | 'hgl' //         L1 — пересечение линий гидравлического уклона
  | 'lsq' //         L2 — МНК-подбор (x, q_leak) по чувствительностям twin
  | 'wave-timing'; // L3 — разница времён прихода волны

/** Требование детектора к датчикам. Не выполнено — детектор выбывает с причиной, а не падает. */
export interface SensorRequirement {
  kind: SensorKind;
  /** Минимальное число датчиков этого рода, по умолчанию 1. */
  min?: number;
  /** Где должны стоять: на входе, на выходе, на обоих концах, где угодно (по умолчанию). */
  at?: 'inlet' | 'outlet' | 'both-ends' | 'any';
}

export interface DetectorRequirements {
  sensors: SensorRequirement[];
  /** Минимальное общее число датчиков любого рода (D8, D9: ≥ 3). */
  minSensorsTotal?: number;
  /** Минимальная частота опроса, Гц (D5: 10). */
  minSampleRateHz?: number;
  /** Нужен ли прогноз twin (false для D8, D9). */
  needsTwin: boolean;
}

/** Ответ на проверку требований. */
export interface RequirementCheck {
  ok: boolean;
  /** Человекочитаемые причины выбывания: «нет расходомера на выходе». */
  reasons: string[];
}

/**
 * Что получает детектор при запуске. Ни одно поле не знает об утечке:
 * конфиг трубы (без LeakEvent), датчики и, при needsTwin, ссылка на twin.
 */
export interface DetectorContext {
  config: PipelineConfig;
  sensors: SensorSpec[];
  sampleRateHz: number;
  twin?: TwinModel;
}

/** Параметры детектора: в долях σ и в секундах, а не в паскалях и отсчётах (ТЗ, раздел 8, правило 3). */
export type DetectorParams = Record<string, number>;

/** Класс события по сигнатуре (WP-B3). */
export type EventClass = 'leak' | 'pump-change' | 'valve-change' | 'sensor-fault' | 'unknown';

/** Состояние детектора. */
export type DetectorPhase =
  /** Прогрев: оценка σ и обучение на окне без утечки, тревоги не выдаются. */
  | 'warmup'
  | 'running'
  /** Подозрение на утечку: оценки σ и онлайн-калибровка заморожены. */
  | 'suspect'
  | 'alarm';

export interface DetectorOutput {
  /** Время кадра, по которому принято решение. */
  t: Seconds;
  phase: DetectorPhase;
  alarm: boolean;
  /** Уверенность (статистика детектора), безразмерная, для порогов и графиков. */
  score: number;
  /** Порог, с которым сравнивается score, — для графика «невязка и порог». */
  threshold?: number;
  /** Оценка места, м от входа. */
  location?: number;
  /**
   * Интервал места [lo, hi], м: истинное место внутри с вероятностью ≈ 90% (откалибровано стендом).
   * Сразу при тревоге — широкий отрезок, затем сужается по мере накопления данных (locationStage).
   */
  locationInterval?: [lo: number, hi: number];
  /** Откуда текущая оценка места — для оператора: насколько ей можно доверять. */
  locationStage?: LocationStage;
  /**
   * Все активные утечки (несколько подряд — каждая отдельно). Утечка пропадает из списка,
   * когда система сама увидела её устранение (показания вернулись к норме).
   * location / locationInterval / locationStage выше — для последнего события.
   */
  leaks?: ActiveLeak[];
  /** Оценка расхода утечки, м³/с. */
  leakRate?: number;
  /** Нормированные невязки z = r/σ по датчикам — для графиков и объяснения. */
  z?: SensorValues;
  /** Класс события; для тревоги без класса — 'unknown'. */
  eventClass?: EventClass;
  /** Датчики, признанные недостоверными (залипание, выход за диапазон, долгий пропуск). */
  unhealthySensors?: SensorId[];
  /** Вклад датчиков в сигнал: доли, сумма = 1, по убыванию (для карточки события). */
  contributions?: Array<{ sensorId: SensorId; share: number }>;
  /** Оценка момента начала события, с — для объёма потерь до тревоги. */
  onsetTime?: Seconds;
}

export interface Detector {
  readonly name: DetectorName | string;
  readonly requires: DetectorRequirements;
  /** Проверить, подходит ли детектор к данному набору датчиков. Не бросает исключений. */
  check(ctx: DetectorContext): RequirementCheck;
  /** Сброс состояния и запуск с параметрами. Вызывается до первого update. */
  reset(ctx: DetectorContext, params: DetectorParams): void;
  /**
   * Обработать очередной кадр. pred = null, если twin не нужен или не смог посчитать.
   * Кадры поступают по возрастанию t; шаг по времени может быть неравномерным.
   */
  update(frame: SensorFrame, pred: TwinPrediction | null): DetectorOutput;
}

/** Фабрика детекторов: реестр по имени (ТЗ, раздел 5.4). */
export type DetectorFactory = () => Detector;
export type DetectorRegistry = Record<string, DetectorFactory>;

// ============================================================================
// 8. Стратегия — что выбрал стенд (configs/strategy.selected.json)
//    Создаёт: B (select_strategy.py). Использует: C (по умолчанию в демо), стенд.
// ============================================================================

export interface StrategyMember {
  detector: DetectorName;
  params: DetectorParams;
  /** Вес в слиянии D7. */
  weight?: number;
}

export interface StrategySpec {
  /** Имя основного детектора. Для слияния — 'fusion' и список members. */
  strategy: DetectorName;
  params: DetectorParams;
  /** Только для strategy = 'fusion'. */
  members?: StrategyMember[];
  /** Правило слияния для fusion. */
  fusionRule?: 'vote' | 'weighted-sum';
  localization: LocalizationMethod;
  /** Включён ли сигнатурный фильтр режимных событий (WP-B3). */
  signatureFilter: boolean;
  /** Длительность прогрева, с (оценка шума и обучение без утечки). */
  warmupSec: number;
}

/** Файл configs/strategy.selected.json. */
export interface SelectedStrategyFile extends StrategySpec {
  schemaVersion: typeof CONTRACTS_VERSION;
  /** Момент выбора, ISO 8601 UTC. null — стратегия по умолчанию, выбор ещё не проводился. */
  selectedAt: string | null;
  /** Метрики победителя на тестовых seed. Числа — результат прогона, не прогноз. */
  evidence: {
    ttd_med_s: number;
    ttd_p95_s?: number;
    mdl_pct: number;
    far_per_day: number;
    loc_med_m?: number;
    pod_5pct?: number;
  } | null;
  /** Второе место. */
  runnerUp?: DetectorName | null;
  /** Идентификатор набора прогонов, по которому сделан выбор (хэш runs.csv). */
  runsHash?: string;
}

// ============================================================================
// 9. Сценарий эксперимента (configs/scenarios/*.json)
//    Создаёт: B. Используют: A, B, C (экспорт сессии демо как сценария).
// ============================================================================

/** Размер утечки: либо доля расхода, либо площадь отверстия. */
export type LeakSize =
  /** Процент от расхода на входе до утечки (2 = 2%). Plant переводит в площадь. */
  | { sizePct: number }
  | { area: number; cd?: number };

export type ScenarioEvent =
  | ({ t: Seconds; type: 'leak'; id?: string; x: number; rampSec?: number } & LeakSize)
  | { t: Seconds; type: 'pump'; changePct: number; rampSec?: number }
  | { t: Seconds; type: 'valve'; opening: number; rampSec?: number }
  | { t: Seconds; type: 'noise'; scale: number }
  | { t: Seconds; type: 'sensor-fault'; sensorId: SensorId; mode: SensorFaultMode; magnitude?: number; durationSec?: number };

export type ScenarioSource =
  /** Данные генерирует наш plant. */
  | { type: 'simulated' }
  /** Запись с замерами: путь к файлу, профиль маппинга, файл разметки утечек. */
  | { type: 'replay'; file: string; mapping?: string; labels?: string };

export interface Scenario {
  schemaVersion: typeof CONTRACTS_VERSION;
  id: string;
  description?: string;
  /** Путь к конфигу трубы (относительно корня репозитория) или сам конфиг. */
  pipeline: string | PipelineConfigInput;
  /**
   * Отличия «настоящей» трубы от того, что знает twin (ТЗ, раздел 3.2).
   * Применяются только к plant. Пример: { "geometry": { "roughness": "0,08 мм" } }.
   */
  truthOverrides?: Partial<PipelineConfigInput>;
  source: ScenarioSource;
  durationSec: number;
  seed: number;
  /** Множитель шума всех датчиков относительно конфига, по умолчанию 1. */
  noiseScale?: number;
  /** Длительность прогрева до первого допустимого события, с (по умолчанию 60). */
  warmupSec?: number;
  /** Назначение seed в выборе стратегии (ТЗ, раздел 14). */
  split?: 'validation' | 'test' | 'demo';
  events: ScenarioEvent[];
  /** Утечки, накладываемые на запись без утечки через чувствительности twin (WP-B6). */
  overlayLeaks?: Array<Extract<ScenarioEvent, { type: 'leak' }>>;
  tags?: string[];
}

// ============================================================================
// 10. Результат прогона (results/runs.csv) — строка на пару «сценарий × стратегия»
//     Создаёт: B (раннер). Используют: A, B, C. Порядок колонок — как здесь.
// ============================================================================

export const RUNS_CSV_COLUMNS = [
  'scenario_id',
  'strategy_id',
  'seed',
  'leak_present',
  'leak_x',
  'leak_frac',
  't_leak',
  't_alarm',
  'ttd',
  'false_alarms',
  'loc_est',
  'loc_err',
  'rate_est',
  'rate_err',
  'v_loss',
  'cpu_ms_per_tick',
  // дополнения к ТЗ (необязательные, в конце):
  'split',
  'noleak_s',
  'ttd_min_phys',
  'loc_lo',
  'loc_hi',
  'loc_stage',
  'loc0_lo',
  'loc0_hi',
] as const;

/**
 * Одна строка runs.csv. Пустая ячейка CSV = null.
 * Числа — в СИ, кроме оговорённых.
 */
export interface RunRecord {
  scenario_id: string;
  /** Имя стратегии с параметрами через «;» (без запятых — это CSV): "cusum:k=0.5;h=6.2". */
  strategy_id: string;
  seed: number;
  /** 1 — в сценарии есть утечка, 0 — нет. */
  leak_present: 0 | 1;
  /** Истинное место первой утечки, м. */
  leak_x: number | null;
  /** Размер утечки, доля расхода (0.02 = 2%). */
  leak_frac: number | null;
  /** Начало утечки, с. */
  t_leak: number | null;
  /** Первая тревога после t_leak, с; null — пропуск (не поймали за отведённое окно). */
  t_alarm: number | null;
  /** t_alarm − t_leak, с. */
  ttd: number | null;
  /** Число тревог на участках без утечки (весь прогон без утечки или до t_leak). */
  false_alarms: number;
  /** Оценка места, м. */
  loc_est: number | null;
  /** |loc_est − leak_x|, м. */
  loc_err: number | null;
  /** Оценка расхода утечки, м³/с. */
  rate_est: number | null;
  /** |rate_est − истинный| / истинный, доля. */
  rate_err: number | null;
  /** Объём, вытекший до тревоги, м³. */
  v_loss: number | null;
  /** Среднее время update детектора + twin на тик, мс. */
  cpu_ms_per_tick: number;
  split?: 'validation' | 'test' | 'demo' | null;
  /** Длительность наблюдения без утечки, с — знаменатель FAR. */
  noleak_s?: number | null;
  /** Физический минимум времени детекции: расстояние до ближайшего датчика давления / a, с. */
  ttd_min_phys?: number | null;
  /** Интервал места к концу прогона [loc_lo, loc_hi], м, и его стадия (LocationStage). */
  loc_lo?: number | null;
  loc_hi?: number | null;
  loc_stage?: LocationStage | null;
  /** Интервал места в момент тревоги, м — первая оценка, которую видит оператор. */
  loc0_lo?: number | null;
  loc0_hi?: number | null;
}

// ============================================================================
// 11. Карточка события и рекомендации (WP-B10, WP-C4)
//     Создаёт: B (explain). Использует: C (интерфейс, экспорт в JSON).
// ============================================================================

export type Severity = 'info' | 'warning' | 'critical';

export interface EventCard {
  id: string;
  /** Время тревоги, с. */
  tAlarm: Seconds;
  eventClass: EventClass;
  /** Уверенность 0..1, откалиброванная по стенду. */
  confidence: number;
  detector: string;
  location?: { x: number; interval?: [lo: number, hi: number]; stage?: LocationStage };
  /** Расход утечки, м³/с. */
  leakRate?: number;
  /** Доля от расхода на входе, 0..1. */
  leakFraction?: number;
  /** Объём потерь к моменту тревоги, м³. */
  vLoss?: number;
  /** Прогноз потерь при бездействии ещё 30 минут, м³. */
  vLossForecast30min?: number;
  /** Вклад датчиков в score: доли, сумма = 1, по убыванию. */
  contributions: Array<{ sensorId: SensorId; share: number }>;
  action: {
    ruleId: string;
    severity: Severity;
    /** Готовый текст с подставленными значениями. */
    text: string;
  };
  /** Отметка оператора «принять». */
  acknowledgedAt?: Seconds;
}

/** Правило из configs/actions.json. Правила проверяются по порядку, срабатывает первое подходящее. */
export interface ActionRule {
  id: string;
  when: {
    eventClass?: EventClass | EventClass[];
    /** Доля расхода, границы включительно снизу и исключительно сверху: [min, max). */
    leakFractionMin?: number;
    leakFractionMax?: number;
    confidenceMin?: number;
    confidenceMax?: number;
  };
  severity: Severity;
  /** Шаблон текста. Подстановки: {place}, {x_km}, {x_err_km}, {rate_m3h}, {frac_pct}, {sensor}, {confidence_pct}. */
  text: string;
}

export interface ActionsFile {
  schemaVersion: typeof CONTRACTS_VERSION;
  rules: ActionRule[];
}

// ============================================================================
// 12. Веса и фильтры выбора стратегии (configs/selection.json, ТЗ, раздел 14)
//     Создаёт: B. Использует: select_strategy.py.
// ============================================================================

export interface SelectionFile {
  schemaVersion: typeof CONTRACTS_VERSION;
  /** Веса нормированных метрик в счёте S (меньше — лучше). Сумма = 1. */
  weights: {
    ttd_med: number;
    ttd_p95: number;
    mdl: number;
    loc_med: number;
    far: number;
  };
  /** Медиана TTD считается по утечкам не меньше этой доли расхода. */
  ttdMinLeakFraction: number;
  /**
   * Медиана ошибки места — только по утечкам не меньше этой доли (по умолчанию 0 — по всем пойманным).
   * Иначе детектор, ловящий больше малых утечек (их место определить труднее), штрафуется за это.
   */
  locMinLeakFraction?: number;
  /** Жёсткие фильтры: не прошёл — выбыл. */
  filters: {
    farPerDayMax: number;
    /** POD не ниже podMin для утечек от podLeakFraction расхода. */
    podMin: number;
    podLeakFraction: number;
    /** Допустимое число ложных тревог на режимных событиях E5 без утечки. */
    regimeFalseAlarmsMax: number;
    cpuMsPerTickMax: number;
  };
  /** Целевая частота ложных тревог при подборе порогов, в сутки. */
  targetFarPerDay: number;
  /** Порог POD для MDL. */
  mdlPod: number;
  seeds: { validation: number[]; test: number[] };
  bootstrap: { samples: number; confidence: number };
  /** Порядок простоты для ничьей: раньше — проще. */
  simplicityOrder: DetectorName[];
}

// ============================================================================
// 13. Калибровка (WP-A8)
//     Создаёт: A. Используют: B (автонастройка), C (панель статусов).
// ============================================================================

export interface CalibrationRequest {
  /** Пути неизвестных параметров: "geometry.roughness", "thermal.heatTransferCoef", "sensors.p_km10.bias". */
  unknowns: string[];
  /** Окно данных без утечки [t0, t1], с. */
  window: [t0: Seconds, t1: Seconds];
  /** Границы параметров в СИ; без них — разумные из библиотеки. */
  bounds?: Record<string, [lo: number, hi: number]>;
}

export interface CalibrationResult {
  /** Оценённые параметры со статусом calibrated (или default, если не определяются). */
  params: ParamMeta[];
  /** Конфиг с подставленными оценками. */
  config: PipelineConfig;
  identifiability: {
    /** Ранг якобиана. */
    rank: number;
    /** Число обусловленности якобиана. */
    condition: number;
    /** Пути параметров, которые не определяются по имеющимся датчикам. */
    unidentifiable: string[];
  };
  /** СКО невязки на датчиках после калибровки, СИ. */
  residualRms: SensorValues;
  converged: boolean;
  iterations: number;
}

// ============================================================================
// 14. Импорт чужих файлов (WP-C1, WP-C2)
//     Создаёт: C (packages/io). Используют: C (мастер), B (стенд, CLI импорта).
// ============================================================================

/** Нормализованная таблица после импорта: время в секундах + колонки с типом и единицей. */
export interface NormalizedTable {
  /** Время, с от первой строки. */
  t: Float64Array;
  /** Абсолютное время первой строки, ISO 8601 UTC, если известно. */
  t0?: string;
  columns: Array<{
    /** Имя колонки в исходном файле. */
    name: string;
    data: Float64Array;
    /** Угаданные или заданные род величины и единица (до перевода в СИ). */
    kind?: SensorKind;
    unit?: string;
  }>;
  warnings: string[];
}

/** Привязка одной колонки исходного файла к датчику. */
export interface ColumnMapping {
  /** Имя колонки в исходном файле: "PT-101", "P_вх, МПа". */
  source: string;
  sensorId: SensorId;
  kind: SensorKind;
  /** Единица значений в файле: "МПа", "bar", "°C", "м3/ч". */
  unit: string;
  /** Для давления: избыточное или абсолютное. По умолчанию 'gauge' (типично для SCADA). */
  pressureReference?: 'gauge' | 'absolute';
  /** Положение датчика, м (если не задано в конфиге трубы). */
  x?: number;
}

/** Время в исходном файле. */
export interface TimeMapping {
  /** Одна колонка или две: [дата, время]. */
  column: string | [date: string, time: string];
  /** 'iso', 'unix-s', 'unix-ms', 'excel' или шаблон "dd.MM.yyyy HH:mm:ss.SSS". */
  format: 'iso' | 'unix-s' | 'unix-ms' | 'excel' | string;
  /** Часовой пояс IANA для времени без пояса: "Europe/Moscow". */
  timezone?: string;
}

/** Профиль маппинга (configs/mappings/<имя>.json). */
export interface MappingProfile {
  schemaVersion: typeof CONTRACTS_VERSION;
  name: string;
  description?: string;
  /** Параметры разбора; отсутствующие определяются автоматически. */
  file?: {
    delimiter?: ',' | ';' | '\t' | ' ';
    decimal?: '.' | ',';
    encoding?: 'utf-8' | 'windows-1251';
    /** Номер строки заголовка, с 0. */
    headerRow?: number;
    /** Номер строки единиц под заголовком, с 0. */
    unitsRow?: number;
    /** Лист Excel по имени или номеру с 0. */
    sheet?: string | number;
  };
  time: TimeMapping;
  columns: ColumnMapping[];
  /** Колонки, которые нужно пропустить. */
  ignore?: string[];
}

/** Разметка утечек в записи (файл labels для replay-сценариев). */
export interface LeakLabelsFile {
  schemaVersion: typeof CONTRACTS_VERSION;
  /** Запись, к которой относится разметка. */
  recording: string;
  leaks: LeakTruth[];
}
