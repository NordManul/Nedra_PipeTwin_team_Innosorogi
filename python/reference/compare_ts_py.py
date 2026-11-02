"""
Сверка TS-ядра с эталоном на SciPy (T-A19): стационарные профили на 5 конфигах.
    python3 python/reference/compare_ts_py.py
Расхождение давления — относительно перепада по трубе, температуры — в К.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from pipetwin_ref import steady_profile  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def ts_profiles() -> list[dict]:
    out = subprocess.run(["npx", "tsx", "scripts/export-steady.ts"], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def compare() -> list[dict]:
    rows = []
    for case in ts_profiles():
        x = np.array(case["x"])
        _, P, T = steady_profile(case["config"], case["pIn"], case["mIn"], case["Tin"], x)
        p_ts, t_ts = np.array(case["p"]), np.array(case["T"])
        drop = max(abs(P[0] - P[-1]), 1e3)
        rows.append({
            "name": case["name"],
            "p_err_rel": float(np.max(np.abs(p_ts - P)) / drop),
            "T_err_K": float(np.max(np.abs(t_ts - T))),
        })
    return rows


if __name__ == "__main__":
    for r in compare():
        print(f"{r['name']:<14} давление: {r['p_err_rel'] * 100:.4f}% перепада   температура: {r['T_err_K']:.4f} K")
