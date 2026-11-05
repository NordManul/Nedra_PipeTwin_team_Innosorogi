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
import type { ActiveLeak, DetectorOutput, LocationStage, PipelineConfig, SensorFrame } from '@pipetwin/core/contracts';
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
  /** Все активные утечки — у каждой своя зона на схеме. */
  leaks: ActiveLeak[];
}

const C = {
  bg: '#111a48',
  pipe: '#5a74d6',
  pipeAlarm: '#c7d2fe',
  ink: '#e6ebff',
  muted: '#8f9bd0',
  faint: '#1f2b66',
  tagBg: '#16205a',
  tagLine: '#33448c',
  accent: '#4f8ff7',
  flow: '#7dd3fc',
  ok: '#34d399',
  warn: '#fbbf24',
  alarm: '#f87171',
  zone: 'rgba(248, 113, 113, 0.20)',
  zoneLine: 'rgba(248, 113, 113, 0.95)',
  stage: { segment: 'rgba(251, 191, 36, 0.40)', wave: 'rgba(79, 143, 247, 0.55)', profile: 'rgba(248, 113, 113, 0.6)', ml: 'rgba(192, 132, 252, 0.55)' } as Record<LocationStage, string>,
};
const FONT = '"Manrope", "IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
const MONO = '"JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace';

const PAD_L = 130;
const PAD_R = 130;

export class OperatorView {
  private readonly mimic: HTMLCanvasElement;
  private readonly funnel: HTMLCanvasElement;
  private cfg: PipelineConfig | null = null;
  private state: OperatorState = { frame: null, out: null, inputs: [], zone: [], transient: false, leaks: [] };

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
    g.font = `11px ${FONT}`;
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

    // зоны поиска всех активных утечек: подтверждённые — сплошной рамкой, текущая — пунктиром
    const leaks = this.state.leaks.length ? this.state.leaks : [];
    const labelRows: Array<{ x0: number; x1: number; row: number }> = [];
    for (const l of leaks) {
      const iv = l.locationInterval;
      if (!iv) continue;
      const whole = iv[1] - iv[0] >= 0.9 * L;
      const x0 = X(iv[0]);
      const x1 = Math.max(X(iv[1]), x0 + 2);
      const zg = g.createLinearGradient(0, 34, 0, H - 26);
      zg.addColorStop(0, whole ? 'rgba(248,113,113,0.04)' : 'rgba(248,113,113,0.05)');
      zg.addColorStop(0.5, whole ? 'rgba(248,113,113,0.10)' : 'rgba(248,113,113,0.32)');
      zg.addColorStop(1, whole ? 'rgba(248,113,113,0.04)' : 'rgba(248,113,113,0.05)');
      g.fillStyle = zg;
      g.fillRect(x0, 34, x1 - x0, H - 60);
      g.strokeStyle = C.zoneLine;
      g.setLineDash(l.state === 'confirmed' ? [] : [4, 3]);
      g.strokeRect(x0 + 0.5, 34.5, x1 - x0 - 1, H - 61);
      g.setLineDash([]);
      const n = l.id.replace(/^L/, '');
      const stage = l.locationStage ? STAGE_NAMES[l.locationStage] : '';
      const text = whole
        ? `№${n}: МЕСТО НЕ ОПРЕДЕЛЕНО — ВЕСЬ УЧАСТОК`
        : `№${n}${l.state === 'confirmed' ? ' ПОДТВ.' : ''} км ${fmt(km(iv[0]), 1)}–${fmt(km(iv[1]), 1)}${stage ? ` · ${stage}` : ''}`;
      g.font = `bold 11px ${FONT}`;
      const tw = g.measureText(text).width;
      const tx = Math.min(Math.max((x0 + x1) / 2 - tw / 2, 4), W - tw - 4);
      let row = 0;
      while (labelRows.some((r) => r.row === row && tx < r.x1 + 6 && tx + tw > r.x0 - 6)) row++;
      labelRows.push({ x0: tx, x1: tx + tw, row });
      g.fillStyle = C.alarm;
      g.fillText(text, tx, 48 + row * 14);
      g.font = `11px ${FONT}`;
    }

    // труба: объёмная (градиент), поток — бегущие шевроны
    const pg = g.createLinearGradient(0, pipeY - 8, 0, pipeY + 8);
    pg.addColorStop(0, '#3a4fa8');
    pg.addColorStop(0.45, '#22307a');
    pg.addColorStop(1, '#141d52');
    g.fillStyle = pg;
    g.beginPath();
    g.roundRect(X(0) - 46, pipeY - 8, w + 92, 16, 8);
    g.fill();
    g.strokeStyle = alarm ? C.pipeAlarm : C.pipe;
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.fillRect(X(0) - 40, pipeY - 6, w + 80, 2);
    g.fillStyle = alarm ? 'rgba(199,210,254,0.55)' : 'rgba(125,211,252,0.6)';
    const phase = ((performance.now() / 40) % 48) / 48;
    for (let px = X(0) + phase * 48; px < X(L); px += 48) arrow(g, px, pipeY + 1, 4);
    if (suspect && !alarm) {
      g.strokeStyle = C.warn;
      g.setLineDash([6, 4]);
      g.strokeRect(X(0) - 4, pipeY - 12, w + 8, 24);
      g.setLineDash([]);
    }

