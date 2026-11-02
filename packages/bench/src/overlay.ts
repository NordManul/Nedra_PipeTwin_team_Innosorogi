/**
 * Наложение утечки на запись без утечки (WP-B6, H-B9): к замерам добавляется отклик twin
 * на утечку, приходящий на каждый датчик с задержкой пробега волны |x_датчика − x|/a,
 * с нарастанием rampSec и запаздыванием датчика. Так время детекции оценивается на настоящем шуме,
 * даже если в данных утечек нет.
 */
import { createTwin, PipeModel, type PipelineConfig, type ScenarioEvent, type SensorFrame } from '@pipetwin/core';

type LeakEv = Extract<ScenarioEvent, { type: 'leak' }>;

export function overlayLeaks(frames: SensorFrame[], cfg: PipelineConfig, leaks: LeakEv[]): SensorFrame[] {
  if (!leaks.length || !frames.length) return frames;
  const twin = createTwin(cfg);
  const a = new PipeModel(cfg).waveSpeed();
  const t0 = frames[0]!.t;
  const qIn = cfg.sensors.find((s) => s.kind === 'q' && s.x === 0);
  // отклик считается в рабочей точке перед утечкой
  const responses = leaks.map((e) => {
    let rate = 'area' in e ? NaN : 0;
    for (const f of frames) {
      twin.predict(f);
      if (f.t - t0 >= e.t - 1) {
        if ('sizePct' in e) rate = (e.sizePct / 100) * Math.abs(qIn ? f.values[qIn.id] ?? 0.1 : 0.1);
        break;
      }
    }
    if (!Number.isFinite(rate)) throw new Error('наложение утечки задаётся долей расхода (sizePct)');
    return { e, resp: twin.leakResponse?.(e.x, rate) ?? {} };
  });
  return frames.map((f) => {
    const values = { ...f.values };
    for (const { e, resp } of responses) {
      for (const s of cfg.sensors) {
        const r = resp[s.id];
        if (r === undefined || values[s.id] === undefined) continue;
        const arrive = e.t + Math.abs(s.x - e.x) / a;
        const dt = f.t - t0 - arrive;
        if (dt <= 0) continue;
        const ramp = e.rampSec ? Math.min(1, dt / e.rampSec) : 1;
        const lag = s.lagSec > 0 ? 1 - Math.exp(-dt / s.lagSec) : 1;
        values[s.id]! += r * ramp * lag;
      }
    }
    return { ...f, values };
  });
}
