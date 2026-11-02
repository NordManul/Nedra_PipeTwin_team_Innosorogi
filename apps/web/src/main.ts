/**
 * PipeTwin — демо-интерфейс (WP-C4…C6, C9).
 * Основной поток только рисует и пересылает кадры из воркера симуляции в воркер детектора.
 */
import './style.css';
import type {
  ActionsFile,
  ControlAction,
  DetectorOutput,
  EventCard,
  MappingProfile,
  NormalizedTable,
  PipelineConfigInput,
  ResolvedConfig,
  Scenario,
  ScenarioEvent,
  SelectedStrategyFile,
  SensorFaultMode,
  SensorFrame,
  StrategySpec,
} from '@pipetwin/core/contracts';
import { mergeConfigInput, minDetectionTime, resolveConfig, type PipeProfile } from '@pipetwin/core';
import { defaultStrategy, REGISTRY } from '@pipetwin/detect';
import { applyMapping, parsePassportText } from '@pipetwin/io';
import defaultPipeline from '../../../configs/pipeline.default.json';
import actionsFile from '../../../configs/actions.json';
import selectedStrategy from '../../../configs/strategy.selected.json';
import type { DetectCommand, DetectMessage, LeakInfo, SimCommand, SimMessage } from './engine/protocol';
import { CardPanel } from './ui/card';
import { Charts } from './ui/charts';
import { $, clear, download, h } from './ui/dom';
import { display, fmt, km, UNIT } from './ui/format';
import { Importer } from './ui/importer';
import { ParamsPanel } from './ui/params';
import { Schematic } from './ui/schematic';
import { SeriesStore } from './ui/store';

/** «Настоящая» труба отличается от знаний twin — ошибка модели, как в жизни (ТЗ, раздел 3.2). */
const TRUTH_OVERRIDES = { geometry: { roughness: '0,08 мм' } };

function strategyFromFile(f: SelectedStrategyFile): StrategySpec {
  const { strategy, params, members, fusionRule, localization, signatureFilter, warmupSec } = f;
  return { strategy, params, localization, signatureFilter, warmupSec, ...(members ? { members } : {}), ...(fusionRule ? { fusionRule } : {}) };
}

class App {
  private input = defaultPipeline as unknown as PipelineConfigInput;
  private resolved!: ResolvedConfig;
  private strategy = strategyFromFile(selectedStrategy as unknown as SelectedStrategyFile);
  private rules = (actionsFile as unknown as ActionsFile).rules;
  private modelError = true;
  private seed = 1;
  private speed = 1;
  private paused = false;
  private mode: 'sim' | 'replay' = 'sim';
  private sim!: Worker;
  private det!: Worker;
  private waveSpeed = 1100;
  private pending: SensorFrame[] = [];
  private store = new SeriesStore();
  private leaks: LeakInfo[] = [];
  private outs: DetectorOutput | null = null;
  private alarmTimes: number[] = [];
  private lastAlarm = false;
  private plantProfile?: PipeProfile;
  private twinProfile?: PipeProfile;
  private simT = 0;
  private journal: string[] = [];
  private detectorLog: string[] = [];
  private lastDetLogT = -Infinity;
  private sessionEvents: ScenarioEvent[] = [];
  private dirty = false;
  private inputs: string[] = [];
  private checks: Record<string, { ok: boolean; reasons: string[] }> = {};
  private chartsBuilt = false;
  private replayDuration = 0;
  private lastFrame: SensorFrame | null = null;
  private presenting = false;
  /** Таблицы и журнал перестраиваются реже графиков (4 раза/с) — DOM дороже canvas. */
  private panelsAt = 0;

  private schematic!: Schematic;
  private charts!: Charts;
  private cards!: CardPanel;
  private params!: ParamsPanel;

