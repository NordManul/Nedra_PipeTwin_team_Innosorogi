/**
 * Движок воркера симуляции (без API воркера — тестируется в Node).
 * Знает правду: plant с утечками и управлением или запись с разметкой.
 */
import type { ControlAction, DataSource, LeakLabelsFile, PipelineConfig, ScenarioEvent, SensorFrame, SensorSpec } from '@pipetwin/core/contracts';
import { Rng } from '@pipetwin/core';
import { SimulatedSource } from '@pipetwin/core/plant';
import { ReplaySource } from '@pipetwin/io';

import type { LeakInfo, SimMessage } from './protocol';

interface PendingBlind {
  at: number;
  x: number;
  sizePct: number;
}

export class SimEngine {
  private source: DataSource | null = null;
  private replaySrc: ReplaySource | null = null;
  private sim: SimulatedSource | null = null;
  private leaks: LeakInfo[] = [];
  private pending: PendingBlind[] = [];
  private rng = new Rng(1);
  private log: string[] = [];
  /** События сессии во времени plant: экспорт даёт сценарий, который стенд проигрывает точно так же. */
  private events: ScenarioEvent[] = [];
  readonly recorded: ScenarioEvent[] = [];
  private profileAt = -Infinity;
  private L = 1;
  speed = 1;
  paused = false;

  init(config: PipelineConfig, seed: number): SimMessage {
    this.sim = new SimulatedSource(config, { seed });
    this.source = this.sim;
    this.replaySrc = null;
    this.rng = new Rng(seed * 7919 + 1);
    this.leaks = [];
    this.pending = [];
    this.events = [];
    this.recorded.length = 0;
    this.L = config.geometry.length;
    this.note(`симуляция: ${config.meta.name}, ${(this.L / 1000).toFixed(1)} км, ${config.sensors.length} датчиков, опрос ${config.sampling.rateHz} Гц`);
    return { type: 'ready', mode: 'sim', waveSpeed: this.sim.waveSpeed, sensors: config.sensors };
  }

  replay(frames: SensorFrame[], sensors: SensorSpec[], labels?: LeakLabelsFile): SimMessage {
    const src = new ReplaySource(frames, sensors, labels ? { labels } : {});
    this.source = src;
    this.replaySrc = src;
    this.sim = null;
    this.leaks = (labels?.leaks ?? []).map((l) => ({ id: l.id, x: l.x, tStart: l.tStart, hidden: false, ...(l.fraction !== undefined ? { sizePct: l.fraction * 100 } : {}) }));
    this.note(`запись: ${frames.length} кадров, ${src.duration.toFixed(0)} с, ${sensors.length} датчиков${labels ? `, размеченных утечек: ${labels.leaks.length}` : ''}`);
    return { type: 'ready', mode: 'replay', waveSpeed: 1000, duration: src.duration, sensors };
  }

  private record(e: ScenarioEvent): void {
    this.events.push(e);
    this.recorded.push(e);
  }

  private note(s: string): void {
    this.log.push(`${(this.source?.t ?? 0).toFixed(1)} с: ${s}`);
  }

  leak(x: number, sizePct: number, rampSec: number): void {
    if (!this.sim) return;
    const e = this.sim.leakEventForFraction(x, sizePct, rampSec);
    this.sim.injectLeak(e);
    this.leaks.push({ id: e.id, x: e.x, tStart: e.tStart, sizePct, hidden: false });
    this.record({ t: e.tStart, type: 'leak', id: e.id, x: e.x, sizePct, rampSec });
    this.note(`утечка ${sizePct}% на ${(x / 1000).toFixed(2)} км${rampSec ? `, нарастание ${rampSec} с` : ''}`);
  }

  blindLeak(sizePct: number, minDelay: number, maxDelay: number): void {
    if (!this.sim) return;
    const at = this.sim.t + this.rng.uniform(minDelay, maxDelay);
    const x = this.rng.uniform(0.05, 0.95) * this.L;
    this.pending.push({ at, x, sizePct });
    this.note(`скрытая утечка ${sizePct}%: место и время не показываются до обнаружения`);
  }

  clearLeaks(): void {
    if (!this.sim) return;
    for (const l of this.leaks) this.sim.removeLeak(l.id);
    this.leaks = [];
    this.pending = [];
    this.note('утечки устранены');
  }

  removeLeak(id: string): void {
    if (!this.sim) return;
    this.sim.removeLeak(id);
    this.leaks = this.leaks.filter((l) => l.id !== id);
    this.note(`утечка ${id} устранена`);
  }

  control(a: ControlAction): void {
    if (!this.sim) return;
    this.record({ t: this.sim.plant.t, ...a } as ScenarioEvent);
    this.sim.applyControl(a);
    const text =
      a.type === 'pump' ? `насос ${a.changePct > 0 ? '+' : ''}${a.changePct}%` : a.type === 'valve' ? `задвижка: открытие ${(a.opening * 100).toFixed(0)}%` : a.type === 'noise' ? `шум ×${a.scale}` : `отказ датчика ${a.sensorId}: ${a.mode}`;
    this.note(text);
  }

  /** Перемотка записи: детектор после неё начинает заново (с прогрева). */
  seek(t: number): void {
    if (!this.replaySrc) return;
    this.replaySrc.seek(Math.max(0, Math.min(t, this.replaySrc.duration)));
    this.note(`перемотка на ${t.toFixed(0)} с`);
  }

  /** Продвинуть модельное время на dtModel; вернуть пакет для основного потока. */
  advance(dtModel: number): SimMessage | null {
    const src = this.source;
    if (!src) return null;
    const frames: SensorFrame[] = [];
    if (!this.paused && !src.done) {
      // скрытые утечки срабатывают точно в своё время
      let left = dtModel;
      while (left > 1e-9) {
        const next = this.pending.reduce((m, p) => Math.min(m, p.at), Infinity);
        const step = Math.min(left, Math.max(next - src.t, 0) || left);
        frames.push(...src.step(step));
        left -= step;
        for (const p of this.pending.filter((q) => q.at <= src.t + 1e-9)) {
          const e = this.sim!.leakEventForFraction(p.x, p.sizePct, 0);
          this.sim!.injectLeak(e);
          this.leaks.push({ id: e.id, x: e.x, tStart: e.tStart, sizePct: p.sizePct, hidden: true });
          this.record({ t: e.tStart, type: 'leak', id: e.id, x: e.x, sizePct: p.sizePct, rampSec: 0 });
        }
        this.pending = this.pending.filter((q) => q.at > src.t + 1e-9);
      }
    }
    const truth = src.truth?.() ?? { leaks: [], regimeEvents: [] };
    for (const l of this.leaks) {
      const tr = truth.leaks.find((x) => x.id === l.id);
      if (tr?.rate !== undefined) l.rate = tr.rate;
    }
    let profile;
    if (src.profile && src.t - this.profileAt >= 0.1) {
      profile = src.profile();
      this.profileAt = src.t;
    }
    const log = this.log;
    const events = this.events;
    this.log = [];
    this.events = [];
    return {
      type: 'batch',
      t: src.t,
      frames,
      leaks: this.leaks.map((l) => ({ ...l })),
      truth,
      log,
      events,
      done: src.done,
      ...(profile ? { profile } : {}),
      ...(this.replaySrc ? { duration: this.replaySrc.duration } : {}),
    };
  }
}
