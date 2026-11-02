/**
 * Раннер (WP-B7): один сценарий × все стратегии. Источник и twin считаются один раз,
 * кадры подаются всем детекторам. Результат — строки runs.csv (контракт RunRecord).
 * Правда (утечки) берётся из источника и в детектор не попадает.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createTwin,
  loadScenario,
  minDetectionTime,
  PipeModel,
  type DataSource,
  type DetectorOutput,
  type LeakLabelsFile,
  type MappingProfile,
  type RunRecord,
  type Scenario,
  type StrategySpec,
} from '@pipetwin/core';
import { createScenarioSource } from '@pipetwin/core/plant';
import { createDetector } from '@pipetwin/detect';
import { framesFromFile, ReplaySource } from '@pipetwin/io';
import { overlayLeaks } from './overlay';
import { strategyId } from './candidates';

export const ROOT = resolve(import.meta.dirname, '../../..');

export function readJsonFromRoot(path: string): unknown {
  return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
}

export interface RunOptions {
  /** Не поймал за это время после начала утечки — пропуск (ТЗ, раздел 13). */
  maxTtdSec?: number;
  readJson?: (path: string) => unknown;
}

export interface ScenarioResult {
  rows: RunRecord[];
  excluded: Array<{ scenario_id: string; strategy_id: string; reasons: string[] }>;
}

async function sourceFor(sc: Scenario, readJson: (p: string) => unknown, loaded: ReturnType<typeof loadScenario>): Promise<DataSource> {
  if (sc.source.type === 'simulated') return createScenarioSource(loaded);
  const cfg = loaded.twin.config;
  const profile = sc.source.mapping ? (readJson(`configs/mappings/${sc.source.mapping}.json`) as MappingProfile) : undefined;
  const bytes = new Uint8Array(readFileSync(resolve(ROOT, sc.source.file)));
  let { frames } = await framesFromFile(bytes, sc.source.file, { profile, config: cfg });
  const labels = sc.source.labels ? (readJson(sc.source.labels) as LeakLabelsFile) : undefined;
  if (sc.overlayLeaks?.length) frames = overlayLeaks(frames, cfg, sc.overlayLeaks);
  const lab: LeakLabelsFile | undefined = sc.overlayLeaks?.length
    ? { schemaVersion: 1, recording: sc.source.file, leaks: sc.overlayLeaks.map((e, i) => ({ id: e.id ?? `ov${i}`, x: e.x, tStart: e.t, ...('sizePct' in e ? { fraction: e.sizePct / 100 } : {}) })) }
    : labels;
  return new ReplaySource(frames, cfg.sensors, lab ? { labels: lab } : {});
}

interface DetState {
  id: string;
  det: ReturnType<typeof createDetector>;
  ms: number;
  was: boolean;
  falseAlarms: number;
  tAlarm: number | null;
  atWindowEnd: DetectorOutput | null;
}

