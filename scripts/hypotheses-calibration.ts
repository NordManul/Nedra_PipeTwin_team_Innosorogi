/**
 * H-A4 на случайных трубах: определяются ли шероховатость ε и коэффициент теплопередачи k
 * по датчикам по умолчанию (давления на концах и по трассе, расходы и температуры на концах).
 *   npx tsx scripts/hypotheses-calibration.ts [число труб]
 */
import { calibrate, resolveConfig, Rng, withParam } from '../packages/core/src';
import { SimulatedSource } from '../packages/core/src/plant';

const n = Number(process.argv[2] ?? 20);
const rng = new Rng(4242);
let both = 0;
let epsOk = 0;
let kOk = 0;
let flagged = 0;
const rows: string[] = [];
for (let i = 0; i < n; i++) {
  const L = Math.round(rng.uniform(10, 150)) * 1000;
  const D = Number(rng.uniform(0.3, 1.0).toFixed(2));
  const eps = 0.05e-3 * rng.uniform(0.5, 3);
  const k = rng.uniform(1, 4);
  const resolved = resolveConfig({ schemaVersion: 1, geometry: { length: L, diameter: D }, fluid: { name: 'light-crude' }, boundary: { inletTemp: '60 °C' } });
  let truth = withParam(resolved.config, 'geometry.roughness', eps);
  truth = withParam(truth, 'thermal.heatTransferCoef', k);
  const frames = new SimulatedSource(truth, { seed: 100 + i, events: [{ t: 40, type: 'pump', changePct: 8, rampSec: 5 }] }).step(150);
  const res = calibrate(frames, resolved, { unknowns: ['geometry.roughness', 'thermal.heatTransferCoef'], window: [0, 150] });
  const e = res.params.find((p) => p.path === 'geometry.roughness')!;
  const kk = res.params.find((p) => p.path === 'thermal.heatTransferCoef')!;
  const eErr = Math.abs(e.value / eps - 1);
  const kErr = Math.abs(kk.value / k - 1);
  const ok = (p: typeof e, err: number) => p.status === 'calibrated' && err < 0.1;
  if (ok(e, eErr)) epsOk++;
  if (ok(kk, kErr)) kOk++;
  if (ok(e, eErr) && ok(kk, kErr)) both++;
  if (res.identifiability.unidentifiable.length) flagged++;
  rows.push(`${String(L / 1000).padStart(4)} км Ø${D.toFixed(2)}: ε ${(eps * 1e3).toFixed(3)}→${(e.value * 1e3).toFixed(3)} мм (${e.status}), k ${k.toFixed(2)}→${kk.value.toFixed(2)} (${kk.status})`);
}
console.log(rows.join('\n'));
console.log(`\nH-A4: ε в пределах 10%: ${epsOk}/${n}; k в пределах 10%: ${kOk}/${n}; оба: ${both}/${n}; помечено «не определяется»: ${flagged}/${n}`);
