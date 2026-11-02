/**
 * Калибровка (WP-A8): подбор неизвестных параметров трубы по окну данных без утечки.
 * Левенберг–Марквардт с численным якобианом; положительные параметры — в логарифме.
 * Невязка — (замер − смещение − прогноз)/σ по всем датчикам, кроме граничных.
 * Отчёт об идентифицируемости: ранг и обусловленность якобиана, неопределяемые параметры остаются default.
 */
import type { CalibrationRequest, CalibrationResult, ParamMeta, PipelineConfig, ResolvedConfig, SensorFrame } from '../contracts';
import { getParam, setParamInPlace } from '../config/paths';
import { gram, inverse, solve, symEig } from '../math/linalg';
import { createTwin } from '../twin';

/** Отбросить начало окна: twin выходит на режим после инициализации. */
const SETTLE_SEC = 5;
/** Шаг прореживания кадров в невязке, с. */
const SAMPLE_SEC = 0.5;
/** Порог неопределённости: σ(ln θ) выше — параметр считается неопределяемым (±50%). */
const MAX_REL_STD = 0.5;

interface Unknown {
  path: string;
  log: boolean;
  lo: number;
  hi: number;
  isBias: boolean;
}

const BOUNDS: Record<string, [number, number]> = {
  'geometry.roughness': [1e-7, 5e-3],
  'thermal.heatTransferCoef': [0.05, 50],
  'geometry.diameter': [0.01, 3],
  'fluid.viscosity.nu': [1e-7, 1e-2],
  'fluid.viscosity.nu0': [1e-7, 1e-2],
  'fluid.viscosity.u': [1e-4, 0.2],
};

function applyBiases(frame: SensorFrame, cfg: PipelineConfig): SensorFrame {
  const values: Record<string, number> = { ...frame.values };
  for (const s of cfg.sensors) if (s.bias && values[s.id] !== undefined) values[s.id]! -= s.bias;
  return { ...frame, values };
}

/** Невязки по окну для данного конфига. */
function residuals(cfg: PipelineConfig, frames: SensorFrame[], window: [number, number]): number[] {
  const twin = createTwin(cfg);
  const r: number[] = [];
  let nextT = window[0] + SETTLE_SEC;
  for (const f of frames) {
    if (f.t < window[0] || f.t > window[1]) continue;
    const corrected = applyBiases(f, cfg);
    const pred = twin.predict(corrected);
    if (f.t < nextT) continue;
    nextT = f.t + SAMPLE_SEC;
    const inputs = new Set(pred.inputs);
    for (const s of cfg.sensors) {
      if (inputs.has(s.id)) continue;
      const m = corrected.values[s.id];
      const p = pred.values[s.id];
      if (!pred.ok || m === undefined || p === undefined || corrected.valid?.[s.id] === false) {
        r.push(0);
        continue;
      }
      r.push((m - p) / Math.max(s.noiseStd, 1e-12));
    }
  }
  return r;
}

const sumSq = (r: number[]) => r.reduce((s, v) => s + v * v, 0);

