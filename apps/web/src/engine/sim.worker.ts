/// <reference lib="webworker" />
/** Воркер симуляции: свой таймер модельного времени, независимый от отрисовки. */
import type { SimCommand, SimMessage } from './protocol';
import { SimEngine } from './sim-engine';

const engine = new SimEngine();
const TICK_MS = 50;
let timer: ReturnType<typeof setInterval> | null = null;
let last = performance.now();

function post(m: SimMessage | null): void {
  if (m) self.postMessage(m);
}

function start(): void {
  if (timer) clearInterval(timer);
  last = performance.now();
  timer = setInterval(() => {
    const now = performance.now();
    // не больше 0,25 с реального времени за тик: после сна вкладки не «прыгаем» на минуты
    const wall = Math.min(0.25, (now - last) / 1000);
    last = now;
    try {
      post(engine.advance(wall * engine.speed));
    } catch (e) {
      post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, TICK_MS);
}

self.onmessage = (ev: MessageEvent<SimCommand>) => {
  const c = ev.data;
  try {
    switch (c.type) {
      case 'init':
        engine.speed = c.speed;
        post(engine.init(c.config, c.seed));
        start();
        break;
      case 'replay':
        engine.speed = c.speed;
        post(engine.replay(c.frames, c.sensors, c.labels));
        start();
        break;
      case 'leak':
        engine.leak(c.x, c.sizePct, c.rampSec);
        break;
      case 'blindLeak':
        engine.blindLeak(c.sizePct, c.minDelaySec, c.maxDelaySec);
        break;
      case 'clearLeaks':
        engine.clearLeaks();
        break;
      case 'control':
        engine.control(c.action);
        break;
      case 'speed':
        engine.speed = c.value;
        break;
      case 'pause':
        engine.paused = c.value;
        break;
    }
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
