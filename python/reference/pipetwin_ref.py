"""
Эталонная физика PipeTwin на SciPy (WP-A10): тот же API, что у TS-ядра.

    friction(Re, rel_rough, model)          — λ (Коулбрук через brentq, явные формулы)
    steady_profile(cfg, p_in, m_in, T_in)   — стационарный профиль (solve_ivp, непрерывная ОДУ)
    steady_from_pressures(cfg, p_in, p_out, T_in) — расход стрельбой (brentq)
    calibrate(cfg, observations, unknowns)  — подбор параметров (least_squares)

Конфиг — разрешённый PipelineConfig в СИ (его выдаёт resolveConfig; scripts/export-steady.ts).
Все величины в СИ, давление абсолютное.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy.integrate import solve_ivp
from scipy.optimize import brentq, least_squares

G = 9.80665
RE_LAM, RE_TURB = 2300.0, 4000.0


def colebrook(Re: float, rr: float) -> float:
    f = lambda x: x + 2 * math.log10(rr / 3.7 + 2.51 * x / Re)  # x = 1/sqrt(λ)
    x = brentq(f, 1.0, 50.0, xtol=1e-14)
    return 1 / (x * x)


def swamee_jain(Re: float, rr: float) -> float:
    return 0.25 / math.log10(rr / 3.7 + 5.74 / Re**0.9) ** 2


def haaland(Re: float, rr: float) -> float:
    return 1 / (-1.8 * math.log10((rr / 3.7) ** 1.11 + 6.9 / Re)) ** 2


TURB = {"colebrook": colebrook, "swamee-jain": swamee_jain, "haaland": haaland}


def friction(Re: float, rr: float, model: str = "colebrook") -> float:
    if Re <= 0:
        return 0.0
    if Re <= RE_LAM:
        return 64 / Re
    if Re >= RE_TURB:
        return TURB[model](Re, rr)
    s = (Re - RE_LAM) / (RE_TURB - RE_LAM)
    w = s * s * (3 - 2 * s)
    return (1 - w) * 64 / Re + w * TURB[model](Re, rr)


@dataclass
class Fluid:
    cfg: dict

    def rho(self, T: float) -> float:
        d = self.cfg["density"]
        return d["rho"] if d["model"] == "constant" else d["rho20"] - d["xi"] * (T - 293.15)

    def nu(self, T: float) -> float:
        v = self.cfg["viscosity"]
        if v["model"] == "constant":
            return v["nu"]
        if v["model"] == "filonov-reynolds":
            return v["nu0"] * math.exp(-v["u"] * (T - v["T0"]))
        (T1, n1), (T2, n2) = v["points"]
        w = lambda n: math.log10(math.log10(n * 1e6 + 0.7))
        B = (w(n1) - w(n2)) / (math.log10(T2) - math.log10(T1))
        A = w(n1) + B * math.log10(T1)
        return (10 ** (10 ** (A - B * math.log10(T))) - 0.7) * 1e-6


def _elev(cfg: dict):
    pts = np.array(cfg["geometry"]["elevation"], dtype=float)
    xs, zs = pts[:, 0], pts[:, 1]
    slope = lambda x: float(np.interp(x, (xs[:-1] + xs[1:]) / 2, np.diff(zs) / np.diff(xs))) if len(xs) > 1 else 0.0

    def dzdx(x: float) -> float:
        if len(xs) < 2:
            return 0.0
        i = int(np.clip(np.searchsorted(xs, x, side="right") - 1, 0, len(xs) - 2))
        return (zs[i + 1] - zs[i]) / (xs[i + 1] - xs[i])

    return dzdx


def steady_profile(cfg: dict, p_in: float, m_in: float, T_in: float, x_eval: np.ndarray | None = None):
    """Непрерывная ОДУ: dp/dx = −λρv|v|/(2D) − ρg dz/dx, dT/dx = −kπD(T − T_env)/(m·cp)."""
    g, fl = cfg["geometry"], Fluid(cfg["fluid"])
    D, L, eps = g["diameter"], g["length"], g["roughness"]
    A = math.pi * D * D / 4
    k, Tenv = cfg["thermal"]["heatTransferCoef"], cfg["thermal"]["ambientTemp"]
    cp = cfg["fluid"]["heatCapacity"]
    model = cfg["numerics"]["frictionModel"]
    thermal = cfg["numerics"]["thermalMode"] != "none"
    dzdx = _elev(cfg)

    def rhs(x, y):
        p, T = y
        rho, nu = fl.rho(T), fl.nu(T)
        v = m_in / (rho * A)
        Re = abs(v) * D / nu
        lam = friction(Re, eps / D, model)
        dp = -lam * rho * v * abs(v) / (2 * D) - rho * G * dzdx(x)
        dT = -k * math.pi * D * (T - Tenv) / (m_in * cp) if thermal and m_in > 0 else 0.0
        return [dp, dT]

    # интегрируем по участкам профиля высот, чтобы не перескакивать изломы
    knots = sorted({0.0, L, *[float(p[0]) for p in g["elevation"] if 0 < p[0] < L]})
    xs = np.asarray(x_eval, dtype=float) if x_eval is not None else np.linspace(0, L, 501)
    P, TT = np.empty_like(xs), np.empty_like(xs)
    y = [p_in, T_in]
    for a, b in zip(knots[:-1], knots[1:]):
        sel = (xs >= a) & (xs <= b)
        sol = solve_ivp(rhs, (a, b), y, method="RK45", rtol=1e-10, atol=[1e-3, 1e-8], dense_output=True)
        if sel.any():
            vals = sol.sol(xs[sel])
            P[sel], TT[sel] = vals[0], vals[1]
        y = sol.y[:, -1]
    return xs, P, TT


def steady_from_pressures(cfg: dict, p_in: float, p_out: float, T_in: float) -> float:
    """Массовый расход, при котором давление на выходе равно p_out."""
    L = cfg["geometry"]["length"]
    f = lambda m: steady_profile(cfg, p_in, m, T_in, np.array([L]))[1][-1] - p_out
    return brentq(f, 1e-3, 1e5, xtol=1e-9)


def calibrate(cfg: dict, observations: list[dict], unknowns: list[str]) -> dict:
    """
    Подбор неизвестных (geometry.roughness, thermal.heatTransferCoef) по стационарным наблюдениям
    [{p_in, m_in, T_in, p_out, T_out}] методом наименьших квадратов (в логарифме параметров).
    """
    import copy

    def setp(c, path, v):
        a, b = path.split(".")
        c[a][b] = v

    def resid(th):
        c = copy.deepcopy(cfg)
        for path, t in zip(unknowns, th):
            setp(c, path, math.exp(t))
        r = []
        L = c["geometry"]["length"]
        for o in observations:
            _, P, T = steady_profile(c, o["p_in"], o["m_in"], o["T_in"], np.array([L]))
            r.append((P[-1] - o["p_out"]) / 1e4)
            if "T_out" in o:
                r.append((T[-1] - o["T_out"]) / 0.1)
        return r

    x0 = [math.log(cfg[p.split(".")[0]][p.split(".")[1]]) for p in unknowns]
    sol = least_squares(resid, x0, x_scale=1.0, diff_step=1e-3)
    return {p: math.exp(t) for p, t in zip(unknowns, sol.x)}
