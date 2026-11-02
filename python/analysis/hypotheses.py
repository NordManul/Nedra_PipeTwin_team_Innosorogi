"""
Цифры для гипотез по детекции (results/detection/README.md) из результатов стенда.

    python3 python/analysis/hypotheses.py [--runs results/runs.csv]

Печатает таблицы в Markdown: TTD по размерам утечки для каждого детектора, ложные тревоги на
режимных событиях (E5), FAR на случайных трубах, ошибка места, сравнение с физическим минимумом.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]


def name(sid: str) -> str:
    return sid.split(":")[0]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", default=str(ROOT / "results/runs.csv"))
    a = ap.parse_args()
    df = pd.read_csv(a.runs)
    df["det"] = df.strategy_id.map(name)
    df["suite"] = df.scenario_id.str.split("-").str[0]
    leaks = df[df.leak_present == 1]

    print("### Медиана TTD, с, и доля пойманных (E3) по размеру утечки\n")
    e3 = leaks[leaks.suite == "e3"]
    if len(e3):
        t = e3.groupby(["det", "leak_frac"]).apply(lambda g: f"{g.ttd.median():.1f} ({g.t_alarm.notna().mean():.0%})", include_groups=False).unstack()
        t.columns = [f"{c * 100:g}%" for c in t.columns]
        print(t.to_markdown())

    print("\n### Ложные тревоги на режимных событиях без утечки (E5) и TTD утечки 5% на фоне события\n")
    e5 = df[df.suite == "e5"]
    if len(e5):
        r = e5.groupby("det").apply(lambda g: pd.Series({
            "ложных на режиме": int(g[g.leak_present == 0].false_alarms.sum()),
            "поймано на фоне режима": f"{g[g.leak_present == 1].t_alarm.notna().mean():.0%}",
            "TTD мед, с": round(g[g.leak_present == 1].ttd.median(), 1),
        }), include_groups=False)
        print(r.to_markdown())

    print("\n### Случайные трубы: FAR и доля пойманных\n")
    rnd = df[df.suite == "rnd"]
    if len(rnd):
        r = rnd.groupby("det").apply(lambda g: pd.Series({
            "ложных в сутки": round(g.false_alarms.sum() / max(g.noleak_s.fillna(0).sum(), 1) * 86400, 2),
            "поймано": f"{g[g.leak_present == 1].t_alarm.notna().mean():.0%}",
            "TTD мед, с": round(g[g.leak_present == 1].ttd.median(), 1),
        }), include_groups=False)
        print(r.to_markdown())

    print("\n### Длинные прогоны без утечки: FAR\n")
    nl = df[df.suite == "noleak"]
    if len(nl):
        r = nl.groupby("det").apply(lambda g: pd.Series({
            "часов": round(g.noleak_s.sum() / 3600, 1),
            "ложных": int(g.false_alarms.sum()),
            "в сутки": round(g.false_alarms.sum() / max(g.noleak_s.sum(), 1) * 86400, 2),
        }), include_groups=False)
        print(r.to_markdown())

    print("\n### Место и физический предел (E3, пойманные)\n")
    det = e3[e3.t_alarm.notna()]
    if len(det):
        r = det.groupby("det").apply(lambda g: pd.Series({
            "ошибка места мед, м": round(g.loc_err.median(), 0),
            "% длины": round(g.loc_err.median() / 50000 * 100, 2),
            "TTD − физ. минимум, мед, с": round((g.ttd - g.ttd_min_phys).median(), 1),
            "быстрее предела": int((g.ttd < g.ttd_min_phys - 0.2).sum()),
        }), include_groups=False)
        print(r.to_markdown())


if __name__ == "__main__":
    main()