    // станции на концах трубы
    station(g, X(0) - 72, pipeY, 'НПС (вход)', 'pump', C);
    station(g, X(L) + 72, pipeY, 'КП (выход)', 'valve', C);

    // точки оценки места (не рисуем, если зона — весь участок: точка там ничего не значит)
    for (const l of leaks) {
      const iv = l.locationInterval;
      if (l.location === undefined || (iv && iv[1] - iv[0] >= 0.9 * L)) continue;
      const px = X(l.location);
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
      g.fillStyle = `rgba(248,113,113,${0.15 + 0.2 * pulse})`;
      g.beginPath();
      g.arc(px, pipeY, 16 + 4 * pulse, 0, Math.PI * 2);
      g.fill();
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
      g.font = `10px ${MONO}`;
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
      g.beginPath();
      g.roundRect(bx + 0.5, by + 0.5, tw - 1, bh - 1, 6);
      g.fill();
      g.strokeStyle = state === 'bad' ? C.alarm : state === 'warn' ? C.warn : C.tagLine;
      g.lineWidth = state === 'ok' ? 1 : 2;
      g.stroke();
      g.fillStyle = state === 'bad' ? C.alarm : state === 'warn' ? C.warn : s.kind === 'p' ? C.accent : s.kind === 'q' ? C.ok : '#fb923c';
      g.fillRect(bx + 1, by + 4, 2, bh - 8);
      g.fillStyle = C.muted;
      g.fillText(tag, bx + 7, by + 11);
      g.fillStyle = state === 'bad' ? C.alarm : C.ink;
      g.font = `bold 10px ${MONO}`;
      g.fillText(value, bx + 7, by + 22);
      g.font = `11px ${FONT}`;
    }

    // состояние внизу
    g.fillStyle = alarm ? C.alarm : suspect ? C.warn : C.muted;
    const nLeaks = this.state.leaks.length;
    const status = alarm
      ? nLeaks > 1
        ? `АВАРИЯ: активных утечек ${nLeaks}`
        : `АВАРИЯ: признаки утечки${out?.location !== undefined && !(out.locationInterval && out.locationInterval[1] - out.locationInterval[0] >= 0.9 * L) ? ` · оценка км ${fmt(km(out.location), 1)}` : ' · место уточняется'}`
      : suspect
        ? 'ПОДОЗРЕНИЕ: отклонение от модели, идёт проверка'
        : out?.phase === 'warmup'
          ? 'ПРОГРЕВ: система оценивает норму и шум датчиков'
          : this.state.transient
            ? 'ПЕРЕХОДНЫЙ РЕЖИМ: смена режима перекачки, порог временно повышен'
            : 'НОРМА';
    g.font = `bold 11px ${FONT}`;
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
    // линия оценки — только где зона уже, чем весь участок (иначе точка ничего не значит)
    g.beginPath();
    let pen = false;
    for (const a of zone) {
      if (a.hi - a.lo >= 0.9 * L) {
        pen = false;
        continue;
      }
      if (pen) g.lineTo(X(a.x), Y(a.dt));
      else g.moveTo(X(a.x), Y(a.dt));
      pen = true;
    }
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
  // круглая «плашка» станции с ореолом
  const glow = g.createRadialGradient(cx, cy, 8, cx, cy, 34);
  glow.addColorStop(0, kind === 'pump' ? 'rgba(52,211,153,0.35)' : 'rgba(79,143,247,0.35)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = glow;
  g.beginPath();
  g.arc(cx, cy, 34, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#16205a';
  g.strokeStyle = kind === 'pump' ? c.ok : c.accent;
  g.lineWidth = 2;
  g.beginPath();
  g.arc(cx, cy, 20, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.beginPath();
  if (kind === 'pump') {
    // ротор насоса: три лопасти
    g.fillStyle = c.ok;
    for (let i = 0; i < 3; i++) {
      const a = (i * 2 * Math.PI) / 3 + performance.now() / 600;
      g.moveTo(cx, cy);
      g.arc(cx, cy, 13, a, a + 0.9);
      g.closePath();
    }
    g.fill();
    g.fillStyle = '#16205a';
    g.beginPath();
    g.arc(cx, cy, 3.5, 0, Math.PI * 2);
    g.fill();
  } else {
    g.fillStyle = c.accent;
    g.moveTo(cx - 11, cy - 8);
    g.lineTo(cx, cy);
    g.lineTo(cx - 11, cy + 8);
    g.closePath();
    g.moveTo(cx + 11, cy - 8);
    g.lineTo(cx, cy);
    g.lineTo(cx + 11, cy + 8);
    g.closePath();
    g.fill();
  }
  g.fillStyle = c.ink;
  g.font = `bold 11px ${FONT}`;
  g.fillText(label, cx - g.measureText(label).width / 2, cy + 36);
  g.font = `11px ${FONT}`;
}

function niceStep(span: number, maxTicks: number): number {
  const raw = span / maxTicks;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}
