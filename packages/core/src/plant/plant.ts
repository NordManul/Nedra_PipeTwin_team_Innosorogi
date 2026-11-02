/**
 * Plant — «настоящая» труба (зона правды). Нестационарный расчёт методом характеристик
 * с утечками, насосом и задвижкой. Детектор этот модуль не видит (проверка границ в CI).
 */
import type { ControlAction, LeakEvent, PipeProfile, PipelineConfig } from '../contracts';
import { MocSolver, type BoundarySpec, type NodeLeak } from '../hydraulics/moc';
import { G, PipeModel } from '../hydraulics/pipe';
import { steadyBackward, steadyForward, steadyFromPressures, type SteadyProfile } from '../hydraulics/steady';
import { findRoot } from '../math/roots';
import { interp } from '../math/stats';
import { evalSchedule, Ramp } from '../schedule';

export interface ActiveLeak {
  event: LeakEvent;
  node: number;
  /** Текущий расход утечки, м³/с. */
  rate: number;
  /** Расход на входе непосредственно перед утечкой, м³/с — база для доли. */
  baseInletFlow: number;
}

export class Plant {
  readonly cfg: PipelineConfig;
  readonly model: PipeModel;
  readonly solver: MocSolver;
  readonly leaks: ActiveLeak[] = [];
  readonly warnings: string[] = [];
  /** Множитель напора насоса (или избыточного давления / расхода на входе). */
  private readonly head = new Ramp(1);
  /** Степень открытия задвижки на выходе (переопределяет расписание после первого воздействия). */
  private valve: Ramp | null = null;

  constructor(cfg: PipelineConfig) {
    this.cfg = cfg;
    this.model = new PipeModel(cfg);
    this.solver = new MocSolver(this.model);
    this.solver.setState(this.initialSteady(), 0);
  }

  get t(): number {
    return this.solver.t;
  }

  get dt(): number {
    return this.solver.dt;
  }

  get waveSpeed(): number {
    return this.solver.a;
  }

  /** Установившийся режим при граничных условиях на t = 0. */
  private initialSteady(): SteadyProfile {
    const m = this.model;
    const b = this.cfg.boundary;
    const Tin = evalSchedule(b.inletTemp, 0);
    const rhoIn = m.fluid.rho(Tin);
    const inlet = b.inlet;
    const outlet = b.outlet;
    const pInOf = (mass: number): number => {
      if (inlet.type === 'pressure') return evalSchedule(inlet.pressure, 0);
      if (inlet.type === 'pump') {
        const s = inlet.speed === undefined ? 1 : evalSchedule(inlet.speed, 0);
        const Q = mass / rhoIn;
        return evalSchedule(inlet.suctionPressure, 0) + rhoIn * G * (inlet.H0 * s * s - inlet.b * Q * Q);
      }
      return NaN;
    };
    if (inlet.type === 'flow') {
      const mass = rhoIn * evalSchedule(inlet.flow, 0);
      const T = steadyForward(m, 0, mass, Tin).T;
      const rhoOut = m.fluid.rho(T[m.N - 1]!);
      if (outlet.type === 'pressure') return steadyBackward(m, evalSchedule(outlet.pressure, 0), mass, Tin);
      if (outlet.type === 'valve') {
        const c = outlet.cv * evalSchedule(outlet.opening, 0);
        const pN = evalSchedule(outlet.downstreamPressure, 0) + (mass / c) ** 2 / rhoOut;
        return steadyBackward(m, pN, mass, Tin);
      }
      throw new Error('boundary: расход задан на обоих концах или выход закрыт — установившийся режим не определён');
    }
    if (outlet.type === 'pressure' && inlet.type === 'pressure') {
      return steadyFromPressures(m, pInOf(0), evalSchedule(outlet.pressure, 0), Tin);
    }
    if (outlet.type === 'flow') {
      const mass = rhoIn * evalSchedule(outlet.flow, 0);
      return steadyForward(m, pInOf(mass), mass, Tin);
    }
    if (outlet.type === 'closed') return steadyForward(m, pInOf(0), 0, Tin);
    // давление/насос на входе + давление или задвижка на выходе: стрельба по расходу
    const resid = (mass: number): number => {
      const s = steadyForward(m, pInOf(mass), mass, Tin);
      const pN = s.p[m.N]!;
      if (outlet.type === 'pressure') return pN - evalSchedule(outlet.pressure, 0);
      const c = outlet.cv * evalSchedule(outlet.opening, 0);
      const d = pN - evalSchedule(outlet.downstreamPressure, 0);
      const rho = s.rhoSeg[m.N - 1]!;
      return mass - Math.sign(d) * c * Math.sqrt(rho * Math.abs(d));
    };
    const m0 = rhoIn * m.A * 1.5;
    const mass = findRoot(resid, m0, m0 * 0.5, { tol: 1e-9 * m0 });
    return steadyForward(m, pInOf(mass), mass, Tin);
  }