  start(): void {
    this.layout();
    this.loadConfig(this.input);
    // перерисовка — только когда пришли новые данные, и не чаще 30 раз в секунду
    let last = 0;
    const frame = (now: number) => {
      if (this.dirty && now - last >= 33) {
        this.dirty = false;
        last = now;
        this.render();
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    // редкие обновления панелей (журнал, датчики) и при паузе
    setInterval(() => (this.dirty = true), 500);
  }

  // ------------------------------------------------------------------ конфиг и воркеры

  private loadConfig(input: PipelineConfigInput): void {
    try {
      this.resolved = resolveConfig(input, { source: 'интерфейс' });
    } catch (e) {
      this.toast(e instanceof Error ? e.message : String(e), true);
      return;
    }
    this.input = input;
    this.mode = 'sim';
    this.restart();
  }

  private restart(): void {
    this.sim?.terminate();
    this.det?.terminate();
    this.pending = [];
    this.store.clear();
    this.leaks = [];
    this.alarmTimes = [];
    this.lastAlarm = false;
    this.outs = null;
    this.sessionEvents = [];
    this.detectorLog = [];
    this.cards.reset();
    this.sim = new Worker(new URL('./engine/sim.worker.ts', import.meta.url), { type: 'module' });
    this.sim.onmessage = (e: MessageEvent<SimMessage>) => this.onSim(e.data);
    const cfg = this.resolved.config;
    this.replayDuration = 0;
    this.startDetector();
    if (this.mode === 'sim') {
      const truth = this.modelError ? resolveConfig(mergeConfigInput(this.input, TRUTH_OVERRIDES)).config : cfg;
      this.sendSim({ type: 'init', config: truth, seed: this.seed, speed: this.speed });
    }
    this.schematic.setConfig(cfg);
    this.params.render(this.input, this.resolved.params, this.resolved.warnings, this.resolved.calibrationCandidates);
    this.log(`конфиг «${cfg.meta.name}»: ${(cfg.geometry.length / 1000).toFixed(1)} км, Ø${(cfg.geometry.diameter * 1000).toFixed(0)} мм, ${cfg.sensors.length} датчиков`);
    this.renderControls();
  }

  /** Новый воркер детектора: он начинает с прогрева (оценка шума по первой минуте). */
  private startDetector(): void {
    this.det?.terminate();
    this.det = new Worker(new URL('./engine/detect.worker.ts', import.meta.url), { type: 'module' });
    this.det.onmessage = (e: MessageEvent<DetectMessage>) => this.onDetect(e.data);
    this.pending = [];
    this.alarmTimes = [];
    this.lastAlarm = false;
    this.outs = null;
    this.sendDet({ type: 'init', config: this.resolved.config, strategy: this.strategy, rules: this.rules });
  }

  /** Перемотка записи: модельное время прыгает, поэтому детектор перезапускается с прогрева. */
  private seek(t: number): void {
    this.sendSim({ type: 'seek', t });
    this.store.clear();
    this.cards.reset();
    this.startDetector();
    this.log(`перемотка записи на ${fmt(t, 0)} с — детектор начинает с прогрева`);
  }

  private togglePresentation(): void {
    this.presenting = !this.presenting;
    document.body.classList.toggle('present', this.presenting);
    this.charts.resize();
    this.schematic.draw();
  }

  private sendSim(c: SimCommand): void {
    this.sim.postMessage(c);
  }

  private sendDet(c: DetectCommand): void {
    this.det.postMessage(c);
  }

  private onSim(m: SimMessage): void {
    if (m.type === 'error') return this.toast(`симуляция: ${m.message}`, true);
    if (m.type === 'ready') {
      this.waveSpeed = m.waveSpeed;
      if (this.paused) this.sendSim({ type: 'pause', value: true });
      return;
    }
    this.simT = m.t;
    this.leaks = m.leaks;
    this.dirty = true;
    if (m.duration !== undefined) this.replayDuration = m.duration;
    if (m.profile) this.plantProfile = m.profile;
    for (const l of m.log) this.log(l);
    this.sessionEvents.push(...m.events);
    if (m.frames.length) {
      // единственное, что получает детектор, — кадры датчиков
      this.pending.push(...m.frames);
      this.sendDet({ type: 'frames', frames: m.frames });
      const f = m.frames.at(-1)!;
      this.lastFrame = f;
      if (f.t - this.lastDetLogT >= 1) {
        this.lastDetLogT = f.t;
        const vals = Object.entries(f.values)
          .slice(0, 4)
          .map(([k, v]) => `${k}=${v.toPrecision(5)}`)
          .join(', ');
        this.detectorLog.unshift(`→ детектор: ${m.frames.length} кадр(а) до t=${f.t.toFixed(1)} с · ${Object.keys(f.values).length} значений · ${vals}…`);
        this.detectorLog.length = Math.min(this.detectorLog.length, 40);
      }
    }
    if (m.done && this.mode === 'replay') this.log('запись закончилась');
  }

  private onDetect(m: DetectMessage): void {
    if (m.type === 'error') return this.toast(`детектор: ${m.message}`, true);
    if (m.type === 'ready') {
      this.strategy = m.strategy;
      if (Object.keys(m.checks).length) this.checks = m.checks;
      this.renderControls();
      return;
    }
    if (m.type === 'calibrated') {
      const r = m.result;
      this.toast(`калибровка: ${r.params.map((p) => `${p.path} = ${p.value.toPrecision(3)} (${p.status})`).join('; ')}; ранг ${r.identifiability.rank}`);
      for (const p of r.params) {
        const i = this.resolved.params.findIndex((x) => x.path === p.path);
        if (i >= 0) this.resolved.params[i] = p;
        else this.resolved.params.push(p);
      }
      this.resolved = { ...this.resolved, config: r.config };
      this.params.render(this.input, this.resolved.params, this.resolved.warnings, []);
      return;
    }
    if (m.twinProfile) this.twinProfile = m.twinProfile;
    this.dirty = true;
    m.outs.forEach((out, i) => {
      const frame = this.pending.shift();
      const pred = m.preds[i];
      if (!frame) return;
      if (pred?.inputs) this.inputs = pred.inputs;
      this.record(frame, pred?.ok ? pred.values : {}, out);
    });
    for (const c of m.cards) this.cards.upsert(c);
    if (this.charts && this.store.t.length && this.inputs.length && !this.chartsBuilt) {
      this.charts.build(this.resolved.config, this.inputs);
      this.chartsBuilt = true;
    }
  }

  private record(f: SensorFrame, pred: Record<string, number>, out: DetectorOutput): void {
    const cfg = this.resolved.config;
    const v: Record<string, number | null> = {};
    for (const s of cfg.sensors) {
      const m = f.values[s.id];
      v[`m:${s.id}`] = m !== undefined && f.valid?.[s.id] !== false ? display(s.kind, m, cfg.ambientPressure) : null;
      v[`p:${s.id}`] = pred[s.id] !== undefined ? display(s.kind, pred[s.id]!, cfg.ambientPressure) : null;
      v[`z:${s.id}`] = out.z?.[s.id] ?? null;
    }
    const warm = out.phase !== 'warmup';
    v.score = warm ? out.score : null;
    v.thr = warm ? out.threshold ?? null : null;
    v.alarmBand = out.alarm ? (out.threshold ?? 1) * 1.5 : null;
    this.store.push(f.t, v);
    if (out.alarm && !this.lastAlarm) {
      this.alarmTimes.push(out.t);
      this.log(`ТРЕВОГА: ${out.eventClass === 'leak' ? 'утечка' : out.eventClass ?? ''}${out.location !== undefined ? ` у км ${fmt(km(out.location), 1)}` : ''}`);
    }
    if (out.eventClass && out.eventClass !== this.outs?.eventClass && !out.alarm) this.log(`событие: ${out.eventClass}`);
    this.lastAlarm = out.alarm;
    this.outs = out;
    if (!this.chartsBuilt && this.store.t.length > 2) {
      this.charts.build(cfg, this.inputs);
      this.chartsBuilt = true;
    }
  }

  // ------------------------------------------------------------------ действия

  private leakAt(x: number): void {
    if (this.mode !== 'sim') return this.toast('утечку можно поставить только в режиме симуляции');
    const size = Number(($('#leak-size') as HTMLInputElement).value);
    const ramp = Number(($('#leak-ramp') as HTMLSelectElement).value);
    this.sendSim({ type: 'leak', x, sizePct: size, rampSec: ramp });
  }

  private control(action: ControlAction): void {
    if (this.mode !== 'sim') return this.toast('режимом можно управлять только в симуляции');
    this.sendSim({ type: 'control', action });
  }

  private setSpeed(v: number): void {
    this.speed = v;
    this.sendSim({ type: 'speed', value: v });
    this.renderControls();
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.sendSim({ type: 'pause', value: this.paused });
    this.renderControls();
  }

  private replay(table: NormalizedTable, profile: MappingProfile): void {
    const cfg0 = this.resolved.config;
    const sensors = profile.columns.map((c) => {
      const known = cfg0.sensors.find((s) => s.id === c.sensorId);
      return { id: c.sensorId, kind: c.kind, x: c.x ?? known?.x ?? 0, ...(known?.label ? { label: known.label } : {}) };
    });
    const dts = Array.from(table.t.slice(1, 200), (t, i) => t - table.t[i]!).sort((a, b) => a - b);
    const rate = dts.length ? 1 / Math.max(dts[Math.floor(dts.length / 2)]!, 1e-3) : 10;
    const input = { ...this.input, sensors, sampling: { rateHz: Number(rate.toFixed(3)) } } as PipelineConfigInput;
    try {
      this.resolved = resolveConfig(input, { source: 'запись' });
    } catch (e) {
      return this.toast(e instanceof Error ? e.message : String(e), true);
    }
    this.input = input;
    this.mode = 'replay';
    const frames = applyMapping(table, profile, { ambientPressure: this.resolved.config.ambientPressure });
    this.chartsBuilt = false;
    this.restart();
    this.sendSim({ type: 'replay', frames, sensors: this.resolved.config.sensors, speed: this.speed });
    this.toast(`запись: ${frames.length} кадров, ${profile.columns.length} датчиков`);
  }

  private exportScenario(): void {
    const sc: Scenario = {
      schemaVersion: 1,
      id: `demo-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`,
      description: 'Сессия демо, экспортированная из интерфейса (WP-C6): те же события в то же модельное время.',
      pipeline: this.input,
      ...(this.modelError ? { truthOverrides: TRUTH_OVERRIDES } : {}),
      source: { type: 'simulated' },
      durationSec: Math.max(60, Math.ceil(this.simT)),
      seed: this.seed,
      warmupSec: this.strategy.warmupSec,
      split: 'demo',
      events: this.sessionEvents,
      tags: ['demo-export'],
    };
    download(`${sc.id}.json`, JSON.stringify({ $schema: '../../schemas/scenario.schema.json', ...sc }, null, 2));
  }

  private log(s: string): void {
    this.journal.unshift(`${new Date().toLocaleTimeString('ru-RU')} · ${s}`);
    this.journal.length = Math.min(this.journal.length, 300);
  }

  private toast(msg: string, error = false): void {
    const el = h('div', { class: `toast${error ? ' error' : ''}` }, msg);
    $('#toasts').append(el);
    setTimeout(() => el.remove(), error ? 9000 : 5000);
    this.log(msg);
  }

  // ------------------------------------------------------------------ разметка

  private layout(): void {
    const root = $('#app');
    root.append(
      h(
        'header',
        {},
        h('div', { class: 'brand' }, h('strong', {}, 'PipeTwin'), h('span', { class: 'muted' }, ' · цифровой двойник участка трубопровода')),
        h(
          'div',
          { class: 'row' },
          h('div', { id: 'status', class: 'status' }),
          h('button', { class: 'small', title: 'Крупный экран для проектора (клавиша P)', onclick: () => this.togglePresentation() }, 'Презентация'),
        ),
      ),
      h(
        'main',
        {},
        h('aside', { id: 'controls', class: 'col-left' }),
        h(
          'section',
          { class: 'col-center' },
          h('div', { id: 'stopwatch', class: 'stopwatch' }),
          h('div', { id: 'timeline', class: 'panel timeline', hidden: true }),
          h('div', { id: 'schematic', class: 'panel' }),
          h('div', { id: 'charts', class: 'charts' }),
        ),
        h(
          'aside',
          { class: 'col-right' },
          h('div', { id: 'card', class: 'panel' }),
          h('div', { id: 'sensors', class: 'panel' }),
          h('div', { id: 'journal', class: 'panel' }),
          h('div', { id: 'params', class: 'panel' }),
        ),
      ),
      h('div', { id: 'toasts' }),
    );
    this.schematic = new Schematic($('#schematic'), (x) => this.leakAt(x));
    document.addEventListener('keydown', (e) => {
      if ((e.key === 'p' || e.key === 'з') && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) this.togglePresentation();
    });
    this.charts = new Charts($('#charts'));
    this.cards = new CardPanel($('#card'), (c: EventCard) => this.log(`оператор принял карточку ${c.id}: ${c.action.text}`));
    this.params = new ParamsPanel($('#params'), {
      apply: (input) => {
        this.chartsBuilt = false;
        this.loadConfig(input);
      },
      parsePassport: (text) => {
        const r = parsePassportText(text);
        if (r.unknown.length) this.toast(`не понято: ${r.unknown.join('; ')}`);
        return mergeConfigInput(this.input, r.input as object);
      },
      calibrate: () => {
        this.sendDet({ type: 'calibrate', unknowns: ['geometry.roughness', 'thermal.heatTransferCoef'], windowSec: 60 });
        this.toast('калибровка по последним 60 с (должны быть без утечки)…');
      },
    });
  }

  private renderControls(): void {
    const host = $('#controls');
    clear(host);
    const cfg = this.resolved.config;
    const btn = (label: string, on: () => void, cls = '') => h('button', { class: cls, onclick: on }, label);

    // источник и время
    host.append(
      h(
        'div',
        { class: 'panel' },
        h('h3', {}, 'Время и источник'),
        h('div', { class: 'row' }, ...[1, 5, 20].map((v) => btn(`×${v}`, () => this.setSpeed(v), this.speed === v ? 'primary' : '')), btn(this.paused ? 'Продолжить' : 'Пауза', () => this.togglePause())),
        h('div', { class: 'row' }, btn('Перезапуск', () => { this.chartsBuilt = false; if (this.mode === 'replay') this.mode = 'sim'; this.loadConfig(this.input); }), btn('Новый seed', () => { this.seed++; this.chartsBuilt = false; this.loadConfig(this.input); })),
        h(
          'label',
          { class: 'check small' },
          h('input', {
            type: 'checkbox',
            checked: this.modelError,
            onchange: (e: Event) => {
              this.modelError = (e.target as HTMLInputElement).checked;
              this.chartsBuilt = false;
              this.loadConfig(this.input);
            },
          }),
          ' ошибка модели: в «настоящей» трубе шероховатость 0,08 мм, twin считает по конфигу',
        ),
        h('label', { class: 'small' }, 'Окно графиков ', h('select', { onchange: (e: Event) => (this.charts.windowSec = Number((e.target as HTMLSelectElement).value)) }, ...[30, 60, 120, 300].map((v) => h('option', { value: v, selected: v === this.charts.windowSec }, `${v} с`)))),
        h('p', { class: 'small muted' }, this.mode === 'sim' ? 'Режим: симуляция' : 'Режим: проигрывание записи'),
      ),
    );

    // утечка
    let kmInput!: HTMLInputElement;
    const size = h('input', { id: 'leak-size', type: 'range', min: 0.2, max: 20, step: 0.1, value: 2 });
    const sizeLbl = h('span', { class: 'mono' }, '2,0 %');
    size.addEventListener('input', () => (sizeLbl.textContent = `${fmt(Number(size.value), 1)} %`));
    host.append(
      h(
        'div',
        { class: 'panel' },
        h('h3', {}, 'Утечка'),
        h('p', { class: 'small' }, 'Клик по трубе на схеме ставит утечку в эту точку.'),
        h('label', { class: 'field' }, h('span', { class: 'small' }, 'Размер, % расхода'), size, sizeLbl),
        h('label', { class: 'field' }, h('span', { class: 'small' }, 'Нарастание'), h('select', { id: 'leak-ramp' }, ...[0, 5, 30].map((v) => h('option', { value: v }, v ? `${v} с` : 'мгновенно')))),
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'small' }, 'Место, км'),
          (kmInput = h('input', { type: 'number', min: 0, max: cfg.geometry.length / 1000, step: 0.1, value: (cfg.geometry.length / 2000).toFixed(1), style: 'width:80px' })),
          btn('Поставить', () => this.leakAt(Math.min(cfg.geometry.length, Math.max(0, Number(kmInput.value) * 1000))), 'small'),
        ),
        h(
          'div',
          { class: 'row' },
          btn('В середину', () => this.leakAt(cfg.geometry.length / 2)),
          btn('Скрытая', () => {
            this.sendSim({ type: 'blindLeak', sizePct: Number(size.value), minDelaySec: 5, maxDelaySec: 30 });
          }),
          btn('Устранить', () => this.sendSim({ type: 'clearLeaks' })),
        ),
        h('div', { id: 'leak-list' }),
        h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Пресеты:'), btn('1%', () => { size.value = '1'; this.leakAt(cfg.geometry.length * 0.37); }, 'small'), btn('5%', () => { size.value = '5'; this.leakAt(cfg.geometry.length * 0.62); }, 'small'), btn('10%', () => { size.value = '10'; this.leakAt(cfg.geometry.length * 0.8); }, 'small')),
      ),
    );

