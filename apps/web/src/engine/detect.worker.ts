/// <reference lib="webworker" />
/** Воркер детектора: получает только кадры датчиков (граница честности). */
import type { DetectCommand, DetectMessage } from './protocol';
import { DetectEngine } from './detect-engine';

const engine = new DetectEngine();

function post(m: DetectMessage): void {
  self.postMessage(m);
}

self.onmessage = (ev: MessageEvent<DetectCommand>) => {
  const c = ev.data;
  try {
    switch (c.type) {
      case 'init':
        post(engine.init(c.config, c.strategy, c.rules));
        break;
      case 'strategy':
        engine.setStrategy(c.strategy);
        post({ type: 'ready', strategy: engine.currentStrategy, checks: {} });
        break;
      case 'frames':
        post(engine.frames(c.frames));
        break;
      case 'calibrate':
        post(engine.calibrate(c.unknowns, c.windowSec));
        break;
    }
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
