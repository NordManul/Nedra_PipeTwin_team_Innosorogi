/**
 * Мнемосхема оператора СОУ: только то, что знает система обнаружения утечек.
 * Правды (истинной утечки, давления в каждой точке plant) здесь нет — её показывает тренажёр.
 *
 * Стиль — как у мнемосхем по ISA-101: спокойный серый, цвет только для отклонений
 * (жёлтый — отклонение/подозрение, красный — авария), значения датчиков рядом с точками замера.
 *
 * Ниже схемы — «воронка»: как сужается зона поиска утечки со временем после тревоги
 * (по горизонтали — тот же километраж, по вертикали — секунды после тревоги).
 */
import type { DetectorOutput, LocationStage, PipelineConfig, SensorFrame } from '@pipetwin/core/contracts';
import { display, fmt, km } from './format';

export const STAGE_NAMES: Record<LocationStage, string> = {
  segment: 'по первому датчику',
  wave: 'по волне давления',
  profile: 'по профилю давления',
  ml: 'по ML-модели',
};

export interface ZoneSample {
  /** Секунды после тревоги. */
  dt: number;
  lo: number;
  hi: number;
  x: number;
  stage?: LocationStage;
}

export interface OperatorState {
  frame: SensorFrame | null;
  out: DetectorOutput | null;
  /** Датчики — входы модели (граничные). */
  inputs: string[];
  /** История зоны поиска текущей тревоги. */
  zone: ZoneSample[];
  /** Переходный режим (смена режима перекачки). */
  transient: boolean;
}

const C = {
  bg: '#1b1f24',
  pipe: '#7d8590',
  pipeAlarm: '#c9d1d9',
  ink: '#d0d7de',
  muted: '#8b949e',
  faint: '#30363d',
  tagBg: '#22272e',
  tagLine: '#444c56',
  warn: '#d29922',
  alarm: '#f85149',
  zone: 'rgba(248, 81, 73, 0.22)',
  zoneLine: 'rgba(248, 81, 73, 0.9)',
  stage: { segment: 'rgba(210, 153, 34, 0.35)', wave: 'rgba(88, 166, 255, 0.45)', profile: 'rgba(248, 81, 73, 0.55)', ml: 'rgba(163, 113, 247, 0.5)' } as Record<LocationStage, string>,
};

const PAD_L = 130;
const PAD_R = 130;

export class OperatorView {
  private readonly mimic: HTMLCanvasElement;
  private readonly funnel: HTMLCanvasElement;
  private cfg: PipelineConfig | null = null;
  private state: OperatorState = { frame: null, out: null, inputs: [], zone: [], transient: false };

  constructor(private readonly host: HTMLElement) {
    this.mimic = document.createElement('canvas');
    this.mimic.className = 'mimic';
    this.funnel = document.createElement('canvas');
    this.funnel.className = 'funnel';
    const legend = document.createElement('div');
    legend.className = 'legend small muted';
    legend.innerHTML =
      '<span class="lg zone"></span> зона поиска утечки (≈90%) · <span class="lg pt"></span> оценка места · ' +
      '<span class="lg warn"></span> отклонение от модели · <span class="lg bad"></span> неисправен · ▸М — вход модели · ' +
      'стадии: <span class="lg st-segment"></span> первый датчик <span class="lg st-wave"></span> волна <span class="lg st-profile"></span> профиль <span class="lg st-ml"></span> ML';
    host.append(this.mimic, this.funnel, legend);
    new ResizeObserver(() => this.draw()).observe(host);
  }

  setConfig(cfg: PipelineConfig): void {
    this.cfg = cfg;
    this.draw();
  }

  update(state: OperatorState): void {
    this.state = state;
    this.draw();
  }

  private size(cv: HTMLCanvasElement, H: number): CanvasRenderingContext2D {
    const W = this.host.clientWidth;
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
    g.font = '11px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
    return g;
  }

  draw(): void {
    this.drawMimic();
    this.drawFunnel();
  }