export function calibrate(frames: SensorFrame[], resolved: ResolvedConfig, req: CalibrationRequest): CalibrationResult {
  const base = structuredClone(resolved.config);
  const unknowns: Unknown[] = req.unknowns.map((path) => {
    const isBias = /^sensors\.[^.]+\.bias$/.test(path);
    const b = req.bounds?.[path] ?? BOUNDS[path];
    const v = getParam(base, path);
    if (v === undefined) throw new Error(`calibrate: нет параметра «${path}»`);
    const log = !isBias && v > 0;
    const sensor = isBias ? base.sensors.find((s) => `sensors.${s.id}.bias` === path) : undefined;
    const lim = sensor ? 50 * sensor.noiseStd : Math.abs(v) * 100 + 1;
    return { path, log, lo: b?.[0] ?? (log ? v / 100 : -lim), hi: b?.[1] ?? (log ? v * 100 : lim), isBias };
  });
  const toTheta = (u: Unknown, v: number) => (u.log ? Math.log(v) : v);
  const fromTheta = (u: Unknown, th: number) => Math.min(u.hi, Math.max(u.lo, u.log ? Math.exp(th) : th));
  const configFor = (theta: number[]) => {
    const c = structuredClone(base);
    unknowns.forEach((u, i) => setParamInPlace(c, u.path, fromTheta(u, theta[i]!)));
    return c;
  };
  const evalR = (theta: number[]) => residuals(configFor(theta), frames, req.window);

  let theta = unknowns.map((u) => toTheta(u, getParam(base, u.path)!));
  let r = evalR(theta);
  let cost = sumSq(r);
  let lambda = 1e-2;
  let iterations = 0;
  let converged = false;
  let J: number[][] = [];
  const n = unknowns.length;

  for (iterations = 0; iterations < 30; iterations++) {
    // численный якобиан
    const cols: number[][] = [];
    for (let i = 0; i < n; i++) {
      const u = unknowns[i]!;
      const h = u.log ? 1e-3 : Math.max(1e-4 * (u.hi - u.lo), 1e-12);
      const th = [...theta];
      th[i]! += h;
      const r2 = evalR(th);
      cols.push(r2.map((v, k) => (v - r[k]!) / h));
    }
    J = r.map((_, k) => cols.map((c) => c[k]!));
    const JTJ = gram(J);
    const g = cols.map((c) => c.reduce((s, v, k) => s + v * r[k]!, 0));
    let improved = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const A = JTJ.map((row, i) => row.map((v, j) => v + (i === j ? lambda * (JTJ[i]![i]! || 1) : 0)));
      const delta = solve(A, g.map((v) => -v));
      if (!delta) {
        lambda *= 10;
        continue;
      }
      const thNew = theta.map((v, i) => toTheta(unknowns[i]!, fromTheta(unknowns[i]!, v + delta[i]!)));
      const rNew = evalR(thNew);
      const cNew = sumSq(rNew);
      if (cNew < cost) {
        const rel = (cost - cNew) / Math.max(cost, 1e-30);
        theta = thNew;
        r = rNew;
        cost = cNew;
        lambda = Math.max(lambda / 3, 1e-9);
        improved = true;
        if (rel < 1e-6 || Math.max(...delta.map(Math.abs)) < 1e-6) converged = true;
        break;
      }
      lambda *= 10;
    }
    if (!improved) {
      converged = true;
      break;
    }
    if (converged) break;
  }

  // идентифицируемость
  const JTJ = gram(J.length ? J : [new Array(n).fill(0)]);
  const eig = symEig(JTJ);
  const maxEv = Math.max(eig.values[0] ?? 0, 1e-300);
  const rank = eig.values.filter((v) => v > maxEv * 1e-8).length;
  const minEv = Math.max(eig.values[n - 1] ?? 0, 1e-300);
  const condition = Math.sqrt(maxEv / minEv);
  const dof = Math.max(1, r.length - n);
  const s2 = cost / dof;
  const cov = inverse(JTJ.map((row, i) => row.map((v, j) => v + (i === j ? 1e-12 * (row[i] || 1) : 0))));
  /** Стандартная ошибка в пространстве θ (для логарифмических параметров — относительная). */
  const thetaStd = unknowns.map((_, i) => (cov ? Math.sqrt(Math.max(cov[i]![i]! * s2, 0)) : Infinity));
  // Параметр не определяется, если его влияние на невязку нулевое или неопределённость
  // сравнима с самим значением: σ(ln θ) > MAX_REL_STD, для смещений — σ > шума датчика.
  const unidentifiable = new Set<string>();
  unknowns.forEach((u, i) => {
    const colNorm = Math.sqrt(JTJ[i]![i]!);
    const sensor = u.isBias ? base.sensors.find((sp) => `sensors.${sp.id}.bias` === u.path) : undefined;
    const tooUncertain = u.log ? thetaStd[i]! > MAX_REL_STD : thetaStd[i]! > (sensor?.noiseStd ?? Infinity);
    if (!(colNorm > 1e-9 * Math.sqrt(maxEv)) || tooUncertain || !Number.isFinite(thetaStd[i]!)) unidentifiable.add(u.path);
  });

  const config = configFor(theta);
  const params: ParamMeta[] = unknowns.map((u, i) => {
    const initial = getParam(base, u.path)!;
    if (unidentifiable.has(u.path)) {
      setParamInPlace(config, u.path, initial);
      return {
        path: u.path,
        value: initial,
        status: 'default' as const,
        source: 'calibration',
        warnings: ['не определяется по имеющимся датчикам — оставлено значение по умолчанию'],
      };
    }
    const value = fromTheta(u, theta[i]!);
    const std = u.log ? value * thetaStd[i]! : thetaStd[i]!;
    return { path: u.path, value, status: 'calibrated' as const, source: `calibration:${new Date().toISOString()}`, std };
  });

  // СКО невязки по датчикам после калибровки
  const finalR = residuals(config, frames, req.window);
  const twinInputs = new Set(createTwin(config).predict(frames.find((f) => f.t >= req.window[0]) ?? frames[0]!).inputs);
  const ids = config.sensors.filter((s) => !twinInputs.has(s.id));
  const residualRms: Record<string, number> = {};
  ids.forEach((s, k) => {
    let acc = 0;
    let cnt = 0;
    for (let j = k; j < finalR.length; j += ids.length) {
      acc += (finalR[j]! * s.noiseStd) ** 2;
      cnt++;
    }
    residualRms[s.id] = cnt ? Math.sqrt(acc / cnt) : NaN;
  });

  return { params, config, identifiability: { rank, condition, unidentifiable: [...unidentifiable] }, residualRms, converged, iterations };
}
