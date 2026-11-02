/** Тесты физики T-A01…T-A14, T-A17, T-A18 (ТЗ, раздел 10.2). */
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config/resolve';
import { ConfigError } from '../src/config/validate';
import { colebrook, frictionFactor, haaland, swameeJain } from '../src/friction';
import { G, PipeModel } from '../src/hydraulics/pipe';
import { steadyForward, steadyFromPressures } from '../src/hydraulics/steady';
import { Rng } from '../src/math/rng';
import { Plant } from '../src/plant/plant';
import { SimulatedSource } from '../src/plant/source';
import { parseQuantity } from '../src/units';
import { constantPropsInput, defaultConfig } from './helpers';

describe('T-A01 парсер единиц', () => {
  it.each([
    ['1,2 МПа', 'pressure', 1.2e6],
    ['60 °C', 'temperature', 333.15],
    ['45 сСт', 'kinViscosity', 4.5e-5],
    ['1200 м3/ч', 'flow', 0.33333333],
    ['12 bar', 'pressure', 1.2e6],
    ['530 мм', 'length', 0.53],
    ['1 200 м³/ч', 'flow', 0.33333333],
    ['8 бар изб', 'pressure', 8e5 + 101325],
    ['2,0 кДж/(кг·К)', 'heatCapacity', 2000],
  ] as const)('%s', (s, dim, expected) => {
    expect(parseQuantity(s, dim).value).toBeCloseTo(expected, 6);
  });

  it('т/ч переводится в м³/с через плотность', () => {
    expect(parseQuantity('850 т/ч', 'flow', { density: 850 }).value).toBeCloseTo(1000 / 3600, 9);
  });

  it('неизвестная единица — понятная ошибка', () => {
    expect(() => parseQuantity('5 попугаев', 'length')).toThrow(/неизвестная единица/);
  });
});

describe('T-A02…A04 трение', () => {
  it('T-A02 ламинарный режим: λ = 64/Re', () => {
    expect(frictionFactor(1000, 1e-4)).toBe(0.064);
  });

  it('T-A03 турбулентный режим: Коулбрук ≈ 0,0185, явные формулы в пределах 2%', () => {
    const lc = colebrook(1e5, 1e-4);
    expect(lc).toBeCloseTo(0.0185, 3);
    expect(Math.abs(swameeJain(1e5, 1e-4) / lc - 1)).toBeLessThan(0.02);
    expect(Math.abs(haaland(1e5, 1e-4) / lc - 1)).toBeLessThan(0.02);
  });

  it('T-A04 нет скачков в переходной зоне', () => {
    let prev = frictionFactor(2000, 1e-4);
    for (let Re = 2010; Re <= 4500; Re += 10) {
      const cur = frictionFactor(Re, 1e-4);
      expect(Math.abs(cur / prev - 1)).toBeLessThan(0.01);
      prev = cur;
    }
  });
});

