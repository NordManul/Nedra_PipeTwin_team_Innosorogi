"""Эталон: аналитические проверки и сверка с TS (T-A19)."""
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from compare_ts_py import compare  # noqa: E402
from pipetwin_ref import friction, steady_profile  # noqa: E402


def test_friction_known_values():
    assert friction(1000, 1e-4) == 0.064
    assert abs(friction(1e5, 1e-4) - 0.0185) < 5e-4


def test_shukhov_constant_props():
    cfg = {
        "geometry": {"length": 10000, "diameter": 0.5, "roughness": 5e-5, "elevation": [[0, 0], [10000, 0]]},
        "fluid": {"density": {"model": "constant", "rho": 1000}, "viscosity": {"model": "constant", "nu": 1e-6}, "heatCapacity": 4180},
        "thermal": {"ambientTemp": 278.15, "heatTransferCoef": 2},
        "numerics": {"frictionModel": "colebrook", "thermalMode": "quasi-steady"},
    }
    x, _, T = steady_profile(cfg, 3e6, 250, 333.15, np.array([10000.0]))
    expected = 278.15 + 55 * math.exp(-2 * math.pi * 0.5 * 10000 / (250 * 4180))
    assert abs(T[-1] - expected) < 1e-6


def test_T_A19_ts_matches_python():
    for r in compare():
        assert r["p_err_rel"] < 1e-3, r
        assert r["T_err_K"] < 0.05, r