  private inletSpec(t: number): BoundarySpec {
    const inlet = this.cfg.boundary.inlet;
    const k = this.head.value(t);
    const pAtm = this.cfg.ambientPressure;
    switch (inlet.type) {
      case 'pressure':
        return { type: 'pressure', p: pAtm + (evalSchedule(inlet.pressure, t) - pAtm) * k };
      case 'flow':
        return { type: 'flow', m: this.solver.rhoSeg[0]! * evalSchedule(inlet.flow, t) * k };
      case 'pump': {
        const s = inlet.speed === undefined ? 1 : evalSchedule(inlet.speed, t);
        return { type: 'pump', ps: evalSchedule(inlet.suctionPressure, t), H: inlet.H0 * s * s * k, b: inlet.b };
      }
    }
  }

  private outletSpec(t: number): BoundarySpec {
    const o = this.cfg.boundary.outlet;
    switch (o.type) {
      case 'pressure':
        return { type: 'pressure', p: evalSchedule(o.pressure, t) };
      case 'flow':
        return { type: 'flow', m: this.solver.rhoSeg[this.model.N - 1]! * evalSchedule(o.flow, t) };
      case 'closed':
        return { type: 'closed' };
      case 'valve': {
        const tau = this.valve ? this.valve.value(t) : evalSchedule(o.opening, t);
        return { type: 'valve', pd: evalSchedule(o.downstreamPressure, t), c: o.cv * Math.max(0, tau) };
      }
    }
  }

  /** Один шаг Δt. */
  step(): void {
    const tNew = this.solver.t + this.solver.dt;
    const rhoAt = (node: number) => this.solver.rhoSeg[Math.min(node, this.model.N - 1)]!;
    const nodeLeaks: NodeLeak[] = this.leaks.map((l) => {
      const e = l.event;
      const frac = e.rampSec > 0 ? Math.min(1, Math.max(0, (tNew - e.tStart) / e.rampSec)) : tNew >= e.tStart ? 1 : 0;
      return { node: l.node, k: e.cd * e.area * frac * Math.sqrt(2 * rhoAt(l.node)) };
    });
    const vc = this.solver.vaporClamps;
    this.solver.step(this.inletSpec(tNew), this.outletSpec(tNew), nodeLeaks, evalSchedule(this.cfg.boundary.inletTemp, tNew));
    if (this.solver.vaporClamps > vc && this.warnings.length < 20) {
      this.warnings.push(`t=${tNew.toFixed(1)} с: давление ниже давления паров — ограничено (разрыв сплошности)`);
    }
    for (let j = 0; j < this.leaks.length; j++) {
      const l = this.leaks[j]!;
      l.rate = this.solver.leakFlows[j]! / rhoAt(l.node);
    }
  }

  /** Продвинуть до момента t (не дальше). */
  advanceTo(t: number): void {
    while (this.solver.t + this.solver.dt <= t + 1e-9) this.step();
  }

  /** Площадь отверстия, дающая долю frac от текущего расхода на входе при текущем давлении в точке x. */
  leakAreaForFraction(x: number, frac: number, cd = 0.62): number {
    const node = this.model.nodeAt(x, true);
    const qIn = this.solver.nodeQ(0);
    const rho = this.solver.rhoSeg[Math.min(node, this.model.N - 1)]!;
    const dp = Math.max(this.solver.p[node]! - this.cfg.ambientPressure, 1e3);
    return (frac * Math.abs(qIn)) / (cd * Math.sqrt((2 * dp) / rho));
  }

  injectLeak(e: LeakEvent): void {
    const node = this.model.nodeAt(e.x, true);
    this.leaks.push({ event: { ...e, x: node * this.model.dx }, node, rate: 0, baseInletFlow: this.solver.nodeQ(0) });
  }

  /** Убрать утечку (для интерфейса «сбросить утечку»). */
  removeLeak(id: string): void {
    const i = this.leaks.findIndex((l) => l.event.id === id);
    if (i >= 0) this.leaks.splice(i, 1);
  }

  applyControl(a: ControlAction): void {
    const t = this.solver.t;
    if (a.type === 'pump') {
      this.head.set(t, this.head.target * (1 + a.changePct / 100), a.rampSec ?? 0);
    } else if (a.type === 'valve') {
      const o = this.cfg.boundary.outlet;
      if (o.type !== 'valve') {
        this.warnings.push('valve: на выходе нет задвижки — воздействие проигнорировано');
        return;
      }
      if (!this.valve) this.valve = new Ramp(evalSchedule(o.opening, t));
      this.valve.set(t, Math.min(1, Math.max(0, a.opening)), a.rampSec ?? 0);
    }
  }

  /** Истинное значение в точке датчика. */
  valueAt(kind: 'p' | 'q' | 'T', x: number): number {
    const s = this.solver;
    if (kind === 'p') return interp(x, this.model.x, s.p);
    if (kind === 'T') return interp(x, this.model.x, s.T);
    return s.nodeQ(this.model.nodeAt(x));
  }

  profile(): PipeProfile {
    const s = this.solver;
    const q = new Float64Array(this.model.N + 1);
    for (let i = 0; i <= this.model.N; i++) q[i] = s.nodeQ(i);
    return { t: s.t, x: this.model.x, p: Float64Array.from(s.p), q, T: Float64Array.from(s.T) };
  }
}