describe('T-A05…A08 стационарный расчёт', () => {
  const model = new PipeModel(resolveConfig(constantPropsInput()).config);

  it('T-A05 горизонтальная труба: Δp = λ·(L/D)·ρv²/2 с ошибкой < 0,01%', () => {
    const m = 300;
    const s = steadyForward(model, 3e6, m, 293.15);
    const v = m / (1000 * model.A);
    const Re = (v * model.D) / 1e-6;
    const expected = frictionFactor(Re, model.eps / model.D) * (model.L / model.D) * ((1000 * v * v) / 2);
    expect(Math.abs((s.p[0]! - s.p[model.N]!) / expected - 1)).toBeLessThan(1e-4);
  });

  it('T-A06 только рельеф: Δp = ρgΔz при Q = 0', () => {
    const cfg = resolveConfig(constantPropsInput({ geometry: { length: 10000, diameter: 0.5, wallThickness: 0.008, roughness: 5e-5, elevation: [[0, 0], [4000, 80], [10000, 50]] } })).config;
    const md = new PipeModel(cfg);
    const s = steadyForward(md, 3e6, 0, 293.15);
    expect(s.p[0]! - s.p[md.N]!).toBeCloseTo(1000 * G * 50, 6);
  });

  it('T-A07 тепловая модель совпадает с формулой Шухова (< 0,01 K)', () => {
    const cfg = resolveConfig(constantPropsInput({ numerics: { dx: 100, frictionModel: 'colebrook', thermalMode: 'quasi-steady' } })).config;
    const md = new PipeModel(cfg);
    const m = 250;
    const s = steadyForward(md, 3e6, m, 333.15);
    const k = cfg.thermal.heatTransferCoef;
    for (let i = 0; i <= md.N; i += 50) {
      const shukhov = 278.15 + (333.15 - 278.15) * Math.exp((-k * Math.PI * md.D * md.x[i]!) / (m * 4180));
      expect(Math.abs(s.T[i]! - shukhov)).toBeLessThan(0.01);
    }
  });

  it('T-A08 режимы twin согласованы: (p_вх, Q) → p_вых → (p_вх, p_вых) → Q', () => {
    const cfg = defaultConfig();
    const md = new PipeModel(cfg);
    const m = 270;
    const a = steadyForward(md, 4e6, m, 333.15);
    const b = steadyFromPressures(md, 4e6, a.p[md.N]!, 333.15);
    expect(Math.abs(b.mSeg[0]! / m - 1)).toBeLessThan(1e-4);
  });
});

describe('T-A09…A13 нестационарный plant', () => {
  it('T-A09 гидроудар: скачок давления = ρ·a·Δv с ошибкой < 2%', () => {
    const input = constantPropsInput({
      geometry: { length: 2000, diameter: 0.5, wallThickness: 0.008, roughness: 1e-6, elevation: [[0, 0]] },
      boundary: {
        inlet: { type: 'pressure', pressure: 2e6 },
        outlet: { type: 'valve', downstreamPressure: 1.8e6, cv: 0.05, opening: 1 },
        inletTemp: 293.15,
      },
      numerics: { dx: 10, frictionModel: 'colebrook', thermalMode: 'none' },
    });
    const plant = new Plant(resolveConfig(input).config);
    const N = plant.model.N;
    const v0 = plant.solver.nodeQ(N) / plant.model.A;
    const p0 = plant.solver.p[N]!;
    plant.applyControl({ type: 'valve', opening: 0, rampSec: 0 });
    for (let i = 0; i < 5; i++) plant.step();
    const jump = plant.solver.p[N]! - p0;
    expect(Math.abs(jump / (1000 * plant.waveSpeed * v0) - 1)).toBeLessThan(0.02);
  });

  it('T-A10 скорость волны: импульс приходит в x через x/a ± Δt', () => {
    const input = constantPropsInput({
      boundary: {
        inlet: { type: 'pressure', pressure: { points: [[0, 3e6], [1, 3e6], [1.0001, 3.2e6]], interp: 'linear' } },
        outlet: { type: 'pressure', pressure: 1e6 },
        inletTemp: 293.15,
      },
    });
    const plant = new Plant(resolveConfig(input).config);
    const node = plant.model.nodeAt(6000);
    const p0 = plant.solver.p[node]!;
    let arrival = NaN;
    while (plant.t < 20) {
      plant.step();
      if (Number.isNaN(arrival) && plant.solver.p[node]! - p0 > 0.5e5) arrival = plant.t;
    }
    const expected = 1 + plant.model.x[node]! / plant.waveSpeed;
    expect(Math.abs(arrival - expected)).toBeLessThanOrEqual(plant.dt * 1.01);
  });

  it('T-A11 plant без утечки остаётся в стационарном профиле twin (0,1%)', () => {
    const cfg = defaultConfig();
    const plant = new Plant(cfg);
    const start = Float64Array.from(plant.solver.p);
    plant.advanceTo(60);
    for (let i = 0; i <= plant.model.N; i += 25) {
      expect(Math.abs(plant.solver.p[i]! / start[i]! - 1)).toBeLessThan(1e-3);
    }
  });

  it('T-A12 баланс утечки: Q_вх − Q_вых = q_утечки (0,5%)', () => {
    const input = constantPropsInput({ geometry: { length: 5000, diameter: 0.5, wallThickness: 0.008, roughness: 5e-5, elevation: [[0, 0]] } });
    const plant = new Plant(resolveConfig(input).config);
    plant.injectLeak({ id: 'L', x: 2500, area: 2e-4, cd: 0.62, tStart: 0, rampSec: 0 });
    plant.advanceTo(200);
    const qIn = plant.solver.nodeQ(0);
    const qOut = plant.solver.nodeQ(plant.model.N);
    const leak = plant.leaks[0]!.rate;
    expect(leak).toBeGreaterThan(0);
    expect(Math.abs((qIn - qOut) / leak - 1)).toBeLessThan(0.005);
  });

  it('T-A13 сходимость по сетке: разница убывает при измельчении', () => {
    const outlet = (dx: number) => {
      const cfg = defaultConfig();
      cfg.numerics.dx = dx;
      const md = new PipeModel(cfg);
      return steadyFromPressures(md, 4e6, 2.4e6, 333.15).mSeg[0]!;
    };
    const [m400, m200, m100, m50] = [400, 200, 100, 50].map(outlet);
    const e = [m400! - m50!, m200! - m50!, m100! - m50!].map(Math.abs);
    expect(e[1]!).toBeLessThan(e[0]!);
    expect(e[2]!).toBeLessThan(e[1]!);
  });
});