  private drawMimic(): void {
    const cfg = this.cfg;
    const H = 250;
    const g = this.size(this.mimic, H);
    if (!cfg) return;
    const W = this.host.clientWidth;
    const L = cfg.geometry.length;
    const w = W - PAD_L - PAD_R;
    const X = (x: number) => PAD_L + (x / L) * w;
    const { out, frame, inputs } = this.state;
    const alarm = !!out?.alarm;
    const suspect = out?.phase === 'suspect';
    const pipeY = 128;

    // километраж сверху
    g.fillStyle = C.muted;
    g.strokeStyle = C.faint;
    g.lineWidth = 1;
    const step = niceStep(L / 1000, Math.max(2, Math.floor(w / 80)));
    for (let k = 0; k <= L / 1000 + 1e-9; k += step) {
      const px = X(k * 1000);
      g.beginPath();
      g.moveTo(px, 22);
      g.lineTo(px, H - 26);
      g.stroke();
      const label = `${fmt(k, step < 1 ? 1 : 0)}`;
      g.fillText(label, px - g.measureText(label).width / 2, 14);
    }
    g.fillText('км', X(L) + 14, 14);

    // зона поиска и оценка места
    const lo = out?.locationInterval?.[0];
    const hi = out?.locationInterval?.[1];
    if (alarm && lo !== undefined && hi !== undefined) {
      const x0 = X(lo);
      const x1 = Math.max(X(hi), x0 + 2);
      g.fillStyle = C.zone;
      g.fillRect(x0, 34, x1 - x0, H - 60);
      g.strokeStyle = C.zoneLine;
      g.setLineDash([4, 3]);
      g.strokeRect(x0 + 0.5, 34.5, x1 - x0 - 1, H - 61);
      g.setLineDash([]);
      const stage = out?.locationStage ? STAGE_NAMES[out.locationStage] : '';
      const text = `ЗОНА ПОИСКА км ${fmt(km(lo), 1)}–${fmt(km(hi), 1)}${stage ? ` · ${stage}` : ''}`;
      g.font = 'bold 11px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
      const tw = g.measureText(text).width;
      const tx = Math.min(Math.max((x0 + x1) / 2 - tw / 2, 4), W - tw - 4);
      g.fillStyle = C.alarm;
      g.fillText(text, tx, 48);
      g.font = '11px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
    }

    // труба: две линии стенки, направление потока
    g.strokeStyle = alarm ? C.pipeAlarm : C.pipe;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(X(0), pipeY - 6);
    g.lineTo(X(L), pipeY - 6);
    g.moveTo(X(0), pipeY + 6);
    g.lineTo(X(L), pipeY + 6);
    g.stroke();
    g.fillStyle = alarm ? 'rgba(201,209,217,.08)' : 'rgba(125,133,144,.08)';
    g.fillRect(X(0), pipeY - 5, w, 10);
    g.fillStyle = C.muted;
    for (let i = 1; i < 6; i++) arrow(g, PAD_L + (w * i) / 6, pipeY, 6);
    if (suspect && !alarm) {
      g.strokeStyle = C.warn;
      g.setLineDash([6, 4]);
      g.strokeRect(X(0) - 4, pipeY - 12, w + 8, 24);
      g.setLineDash([]);
    }

    // станции и патрубки к ним
    g.strokeStyle = C.pipe;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(X(0) - 46, pipeY);
    g.lineTo(X(0), pipeY);
    g.moveTo(X(L), pipeY);
    g.lineTo(X(L) + 46, pipeY);
    g.stroke();
    station(g, X(0) - 72, pipeY, 'НПС (вход)', 'pump', C);
    station(g, X(L) + 72, pipeY, 'КП (выход)', 'valve', C);

    // точка оценки
    if (alarm && out?.location !== undefined) {
      const px = X(out.location);
      g.fillStyle = C.alarm;
      g.beginPath();
      g.moveTo(px, pipeY - 13);
      g.lineTo(px + 7, pipeY);
      g.lineTo(px, pipeY + 13);
      g.lineTo(px - 7, pipeY);
      g.closePath();
      g.fill();
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1;
      g.stroke();
    }

    // датчики: точка на трубе и таблички со значениями (давление — сверху, остальное — снизу)
    const bad = new Set(out?.unhealthySensors ?? []);
    const z = out?.z ?? {};
    const sensors = [...cfg.sensors].sort((a, b) => a.x - b.x);
    const placed: Array<{ x0: number; x1: number; row: number; up: boolean }> = [];
    for (const s of sensors) {
      const px = X(s.x);
      const up = s.kind === 'p';
      const v = frame?.values[s.id];
      const valid = v !== undefined && frame?.valid?.[s.id] !== false;
      const zz = z[s.id];
      const state: 'ok' | 'warn' | 'bad' = bad.has(s.id) ? 'bad' : zz !== undefined && Math.abs(zz) > 3 ? 'warn' : 'ok';
      const unit = s.kind === 'p' ? 'МПа' : s.kind === 'q' ? 'м³/ч' : '°C';
      const value = valid ? `${fmt(display(s.kind, v!, cfg.ambientPressure), s.kind === 'p' ? 3 : s.kind === 'q' ? 0 : 1)} ${unit}` : 'нет данных';
      const tag = `${s.kind === 'p' ? 'PT' : s.kind === 'q' ? 'FT' : 'TT'} ${s.id}${inputs.includes(s.id) ? ' ▸М' : ''}`;
      g.font = '10px "IBM Plex Mono", ui-monospace, monospace';
      const tw = Math.max(g.measureText(tag).width, g.measureText(value).width) + 10;
      const bx = Math.min(Math.max(px - tw / 2, 2), W - tw - 2);
      // ряд, в котором табличка не наезжает на соседние
      let row = 0;
      while (placed.some((p) => p.up === up && p.row === row && bx < p.x1 + 4 && bx + tw > p.x0 - 4)) row++;
      placed.push({ x0: bx, x1: bx + tw, row, up });
      const bh = 26;
      const by = up ? pipeY - 26 - bh - row * (bh + 4) : pipeY + 22 + row * (bh + 4);
      // выноска
      g.strokeStyle = C.tagLine;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(px, up ? by + bh : by);
      g.lineTo(px, up ? pipeY - 7 : pipeY + 7);
      g.stroke();
      // точка замера
      g.fillStyle = state === 'bad' ? C.alarm : state === 'warn' ? C.warn : C.ink;
      g.beginPath();
      g.arc(px, up ? pipeY - 7 : pipeY + 7, 3, 0, Math.PI * 2);
      g.fill();
      // табличка
      g.fillStyle = C.tagBg;
      g.fillRect(bx, by, tw, bh);
      g.strokeStyle = state === 'bad' ? C.alarm : state === 'warn' ? C.warn : C.tagLine;
      g.lineWidth = state === 'ok' ? 1 : 2;
      g.strokeRect(bx + 0.5, by + 0.5, tw - 1, bh - 1);
      g.fillStyle = C.muted;
      g.fillText(tag, bx + 5, by + 11);
      g.fillStyle = state === 'bad' ? C.alarm : C.ink;
      g.fillText(value, bx + 5, by + 22);
      g.font = '11px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
    }

    // состояние внизу
    g.fillStyle = alarm ? C.alarm : suspect ? C.warn : C.muted;
    const status = alarm
      ? `АВАРИЯ: признаки утечки${out?.location !== undefined ? ` · оценка км ${fmt(km(out.location), 1)}` : ''}`
      : suspect
        ? 'ПОДОЗРЕНИЕ: отклонение от модели, идёт проверка'
        : out?.phase === 'warmup'
          ? 'ПРОГРЕВ: система оценивает норму и шум датчиков'
          : this.state.transient
            ? 'ПЕРЕХОДНЫЙ РЕЖИМ: смена режима перекачки, порог временно повышен'
            : 'НОРМА';
    g.font = 'bold 11px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
    g.fillText(status, PAD_L, H - 8);
  }

