/**
 * Сценарии: загрузка, разрешение конфигов twin и «настоящей» трубы, создание источника данных.
 * Общий код для стенда (Node) и интерфейса (браузер): файловую систему передают снаружи.
 */
import type { PipelineConfig, PipelineConfigInput, ResolvedConfig, Scenario } from './contracts';
import { mergeConfigInput, resolveConfig } from './config/resolve';
import { assertValid } from './config/validate';

export interface LoadedScenario {
  scenario: Scenario;
  /** Что знает twin (и детектор): конфиг из файла трубы. */
  twin: ResolvedConfig;
  /** «Настоящая» труба: конфиг + truthOverrides. Только для plant. */
  truth: ResolvedConfig;
  warnings: string[];
}

/** Прочитать сценарий. readJson(path) читает JSON по пути от корня репозитория. */
export function loadScenario(raw: unknown, readJson: (path: string) => unknown): LoadedScenario {
  assertValid('scenario', raw, 'сценарий');
  const scenario = raw as Scenario;
  const base = (typeof scenario.pipeline === 'string' ? readJson(scenario.pipeline) : scenario.pipeline) as PipelineConfigInput;
  const source = typeof scenario.pipeline === 'string' ? scenario.pipeline : `scenario:${scenario.id}`;
  const twin = resolveConfig(base, { source });
  const truth = scenario.truthOverrides ? resolveConfig(mergeConfigInput(base, scenario.truthOverrides), { source: `${source}+truth` }) : twin;
  const warnings = [...twin.warnings];
  const warmup = scenario.warmupSec ?? 60;
  for (const e of scenario.events) {
    if (e.t < warmup) warnings.push(`событие ${e.type} в ${e.t} с раньше конца прогрева (${warmup} с)`);
    if (e.type === 'leak' && (e.x < 0 || e.x > twin.config.geometry.length)) warnings.push(`утечка за пределами трубы: x = ${e.x} м`);
  }
  return { scenario, twin, truth, warnings };
}

/**
 * Физический минимум времени детекции (ТЗ, раздел 3.5): волна от утечки должна дойти
 * до ближайшего датчика давления, t = расстояние / a.
 */
export function minDetectionTime(cfg: PipelineConfig, x: number, waveSpeed: number): number {
  const ps = cfg.sensors.filter((s) => s.kind === 'p');
  if (!ps.length) return NaN;
  const d = Math.min(...ps.map((s) => Math.abs(s.x - x)));
  return d / waveSpeed;
}
