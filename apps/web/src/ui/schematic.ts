/**
 * Схема трубы (WP-C4): профиль высот, труба с цветом по давлению, датчики из конфига,
 * истинная утечка и оценка места с интервалом. Клик по трубе ставит утечку.
 * Масштабируется на любую длину и число датчиков (подписи не наезжают — T-C10).
 */
import type { PipeProfile, PipelineConfig } from '@pipetwin/core/contracts';
import { interp } from '@pipetwin/core';
import type { LeakInfo } from '../engine/protocol';
import { fmt, km, pMPa, qM3h, tC } from './format';

export interface SchematicState {
  profile?: PipeProfile;
  leaks: LeakInfo[];
  estimate?: { x: number; interval?: [number, number] };
  unhealthy: string[];
  alarm: boolean;
}

const PAD_X = 48;
const KIND_COLOR = { p: '#2563eb', q: '#059669', T: '#d97706' } as const;

function pressureColor(f: number): string {
  // синий (низкое) → зелёный → красный (высокое)
  const hue = 240 - 240 * Math.min(1, Math.max(0, f));
  return `hsl(${hue}, 75%, 50%)`;
}

export class Schematic {
  readonly canvas: HTMLCanvasElement;
  private cfg: PipelineConfig | null = null;
  private state: SchematicState = { leaks: [], unhealthy: [], alarm: false };
  private hoverX: number | null = null;
  private dark = true;