  private drawFunnel(): void {
    const cfg = this.cfg;
    const zone = this.state.zone;
    const show = !!cfg && zone.length > 0;
    this.funnel.style.display = show ? 'block' : 'none';
    if (!show || !cfg) return;
    const H = 150;
    const g = this.size(this.funnel, H);
    const W = this.host.clientWidth;
    const L = cfg.geometry.length;
    const w = W - PAD_L - PAD_R;
    const X = (x: number) => PAD_L + (x / L) * w;
    const tMax = Math.max(30, zone.at(-1)!.dt);
    const top = 18;
    const Y = (dt: number) => top + (dt / tMax) * (H - top - 14);
    g.fillStyle = C.muted;
    g.fillText('СУЖЕНИЕ ЗОНЫ ПОИСКА', 4, 12);
    g.fillText('0 с', PAD_L - 34, top + 8);
    g.fillText(`${fmt(tMax, 0)} с`, PAD_L - 40, H - 14);
    g.strokeStyle = C.faint;
    g.strokeRect(X(0) + 0.5, top + 0.5, w - 1, H - top - 14);
    for (let i = 0; i < zone.length; i++) {
      const a = zone[i]!;
      const b = zone[i + 1];
      const y0 = Y(a.dt);
      const y1 = b ? Y(b.dt) : y0 + 2;
      g.fillStyle = a.stage ? C.stage[a.stage] : C.zone;
      g.fillRect(X(a.lo), y0, Math.max(2, X(a.hi) - X(a.lo)), Math.max(1, y1 - y0));
    }
    // линия оценки места
    g.strokeStyle = C.alarm;
    g.lineWidth = 1.5;
    g.beginPath();
    zone.forEach((a, i) => (i ? g.lineTo(X(a.x), Y(a.dt)) : g.moveTo(X(a.x), Y(a.dt))));
    g.stroke();
    const last = zone.at(-1)!;
    g.fillStyle = C.ink;
    const txt = `сейчас: км ${fmt(km(last.lo), 1)}–${fmt(km(last.hi), 1)} (ширина ${fmt(km(last.hi - last.lo), 1)} км)`;
    g.fillText(txt, Math.min(W - g.measureText(txt).width - 4, X(last.hi) + 8), Math.min(H - 4, Y(last.dt) + 4));
  }
}