describe('T-A14 воспроизводимость', () => {
  it('один seed дважды — побитово одинаковые кадры', () => {
    const cfg = defaultConfig();
    const run = () => {
      const src = new SimulatedSource(cfg, { seed: 42, events: [{ t: 3, type: 'leak', x: 20000, sizePct: 2, rampSec: 1 }] });
      return JSON.stringify(src.step(8));
    };
    expect(run()).toBe(run());
  });

  it('ГПСЧ детерминирован', () => {
    const a = new Rng(7);
    const b = new Rng(7);
    for (let i = 0; i < 100; i++) expect(a.gauss()).toBe(b.gauss());
  });
});

describe('T-A17 случайные конфиги', () => {
  it('1000 конфигов: L 1–300 км, D 0,1–1,4 м, ν 1–500 сСт — нет NaN и бесконечностей', () => {
    const rng = new Rng(2026);
    for (let k = 0; k < 1000; k++) {
      const L = rng.uniform(1e3, 3e5);
      const D = rng.uniform(0.1, 1.4);
      const nu = rng.uniform(1, 500) * 1e-6;
      const cfg = resolveConfig({
        schemaVersion: 1,
        geometry: { length: L, diameter: D },
        fluid: { name: 'light-crude', viscosity: { model: 'constant', nu } },
      }).config;
      const plant = new Plant(cfg);
      for (let i = 0; i < 5; i++) plant.step();
      for (let i = 0; i <= plant.model.N; i++) {
        if (!Number.isFinite(plant.solver.p[i]!) || !Number.isFinite(plant.solver.mR[i]!)) {
          throw new Error(`NaN: L=${L}, D=${D}, ν=${nu}, узел ${i}`);
        }
      }
    }
  });
});

describe('T-A18 плохой конфиг', () => {
  it('отрицательный диаметр — ошибка называет поле и причину', () => {
    try {
      resolveConfig({ schemaVersion: 1, geometry: { length: 1000, diameter: -0.5 } });
      throw new Error('ожидалась ошибка');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toMatch(/geometry\.diameter.*> 0/);
    }
  });

  it('неизвестная единица — ошибка называет поле', () => {
    expect(() => resolveConfig({ schemaVersion: 1, geometry: { length: '10 вёрст', diameter: 0.5 } })).toThrow(/geometry\.length: неизвестная единица/);
  });

  it('опечатка в имени поля — ошибка схемы', () => {
    expect(() => resolveConfig({ schemaVersion: 1, geometry: { lenght: 1000, diameter: 0.5 } })).toThrow(/неизвестное поле «lenght»/);
  });
});