    // режим перекачки и отказы
    const valve = h('input', { type: 'range', min: 0, max: 100, step: 5, value: 80 });
    valve.addEventListener('change', () => this.control({ type: 'valve', opening: Number(valve.value) / 100, rampSec: 5 }));
    const noise = h('input', { type: 'range', min: 0.5, max: 5, step: 0.5, value: 1 });
    noise.addEventListener('change', () => this.control({ type: 'noise', scale: Number(noise.value) }));
    const sensorSel = h('select', {}, ...cfg.sensors.map((s) => h('option', { value: s.id }, s.id)));
    const modeSel = h('select', {}, ...[['step', 'скачок'], ['drift', 'дрейф'], ['stuck', 'залипание'], ['dropout', 'нет данных'], ['spike', 'выброс']].map(([v, t]) => h('option', { value: v }, t)));
    host.append(
      h(
        'div',
        { class: 'panel' },
        h('h3', {}, 'Режим перекачки (без утечки)'),
        h('div', { class: 'row' }, ...[-10, -5, 5, 10].map((p) => btn(`Насос ${p > 0 ? '+' : ''}${p}%`, () => this.control({ type: 'pump', changePct: p, rampSec: 3 }), 'small'))),
        h('label', { class: 'field' }, h('span', { class: 'small' }, 'Задвижка на выходе, % открытия'), valve),
        h('label', { class: 'field' }, h('span', { class: 'small' }, 'Шум датчиков, ×'), noise),
        h('div', { class: 'row' }, h('span', { class: 'small' }, 'Отказ'), sensorSel, modeSel, btn('Применить', () => this.control({ type: 'sensor-fault', sensorId: sensorSel.value, mode: modeSel.value as SensorFaultMode, magnitude: 8, durationSec: 120 }), 'small')),
      ),
    );