function arrow(g: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  g.beginPath();
  g.moveTo(x + s, y);
  g.lineTo(x - s / 2, y - s / 1.6);
  g.lineTo(x - s / 2, y + s / 1.6);
  g.closePath();
  g.fill();
}

function station(g: CanvasRenderingContext2D, cx: number, cy: number, label: string, kind: 'pump' | 'valve', c: typeof C): void {
  g.strokeStyle = c.ink;
  g.fillStyle = c.tagBg;
  g.lineWidth = 1.5;
  g.fillRect(cx - 26, cy - 20, 52, 36);
  g.strokeRect(cx - 26, cy - 20, 52, 36);
  g.beginPath();
  if (kind === 'pump') {
    g.arc(cx, cy - 2, 11, 0, Math.PI * 2);
    g.moveTo(cx - 6, cy - 9);
    g.lineTo(cx + 9, cy - 2);
    g.lineTo(cx - 6, cy + 5);
  } else {
    g.moveTo(cx - 12, cy - 10);
    g.lineTo(cx + 12, cy + 6);
    g.lineTo(cx + 12, cy - 10);
    g.lineTo(cx - 12, cy + 6);
    g.closePath();
  }
  g.stroke();
  g.fillStyle = c.muted;
  g.fillText(label, cx - g.measureText(label).width / 2, cy + 30);
}

function niceStep(span: number, maxTicks: number): number {
  const raw = span / maxTicks;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}