  constructor(private readonly host: HTMLElement, private readonly onPick: (x: number) => void) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'schematic';
    this.canvas.title = 'Клик по трубе — поставить утечку';
    host.append(
      this.canvas,
      Object.assign(document.createElement('div'), {
        className: 'legend small muted',
        innerHTML:
          '<span class="grad"></span> давление: синий — ниже, красный — выше · ' +
          '<b style="color:#2563eb">●</b> давление <b style="color:#059669">●</b> расход <b style="color:#d97706">●</b> температура ' +
          '<b style="color:#dc2626">●</b> неисправен · <b style="color:#dc2626">▲</b> утечка (правда) · <b style="color:#f59e0b">▼</b> оценка места',
      }),
    );
    new ResizeObserver(() => this.draw()).observe(host);
    this.canvas.addEventListener('click', (e) => {
      const x = this.toX(e.offsetX);
      if (x !== null) this.onPick(x);
    });
    this.canvas.addEventListener('mousemove', (e) => {
      this.hoverX = this.toX(e.offsetX);
      this.draw();
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.hoverX = null;
      this.draw();
    });
  }

  setConfig(cfg: PipelineConfig): void {
    this.cfg = cfg;
    this.draw();
  }

  private stateKey = '';

  update(state: SchematicState): void {
    // перерисовка, только если что-то видимое изменилось
    const key = `${state.profile?.t ?? ''}|${state.alarm}|${state.estimate?.x ?? ''}|${state.unhealthy.join()}|${state.leaks.map((l) => `${l.id}${l.hidden}`).join()}`;
    this.state = state;
    if (key === this.stateKey) return;
    this.stateKey = key;
    this.draw();
  }

  private toX(px: number): number | null {
    if (!this.cfg) return null;
    const w = this.canvas.clientWidth - 2 * PAD_X;
    const f = (px - PAD_X) / w;
    if (f < 0 || f > 1) return null;
    return f * this.cfg.geometry.length;
  }

  draw(): void {
    const cfg = this.cfg;
    const cv = this.canvas;
    const W = this.host.clientWidth;
    const H = 190;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      cv.style.width = `${W}px`;
      cv.style.height = `${H}px`;
    }
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!cfg) return;
    const ink = this.dark ? '#e5e7eb' : '#1f2937';
    const muted = this.dark ? '#9ca3af' : '#6b7280';
    const L = cfg.geometry.length;
    const w = W - 2 * PAD_X;
    const X = (x: number) => PAD_X + (x / L) * w;
    g.font = '11px system-ui, sans-serif';

    // профиль высот
    const el = cfg.geometry.elevation;
    const zs = el.map((p) => p[1]);
    const zMin = Math.min(...zs);
    const zMax = Math.max(...zs);
    const zSpan = Math.max(zMax - zMin, 1);
    const elevTop = 10;
    const elevH = 40;
    g.strokeStyle = muted;
    g.lineWidth = 1.5;
    g.beginPath();
    el.forEach(([x, z], i) => {
      const y = elevTop + elevH - ((z - zMin) / zSpan) * elevH;
      if (i) g.lineTo(X(x), y);
      else g.moveTo(X(x), y);
    });
    g.stroke();
    g.fillStyle = muted;
    g.fillText(`высота ${fmt(zMin, 0)}…${fmt(zMax, 0)} м`, 4, elevTop + 10);

    // труба с цветом по давлению
    const pipeY = 82;
    const pipeH = 18;
    const prof = this.state.profile;
    if (prof && prof.x.length > 1) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of prof.p) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      const span = Math.max(hi - lo, 1);
      const n = Math.min(400, Math.floor(w));
      for (let i = 0; i < n; i++) {
        const x = (L * (i + 0.5)) / n;
        g.fillStyle = pressureColor((interp(x, prof.x, prof.p) - lo) / span);
        g.fillRect(X((L * i) / n), pipeY, w / n + 1, pipeH);
      }
      g.fillStyle = muted;
      g.fillText(`давление ${fmt(pMPa(lo, cfg.ambientPressure), 2)}…${fmt(pMPa(hi, cfg.ambientPressure), 2)} МПа`, W - PAD_X - 170, pipeY - 6);
    } else {
      g.fillStyle = this.dark ? '#374151' : '#d1d5db';
      g.fillRect(PAD_X, pipeY, w, pipeH);
    }
    g.strokeStyle = this.state.alarm ? '#dc2626' : ink;
    g.lineWidth = this.state.alarm ? 3 : 1;
    g.strokeRect(PAD_X, pipeY, w, pipeH);

    // датчики: маркеры под трубой, подписи без наложения
    const sensors = [...cfg.sensors].sort((a, b) => a.x - b.x || a.kind.localeCompare(b.kind));
    let lastLabel = -Infinity;
    const stack = new Map<number, number>();
    for (const s of sensors) {
      const px = X(s.x);
      const level = stack.get(Math.round(px)) ?? 0;
      stack.set(Math.round(px), level + 1);
      const y = pipeY + pipeH + 8 + level * 9;
      const bad = this.state.unhealthy.includes(s.id);
      g.fillStyle = bad ? '#dc2626' : KIND_COLOR[s.kind];
      g.beginPath();
      g.arc(px, y, 3.5, 0, Math.PI * 2);
      g.fill();
      if (bad) {
        g.strokeStyle = '#dc2626';
        g.beginPath();
        g.moveTo(px - 5, y - 5);
        g.lineTo(px + 5, y + 5);
        g.stroke();
      }
      if (s.kind === 'p' && px - lastLabel > 46) {
        g.fillStyle = ink;
        g.fillText(s.id, px - g.measureText(s.id).width / 2, pipeY + pipeH + 46);
        lastLabel = px;
      }
    }

    // ось км
    g.fillStyle = muted;
    g.strokeStyle = muted;
    g.lineWidth = 1;
    const step = niceStep(L / 1000, Math.max(2, Math.floor(w / 70)));
    for (let k = 0; k <= L / 1000 + 1e-9; k += step) {
      const px = X(k * 1000);
      g.beginPath();
      g.moveTo(px, H - 30);
      g.lineTo(px, H - 25);
      g.stroke();
      const label = `${fmt(k, step < 1 ? 1 : 0)}`;
      g.fillText(label, px - g.measureText(label).width / 2, H - 13);
    }
    g.fillText('км', W - PAD_X + 6, H - 13);

    // оценка места утечки
    const est = this.state.estimate;
    if (est) {
      g.strokeStyle = '#f59e0b';
      g.fillStyle = '#f59e0b';
      g.lineWidth = 3;
      if (est.interval) {
        g.beginPath();
        g.moveTo(X(est.interval[0]), pipeY - 14);
        g.lineTo(X(est.interval[1]), pipeY - 14);
        g.stroke();
      }
      tri(g, X(est.x), pipeY - 4, 8, false);
      g.fillText('оценка', X(est.x) + 8, pipeY - 18);
    }
    // истинные утечки
    for (const l of this.state.leaks) {
      if (l.hidden) continue;
      g.fillStyle = '#dc2626';
      tri(g, X(l.x), pipeY + pipeH + 4, 8, true);
      const lbl = `утечка ${l.sizePct !== undefined ? fmt(l.sizePct, 1) + '%' : ''}`;
      g.fillText(lbl, X(l.x) + 8, pipeY + pipeH + 30);
    }

    // наведение: значения в точке
    if (this.hoverX !== null) {
      const px = X(this.hoverX);
      g.strokeStyle = muted;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(px, elevTop);
      g.lineTo(px, H - 30);
      g.stroke();
      g.setLineDash([]);
      const parts = [`${fmt(km(this.hoverX), 2)} км`];
      if (prof) {
        parts.push(`${fmt(pMPa(interp(this.hoverX, prof.x, prof.p), cfg.ambientPressure), 3)} МПа`);
        parts.push(`${fmt(qM3h(interp(this.hoverX, prof.x, prof.q)), 0)} м³/ч`);
        parts.push(`${fmt(tC(interp(this.hoverX, prof.x, prof.T)), 1)} °C`);
      }
      const text = parts.join('  ·  ');
      const tw = g.measureText(text).width + 10;
      const bx = Math.min(Math.max(px - tw / 2, 2), W - tw - 2);
      g.fillStyle = this.dark ? 'rgba(17,24,39,.9)' : 'rgba(255,255,255,.92)';
      g.fillRect(bx, elevTop + elevH + 2, tw, 16);
      g.fillStyle = ink;
      g.fillText(text, bx + 5, elevTop + elevH + 14);
    }
  }
}

function tri(g: CanvasRenderingContext2D, x: number, y: number, s: number, up: boolean): void {
  g.beginPath();
  if (up) {
    g.moveTo(x, y);
    g.lineTo(x - s, y + s * 1.4);
    g.lineTo(x + s, y + s * 1.4);
  } else {
    g.moveTo(x, y);
    g.lineTo(x - s, y - s * 1.4);
    g.lineTo(x + s, y - s * 1.4);
  }
  g.closePath();
  g.fill();
}

function niceStep(span: number, maxTicks: number): number {
  const raw = span / maxTicks;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}