    // стратегия
    const names = Object.keys(REGISTRY).filter((n) => n !== 'fusion');
    const sel = h('select', {}, h('option', { value: '' }, `выбранная стендом: ${this.strategy.strategy}`), ...names.map((n) => h('option', { value: n, disabled: this.checks[n] ? !this.checks[n]!.ok : false, title: this.checks[n]?.reasons.join('; ') ?? '' }, `${REGISTRY[n]!.code} ${n} — ${REGISTRY[n]!.title}`)));
    sel.addEventListener('change', () => {
      const spec = sel.value ? defaultStrategy(sel.value) : strategyFromFile(selectedStrategy as unknown as SelectedStrategyFile);
      this.sendDet({ type: 'strategy', strategy: spec });
      this.log(`стратегия: ${spec.strategy}`);
    });
    const ev = (selectedStrategy as unknown as SelectedStrategyFile).evidence;
    host.append(
      h(
        'div',
        { class: 'panel' },
        h('h3', {}, 'Стратегия детекции'),
        sel,
        h('p', { class: 'small muted' }, `Сейчас: ${this.strategy.strategy} (${Object.entries(this.strategy.params).map(([k, v]) => `${k}=${v}`).join(', ')}), место: ${this.strategy.localization}`),
        ev ? h('p', { class: 'small' }, `Стенд: TTD мед. ${fmt(ev.ttd_med_s, 1)} с, MDL ${fmt(ev.mdl_pct, 1)}%, ложных ${fmt(ev.far_per_day, 2)}/сут`) : h('p', { class: 'small muted' }, 'Стратегия по умолчанию (стенд ещё не запускался).'),
      ),
    );