export async function runScenario(sc: Scenario, strategies: StrategySpec[], opts: RunOptions = {}): Promise<ScenarioResult> {
  const readJson = opts.readJson ?? readJsonFromRoot;
  const maxTtd = opts.maxTtdSec ?? 60;
  const loaded = loadScenario(sc, readJson);
  const cfg = loaded.twin.config;
  const source = await sourceFor(sc, readJson, loaded);
  const twin = createTwin(cfg);
  const ctx = { config: cfg, sensors: cfg.sensors, sampleRateHz: source.sampleRateHz, twin };
  const warmup = sc.warmupSec ?? 60;
  const leakEvent = sc.events.find((e) => e.type === 'leak') ?? sc.overlayLeaks?.[0];
  const tLeak = leakEvent?.t ?? null;
  const excluded: ScenarioResult['excluded'] = [];
  const dets: DetState[] = [];
  for (const spec of strategies) {
    const det = createDetector({ ...spec, warmupSec: warmup });
    const check = det.check(ctx);
    if (!check.ok) {
      excluded.push({ scenario_id: sc.id, strategy_id: strategyId(spec), reasons: check.reasons });
      continue;
    }
    det.reset(ctx);
    dets.push({ id: strategyId(spec), det, ms: 0, was: false, falseAlarms: 0, tAlarm: null, atWindowEnd: null });
  }

  let twinMs = 0;
  let ticks = 0;
  let vLossAcc = 0;
  let lastTruthT = 0;
  let leakRate = 0;
  const vLossAt = new Map<DetState, number>();
  const end = sc.durationSec;
  const step = 1 / source.sampleRateHz;
  while (!source.done && source.t < end - 1e-9) {
    const frames = source.step(step);
    for (const f of frames) {
      const t0 = performance.now();
      const pred = twin.predict(f);
      twinMs += performance.now() - t0;
      ticks++;
      // объём утечки — интеграл истинного расхода (правда, только для метрики)
      if (tLeak !== null && f.t >= tLeak && f.t - lastTruthT >= 0.5) {
        const tr = source.truth?.().leaks[0];
        if (tr?.rate !== undefined) leakRate = tr.rate;
        else if (tr?.fraction !== undefined) leakRate = tr.fraction * Math.abs(f.values[cfg.sensors.find((s) => s.kind === 'q')?.id ?? ''] ?? 0);
        vLossAcc += leakRate * (f.t - Math.max(lastTruthT, tLeak));
        lastTruthT = f.t;
      }
      for (const d of dets) {
        const a = performance.now();
        const out = d.det.update(f, pred);
        d.ms += performance.now() - a;
        const rising = out.alarm && !d.was;
        d.was = out.alarm;
        if (out.phase === 'warmup') continue;
        if (rising) {
          if (tLeak === null || f.t < tLeak) d.falseAlarms++;
          else if (d.tAlarm === null && f.t - tLeak <= maxTtd) {
            d.tAlarm = out.t;
            vLossAt.set(d, vLossAcc);
          }
        }
        if (tLeak !== null && f.t <= tLeak + maxTtd && out.alarm && d.tAlarm !== null) d.atWindowEnd = out;
      }
    }
  }

  const truth = source.truth?.();
  const tl = truth?.leaks[0];
  const a = new PipeModel(cfg).waveSpeed();
  const x = tl?.x ?? leakEvent?.x;
  const frac = leakEvent && 'sizePct' in leakEvent ? leakEvent.sizePct / 100 : tl?.fraction ?? null;
  const rows: RunRecord[] = dets.map((d) => {
    const loc = d.atWindowEnd?.location ?? null;
    const rate = d.atWindowEnd?.leakRate ?? null;
    const trueRate = tl?.rate ?? null;
    return {
      scenario_id: sc.id,
      strategy_id: d.id,
      seed: sc.seed,
      leak_present: tLeak !== null ? 1 : 0,
      leak_x: x ?? null,
      leak_frac: frac,
      t_leak: tLeak,
      t_alarm: d.tAlarm,
      ttd: d.tAlarm !== null && tLeak !== null ? d.tAlarm - tLeak : null,
      false_alarms: d.falseAlarms,
      loc_est: loc,
      loc_err: loc !== null && x !== undefined ? Math.abs(loc - x) : null,
      rate_est: rate,
      rate_err: rate !== null && trueRate ? Math.abs(rate - trueRate) / trueRate : null,
      v_loss: tLeak !== null ? (d.tAlarm !== null ? vLossAt.get(d) ?? 0 : vLossAcc) : null,
      cpu_ms_per_tick: ticks ? (twinMs + d.ms) / ticks : 0,
      split: sc.split === 'demo' ? 'demo' : sc.split ?? null,
      noleak_s: Math.max(0, (tLeak ?? Math.min(end, source.t)) - warmup),
      ttd_min_phys: x !== undefined ? minDetectionTime(cfg, x, a) : null,
    };
  });
  return { rows, excluded };
}
