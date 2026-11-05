/**
 * Графики (WP-C4) на uPlot: давление (замер и прогноз), расход, статистика детектора с порогом,
 * нормированная невязка. Набор рядов строится из конфига — без правки кода под другую трубу.
 * Обновление — не чаще 30 раз в секунду.
 */
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { PipelineConfig } from '@pipetwin/core/contracts';
import type { SeriesStore } from './store';
import { h } from './dom';

/** Ряды на тёмно-синем фоне: яркие, различимые, без красного (он — только для аварии). */
const PALETTE = ['#4f8ff7', '#34d399', '#fbbf24', '#c084fc', '#22d3ee', '#fb923c', '#a3e635', '#f472b6', '#93c5fd', '#fde68a'];
const AXIS = '#8f9bd0';
const GRID = 'rgba(143, 155, 208, 0.12)';

interface ChartDef {
  title: string;
  /** Только в инженерном виде. */
  eng?: boolean;
  unit: string;
  keys: string[];
  series: uPlot.Series[];
}

export interface Marker {
  t: number;
  color: string;
  label: string;
}

/** Вертикальные метки событий (начало утечки, тревога) на всех графиках. */
function markersPlugin(get: () => Marker[]): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const ctx = u.ctx;
        const { top, height } = u.bbox;
        for (const m of get()) {
          const x = u.valToPos(m.t, 'x', true);
          if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue;
          ctx.save();
          ctx.strokeStyle = m.color;
          ctx.lineWidth = 2 * devicePixelRatio;
          ctx.setLineDash([6 * devicePixelRatio, 4 * devicePixelRatio]);
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, top + height);
          ctx.stroke();
          ctx.fillStyle = m.color;
          ctx.font = `${11 * devicePixelRatio}px system-ui`;
          ctx.fillText(m.label, x + 4 * devicePixelRatio, top + 12 * devicePixelRatio);
          ctx.restore();
        }
      },
    },
  };
}

export class Charts {
  private plots: Array<{ def: ChartDef; plot: uPlot; host: HTMLElement }> = [];
  private markers: Marker[] = [];
  windowSec = 60;

  setMarkers(m: Marker[]): void {
    this.markers = m;
  }

  constructor(private readonly host: HTMLElement) {
    new ResizeObserver(() => this.resize()).observe(host);
  }

  build(cfg: PipelineConfig, inputs: string[]): void {
    for (const p of this.plots) p.plot.destroy();
    this.plots = [];
    this.host.replaceChildren();
    const color = (i: number) => PALETTE[i % PALETTE.length]!;
    const ps = cfg.sensors.filter((s) => s.kind === 'p');
    const qs = cfg.sensors.filter((s) => s.kind === 'q');
    const resid = cfg.sensors.filter((s) => s.kind !== 'T' && !inputs.includes(s.id));
    const pair = (ids: typeof ps): Pick<ChartDef, 'keys' | 'series'> => {
      const keys: string[] = [];
      const series: uPlot.Series[] = [];
      ids.forEach((s, i) => {
        keys.push(`m:${s.id}`);
        series.push({ label: `${s.id} замер`, stroke: color(i), width: 1.2 });
        if (!inputs.includes(s.id)) {
          keys.push(`p:${s.id}`);
          series.push({ label: `${s.id} прогноз`, stroke: color(i), width: 2, dash: [6, 4] });
        }
      });
      return { keys, series };
    };
    const defs: ChartDef[] = [
      { title: 'Давление: замер и прогноз twin', unit: 'МПа (изб.)', ...pair(ps) },
      { title: 'Расход: замер и прогноз twin', unit: 'м³/ч', ...pair(qs) },
      {
        title: 'Статистика детектора и порог',
        eng: true,
        unit: '',
        keys: ['score', 'thr', 'alarmBand'],
        series: [
          { label: 'статистика', stroke: '#4f8ff7', width: 1.8, fill: 'rgba(79,143,247,0.10)' },
          { label: 'порог', stroke: '#f87171', width: 1.5, dash: [8, 5] },
          { label: 'тревога', stroke: 'rgba(248,113,113,0)', fill: 'rgba(248,113,113,0.14)', width: 0 },
        ],
      },
      {
        title: 'Нормированная невязка z = (замер − прогноз − μ)/σ',
        eng: true,
        unit: 'σ',
        keys: resid.map((s) => `z:${s.id}`),
        series: resid.map((s, i) => ({ label: s.id, stroke: color(i), width: 1.2 })),
      },
    ];
    for (const def of defs) {
      if (!def.keys.length) continue;
      const box = h('div', { class: def.eng ? 'chart eng-only' : 'chart' }, h('div', { class: 'chart-title' }, def.title, def.unit ? h('span', { class: 'muted' }, ` · ${def.unit}`) : ''));
      const holder = h('div');
      box.append(holder);
      this.host.append(box);
      const opts: uPlot.Options = {
        width: Math.max(300, holder.clientWidth || this.host.clientWidth - 24),
        height: 170,
        legend: { show: true, live: false },
        cursor: { drag: { x: false, y: false } },
        scales: { x: { time: false } },
        axes: [
          { label: 'модельное время, с', size: 34, labelSize: 14, stroke: AXIS, grid: { stroke: GRID }, ticks: { stroke: GRID } },
          { size: 56, stroke: AXIS, grid: { stroke: GRID }, ticks: { stroke: GRID } },
        ],
        series: [{ label: 't' }, ...def.series],
        plugins: [markersPlugin(() => this.markers)],
      };
      const empty = [[], ...def.keys.map(() => [])] as unknown as uPlot.AlignedData;
      this.plots.push({ def, plot: new uPlot(opts, empty, holder), host: holder });
    }
    this.resize();
  }

  update(store: SeriesStore): void {
    for (const { def, plot } of this.plots) plot.setData(store.window(def.keys, this.windowSec) as unknown as uPlot.AlignedData);
  }

  resize(): void {
    for (const { plot, host } of this.plots) {
      const w = Math.max(280, host.clientWidth);
      if (Math.abs(plot.width - w) > 2) plot.setSize({ width: w, height: 170 });
    }
  }

  /** Снимок всех графиков в PNG (для слайдов, WP-C6). */
  snapshot(): string {
    const cvs = this.plots.map((p) => p.plot.ctx.canvas);
    if (!cvs.length) return '';
    const w = Math.max(...cvs.map((c) => c.width));
    const hh = cvs.reduce((a, c) => a + c.height, 0);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = hh;
    const g = out.getContext('2d')!;
    g.fillStyle = '#0a1030';
    g.fillRect(0, 0, w, hh);
    let y = 0;
    for (const c of cvs) {
      g.drawImage(c, 0, y);
      y += c.height;
    }
    return out.toDataURL('image/png');
  }
}