    // импорт и экспорт
    const imp = h('div');
    host.append(
      h('div', { class: 'panel' }, h('h3', {}, 'Запись с датчиков (replay)'), imp),
      h(
        'div',
        { class: 'panel' },
        h('h3', {}, 'Экспорт'),
        h(
          'div',
          { class: 'row' },
          btn('Сценарий для стенда', () => this.exportScenario(), 'small'),
          btn('Журнал CSV', () => download('pipetwin-journal.csv', 'время;событие\n' + [...this.journal].reverse().map((l) => l.replace(' · ', ';')).join('\n'), 'text/csv'), 'small'),
          btn('Графики PNG', () => download('pipetwin-charts.png', this.charts.snapshot()), 'small'),
        ),
      ),
    );
    new Importer(imp, (table, profile) => this.replay(table, profile));
  }

  // ------------------------------------------------------------------ отрисовка

  private render(): void {
    const cfg = this.resolved?.config;
    if (!cfg) return;
    const out = this.outs;
    const markers = [
      ...this.leaks.filter((l) => !l.hidden || this.detectedAfter(l.tStart) !== null).map((l) => ({ t: l.tStart, color: '#dc2626', label: 'утечка' })),
      ...this.alarmTimes.map((t) => ({ t, color: '#f59e0b', label: 'тревога' })),
    ];
    this.charts.setMarkers(markers);
    this.charts.update(this.store);
    const now = performance.now();
    const panels = now - this.panelsAt > 250;
    if (panels) {
      this.panelsAt = now;
      this.renderTimeline();
      this.renderSensors();
      this.renderLeakList();
    }
    const visibleLeaks = this.leaks.map((l) => ({ ...l, hidden: l.hidden && !this.detectedAfter(l.tStart) }));
    this.schematic.update({
      profile: this.mode === 'sim' ? this.plantProfile : this.twinProfile,
      leaks: visibleLeaks,
      estimate: out?.alarm && out.location !== undefined ? { x: out.location, ...(out.locationInterval ? { interval: out.locationInterval } : {}) } : undefined,
      unhealthy: out?.unhealthySensors ?? [],
      alarm: !!out?.alarm,
    });
    this.renderStopwatch(visibleLeaks);
    $('#status').textContent = `${this.mode === 'sim' ? 'симуляция' : 'запись'} · t = ${fmt(this.simT, 1)} с · ×${this.speed}${this.paused ? ' · пауза' : ''} · ${out?.phase === 'warmup' ? 'прогрев (оценка шума)' : out?.alarm ? 'ТРЕВОГА' : 'норма'}`;
    if (!panels) return;
    const j = $('#journal');
    clear(j);
    j.append(
      h('h3', {}, 'Журнал'),
      h('p', { class: 'small muted' }, 'Детектор работает в отдельном воркере и получает только кадры датчиков. Последние сообщения к нему:'),
      h('pre', { class: 'log' }, this.detectorLog.slice(0, 5).join('\n')),
      h('pre', { class: 'log' }, this.journal.slice(0, 30).join('\n')),
    );
  }

  /** Активные утечки (видимые) с кнопкой «убрать» у каждой. */
  private renderLeakList(): void {
    const el = document.getElementById('leak-list');
    if (!el) return;
    const visible = this.leaks.filter((l) => !l.hidden || this.detectedAfter(l.tStart) !== null);
    const key = visible.map((l) => `${l.id}:${l.rate?.toFixed(5)}`).join('|');
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    clear(el);
    for (const l of visible) {
      el.append(
        h(
          'div',
          { class: 'row small' },
          h('span', { class: 'mono' }, `км ${fmt(km(l.x), 1)} · ${fmt(l.sizePct, 1)}%${l.rate !== undefined ? ` · ${fmt(l.rate * 3600, 1)} м³/ч` : ''}`),
          h('button', { class: 'small', onclick: () => this.sendSim({ type: 'removeLeak', id: l.id }) }, 'убрать'),
        ),
      );
    }
  }

  /** Шкала записи с перемоткой (только replay). */
  private renderTimeline(): void {
    const el = $('#timeline');
    el.hidden = this.mode !== 'replay' || !this.replayDuration;
    if (el.hidden) return;
    const range = el.querySelector('input');
    if (range && document.activeElement === range) return;
    clear(el);
    const r = h('input', { type: 'range', min: 0, max: this.replayDuration, step: 1, value: this.simT });
    r.addEventListener('change', () => this.seek(Number(r.value)));
    el.append(h('div', { class: 'row' }, h('span', { class: 'small mono' }, `${fmt(this.simT, 0)} / ${fmt(this.replayDuration, 0)} с`), r));
  }

  /** Датчики: последнее значение, нормированная невязка, состояние. */
  private renderSensors(): void {
    const el = $('#sensors');
    clear(el);
    const cfg = this.resolved.config;
    const f = this.lastFrame;
    const z = this.outs?.z ?? {};
    const bad = new Set(this.outs?.unhealthySensors ?? []);
    const rows = cfg.sensors.map((s) => {
      const v = f?.values[s.id];
      const role = this.inputs.includes(s.id) ? 'граница twin' : z[s.id] !== undefined ? `z = ${fmt(z[s.id], 1)}` : '';
      return h(
        'tr',
        { class: bad.has(s.id) ? 'bad' : '' },
        h('td', {}, s.id),
        h('td', { class: 'mono' }, fmt(km(s.x), 1)),
        h('td', { class: 'mono' }, v !== undefined ? `${fmt(display(s.kind, v, cfg.ambientPressure), s.kind === 'p' ? 3 : 1)} ${UNIT[s.kind]}` : '—'),
        h('td', { class: 'small' }, bad.has(s.id) ? 'неисправен' : role),
      );
    });
    el.append(
      h('h3', {}, 'Датчики'),
      h('table', { class: 'params' }, h('tr', {}, h('th', {}, 'id'), h('th', {}, 'км'), h('th', {}, 'значение'), h('th', {}, 'состояние')), ...rows),
    );
  }

  private detectedAfter(t0: number): number | null {
    return this.alarmTimes.find((t) => t >= t0) ?? null;
  }

  private renderStopwatch(leaks: LeakInfo[]): void {
    const el = $('#stopwatch');
    clear(el);
    const leak = leaks.at(-1);
    const raw = this.leaks.at(-1);
    if (!leak || !raw) {
      el.className = 'stopwatch idle';
      const warm = !this.outs || this.outs.phase === 'warmup';
      const done = Math.min(this.strategy.warmupSec, this.outs?.t ?? 0);
      el.append(
        h('div', { class: 'big' }, warm ? `Прогрев: ${fmt(done, 0)} из ${this.strategy.warmupSec} с` : this.outs?.alarm ? (this.mode === 'replay' ? 'Тревога по записи' : 'Тревога без поставленной утечки') : this.mode === 'replay' ? 'Норма' : 'Утечки нет'),
        warm
          ? h('div', { class: 'progress' }, h('div', { style: `width:${((done / this.strategy.warmupSec) * 100).toFixed(0)}%` }))
          : '',
        h(
          'div',
          { class: 'small' },
          warm
            ? 'Детектор оценивает шум датчиков по первой минуте; ускорьте время кнопкой ×20'
            : this.mode === 'replay'
              ? `Запись без разметки утечек${this.alarmTimes.length ? ` · тревоги: ${this.alarmTimes.map((t) => `${fmt(t, 1)} с`).join(', ')}` : ''}`
              : 'Кликните по трубе, чтобы поставить утечку',
        ),
      );
      return;
    }
    const tA = this.detectedAfter(raw.tStart);
    const phys = minDetectionTime(this.resolved.config, raw.x, this.waveSpeed);
    if (tA !== null) {
      const err = this.outs?.location !== undefined ? Math.abs(this.outs.location - raw.x) : null;
      el.className = 'stopwatch ok';
      el.append(
        h('div', { class: 'big' }, `Обнаружено за ${fmt(tA - raw.tStart, 1)} с`),
        h('div', {}, `физический минимум для этого места: ${fmt(phys, 1)} с (волна до ближайшего датчика)`),
        h('div', { class: 'small' }, `место: истинное км ${fmt(km(raw.x), 2)}${err !== null ? ` · ошибка оценки ${fmt(err, 0)} м` : ' · оценка уточняется'}`),
      );
    } else if (leak.hidden) {
      el.className = 'stopwatch wait';
      el.append(h('div', { class: 'big' }, 'Скрытая утечка: ждём обнаружения'), h('div', { class: 'small' }, 'место и время не показываются до тревоги'));
    } else {
      el.className = 'stopwatch wait';
      el.append(h('div', { class: 'big' }, `Идёт поиск: ${fmt(this.simT - raw.tStart, 1)} с`), h('div', {}, `физический минимум: ${fmt(phys, 1)} с`));
    }
  }
}

new App().start();
