"""
Автоматический выбор стратегии (ТЗ, раздел 14).

    python3 python/analysis/select_strategy.py [--runs results/runs.csv] [--quick-report]

1. Пороги уже откалиброваны стендом на валидационных seed (results/strategies.tuned.json).
2. Берутся прогоны тестовых seed (split = test).
3. Жёсткие фильтры: FAR, POD для крупных утечек, ноль ложных тревог на режимных событиях E5, CPU.
4. Счёт S = Σ w·N(метрика) по оставшимся, метрики нормированы min–max (меньше — лучше).
5. Бутстрэп по сценариям: 95% интервал разницы счёта первого и второго места.
6. Интервал включает ноль → более простая стратегия (порядок простоты из selection.json).
7. Разные победители на малых и крупных утечках → кандидат слияния D7 (results/fusion.candidate.json).
8. Запись configs/strategy.selected.json, results/leaderboard.md, results/report.html.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
METRICS = ["ttd_med", "ttd_p95", "mdl", "loc_med", "far"]


def base_name(strategy_id: str) -> str:
    """«cusum:k=…@hgl» → «cusum», «fusion[cusum+npw]:…» → «fusion»."""
    return strategy_id.split(":")[0].split("[")[0]


@dataclass
class Metrics:
    strategy_id: str
    ttd_med: float
    ttd_p95: float
    mdl: float  # доля расхода
    far: float  # ложных тревог в сутки
    loc_med: float
    pod_large: float
    regime_fa: int
    cpu: float
    pod: dict = field(default_factory=dict)
    passed: bool = True
    reasons: list = field(default_factory=list)
    score: float = math.nan


def load_runs(path: Path, split: str | None) -> pd.DataFrame:
    df = pd.read_csv(path)
    if split and "split" in df and df["split"].notna().any():
        df = df[df["split"] == split]
    return df.reset_index(drop=True)


def metrics_for(g: pd.DataFrame, sel: dict) -> Metrics:
    leaks = g[g.leak_present == 1]
    detected = leaks[leaks.t_alarm.notna()]
    big = detected[detected.leak_frac >= sel["ttdMinLeakFraction"]]
    ttd_med = float(big.ttd.median()) if len(big) else math.inf
    ttd_p95 = float(big.ttd.quantile(0.95)) if len(big) else math.inf
    pod = {float(s): float(grp.t_alarm.notna().mean()) for s, grp in leaks.groupby("leak_frac")}
    sizes = sorted(pod)
    mdl = next((s for s in sizes if all(pod[x] >= sel["mdlPod"] for x in sizes if x >= s)), math.inf)
    obs = g.noleak_s.fillna(0).sum()
    far = float(g.false_alarms.sum() / obs * 86400) if obs > 0 else math.nan
    lp = leaks[leaks.leak_frac >= sel["filters"]["podLeakFraction"]]
    pod_large = float(lp.t_alarm.notna().mean()) if len(lp) else math.nan
    regime = g[g.scenario_id.str.startswith("e5-") & (g.leak_present == 0)]
    locs = detected.loc_err.dropna()
    return Metrics(
        strategy_id=str(g.strategy_id.iloc[0]),
        ttd_med=ttd_med,
        ttd_p95=ttd_p95,
        mdl=mdl,
        far=far,
        loc_med=float(locs.median()) if len(locs) else math.inf,
        pod_large=pod_large,
        regime_fa=int(regime.false_alarms.sum()),
        cpu=float(g.cpu_ms_per_tick.mean()),
        pod=pod,
    )


def apply_filters(ms: list[Metrics], sel: dict) -> None:
    f = sel["filters"]
    for m in ms:
        if not (m.far <= f["farPerDayMax"]):
            m.reasons.append(f"FAR {m.far:.2f}/сут > {f['farPerDayMax']}")
        if not (m.pod_large >= f["podMin"]):
            m.reasons.append(f"POD {m.pod_large:.2f} < {f['podMin']} для утечек от {f['podLeakFraction'] * 100:.0f}%")
        if m.regime_fa > f["regimeFalseAlarmsMax"]:
            m.reasons.append(f"ложных тревог на смене режима: {m.regime_fa}")
        if m.cpu > f["cpuMsPerTickMax"]:
            m.reasons.append(f"CPU {m.cpu:.2f} мс > {f['cpuMsPerTickMax']}")
        m.passed = not m.reasons


def normalize(values: list[float]) -> list[float]:
    finite = [v for v in values if math.isfinite(v)]
    if not finite:
        return [1.0 for _ in values]
    cap = max(finite) * 2 if max(finite) > 0 else 1.0
    vs = [v if math.isfinite(v) else cap for v in values]
    lo, hi = min(vs), max(vs)
    return [0.0 if hi == lo else (v - lo) / (hi - lo) for v in vs]


def score(ms: list[Metrics], sel: dict) -> None:
    w = sel["weights"]
    cols = {
        "ttd_med": [m.ttd_med for m in ms],
        "ttd_p95": [m.ttd_p95 for m in ms],
        "mdl": [m.mdl for m in ms],
        "loc_med": [m.loc_med for m in ms],
        "far": [m.far for m in ms],
    }
    norm = {k: normalize(v) for k, v in cols.items()}
    for i, m in enumerate(ms):
        m.score = sum(w[k] * norm[k][i] for k in METRICS)


def evaluate(df: pd.DataFrame, sel: dict) -> list[Metrics]:
    ms = [metrics_for(g, sel) for _, g in df.groupby("strategy_id", sort=True)]
    apply_filters(ms, sel)
    passed = [m for m in ms if m.passed]
    score(passed, sel)
    return sorted(ms, key=lambda m: (not m.passed, m.score if math.isfinite(m.score) else math.inf))


def bootstrap_diff(df: pd.DataFrame, sel: dict, a: str, b: str, samples: int, conf: float, seed: int = 1) -> tuple[float, float]:
    """95% интервал разницы счёта S(a) − S(b) при пересэмплировании сценариев."""
    sub = df[df.strategy_id.isin([a, b])]
    scen = sub.scenario_id.unique()
    groups = {s: g for s, g in sub.groupby("scenario_id")}
    rng = np.random.default_rng(seed)
    diffs = []
    for _ in range(samples):
        pick = rng.choice(scen, size=len(scen), replace=True)
        boot = pd.concat([groups[s] for s in pick], ignore_index=True)
        ms = [metrics_for(g, sel) for _, g in boot.groupby("strategy_id")]
        if len(ms) < 2:
            continue
        score(ms, sel)
        sc = {m.strategy_id: m.score for m in ms}
        diffs.append(sc[a] - sc[b])
    if not diffs:
        return (-math.inf, math.inf)
    lo, hi = np.quantile(diffs, [(1 - conf) / 2, 1 - (1 - conf) / 2])
    return float(lo), float(hi)


def choose(df: pd.DataFrame, ms: list[Metrics], sel: dict) -> tuple[Metrics | None, Metrics | None, str]:
    ranked = [m for m in ms if m.passed]
    if not ranked:
        return None, None, "ни одна стратегия не прошла жёсткие фильтры"
    if len(ranked) == 1:
        return ranked[0], None, "единственная прошедшая фильтры"
    first, second = ranked[0], ranked[1]
    bs = sel["bootstrap"]
    lo, hi = bootstrap_diff(df, sel, first.strategy_id, second.strategy_id, bs["samples"], bs["confidence"])
    order = sel["simplicityOrder"]
    rank = lambda m: order.index(base_name(m.strategy_id)) if base_name(m.strategy_id) in order else len(order)
    if lo <= 0 <= hi:
        simpler = min((first, second), key=rank)
        other = second if simpler is first else first
        return simpler, other, f"отрыв незначим (95% интервал разницы счёта [{lo:.3f}; {hi:.3f}]) — выбрана более простая"
    return first, second, f"отрыв значим (95% интервал [{lo:.3f}; {hi:.3f}])"


def fusion_candidate(df: pd.DataFrame, ms: list[Metrics], sel: dict) -> dict | None:
    """Шаг 7: если на малых и крупных утечках лидируют разные стратегии — кандидат слияния."""
    ok = {m.strategy_id for m in ms if m.passed and base_name(m.strategy_id) != "fusion"}
    leaks = df[(df.leak_present == 1) & df.strategy_id.isin(ok)]
    if leaks.empty:
        return None
    def leader(part: pd.DataFrame) -> str | None:
        if part.empty:
            return None
        med = part.groupby("strategy_id").ttd.median().fillna(math.inf)
        return str(med.idxmin())
    small = leader(leaks[leaks.leak_frac < 0.02])
    large = leader(leaks[leaks.leak_frac >= 0.05])
    if small and large and small != large:
        return {"members": [small, large], "note": "разные победители на малых и крупных утечках — проверьте слияние D7: npm run bench -- --strategies results/fusion.candidate.json"}
    return None


def spec_for(strategy_id: str, tuned: dict) -> dict:
    for s in tuned.get("strategies", []):
        if s["id"] == strategy_id:
            return s["spec"]
    name, _, rest = strategy_id.partition(":")
    rest, _, loc = rest.partition("@")
    params = {k: float(v) for k, v in (p.split("=") for p in rest.split(";") if "=" in p)}
    default_loc = "wave-timing" if base_name(name) == "npw" else "lsq"
    return {"strategy": base_name(name), "params": params, "localization": loc or default_loc, "signatureFilter": True, "warmupSec": 60}


def fmt(v: float, d: int = 1, scale: float = 1.0) -> str:
    return f"{v * scale:.{d}f}" if isinstance(v, (int, float)) and math.isfinite(v) else "—"


def leaderboard_md(ms: list[Metrics], chosen: Metrics | None, why: str, fusion: dict | None, sel: dict, runs: Path) -> str:
    lines = [
        "# Лидерборд стратегий",
        "",
        f"Сформирован `select_strategy.py` {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} по `{runs.relative_to(ROOT) if runs.is_relative_to(ROOT) else runs}`.",
        f"Веса счёта: {', '.join(f'{k} {v}' for k, v in sel['weights'].items())}. Меньше — лучше.",
        "",
        "| # | Стратегия | Счёт S | TTD мед, с | TTD p95, с | MDL, % | FAR, 1/сут | LOC мед, м | POD ≥5% | Ложные на режиме | CPU, мс | Фильтры |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for i, m in enumerate(ms, 1):
        lines.append(
            f"| {i} | `{m.strategy_id}` | {fmt(m.score, 3)} | {fmt(m.ttd_med)} | {fmt(m.ttd_p95)} | {fmt(m.mdl, 1, 100)} | {fmt(m.far, 2)} | {fmt(m.loc_med, 0)} | {fmt(m.pod_large, 2)} | {m.regime_fa} | {fmt(m.cpu, 3)} | {'прошла' if m.passed else '; '.join(m.reasons)} |"
        )
    lines += ["", f"**Выбрана:** `{chosen.strategy_id if chosen else '—'}` — {why}."]
    if fusion:
        lines += ["", f"**Шаг 7:** {fusion['note']} (участники: {', '.join(f'`{x}`' for x in fusion['members'])})."]
    return "\n".join(lines) + "\n"


def report_html(df: pd.DataFrame, ms: list[Metrics]) -> str:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return "<p>matplotlib не установлен — графики не построены.</p>"

    def png(fig) -> str:
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=110, bbox_inches="tight")
        plt.close(fig)
        return base64.b64encode(buf.getvalue()).decode()

    leaks = df[(df.leak_present == 1) & df.t_alarm.notna()]
    fig, ax = plt.subplots(figsize=(7, 4))
    for sid, g in leaks.groupby("strategy_id"):
        med = g.groupby("leak_frac").ttd.median()
        ax.plot(med.index * 100, med.values, marker="o", label=base_name(sid))
    ax.set_xscale("log")
    ax.set_xlabel("размер утечки, % расхода")
    ax.set_ylabel("медиана TTD, с")
    ax.set_title("Время детекции от размера утечки")
    ax.grid(alpha=0.3)
    ax.legend(fontsize=8)
    a = png(fig)
    fig, ax = plt.subplots(figsize=(7, 4))
    for m in ms:
        if math.isfinite(m.ttd_med) and math.isfinite(m.far):
            ax.scatter(max(m.far, 0.01), m.ttd_med, s=40)
            ax.annotate(base_name(m.strategy_id), (max(m.far, 0.01), m.ttd_med), fontsize=8, xytext=(4, 2), textcoords="offset points")
    ax.set_xscale("log")
    ax.set_xlabel("ложных тревог в сутки (0 показан как 0,01)")
    ax.set_ylabel("медиана TTD, с")
    ax.set_title("Время детекции против ложных тревог")
    ax.grid(alpha=0.3)
    b = png(fig)
    return (
        "<!doctype html><meta charset='utf-8'><title>PipeTwin: отчёт стенда</title>"
        "<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px}img{max-width:100%}</style>"
        "<h1>Отчёт стенда PipeTwin</h1>"
        f"<p>Прогонов: {len(df)}, сценариев: {df.scenario_id.nunique()}, стратегий: {df.strategy_id.nunique()}.</p>"
        f"<h2>Время детекции от размера утечки</h2><img src='data:image/png;base64,{a}'>"
        f"<h2>Время детекции против ложных тревог</h2><img src='data:image/png;base64,{b}'>"
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs", default=str(ROOT / "results/runs.csv"))
    ap.add_argument("--selection", default=str(ROOT / "configs/selection.json"))
    ap.add_argument("--tuned", default=str(ROOT / "results/strategies.tuned.json"))
    ap.add_argument("--out", default=str(ROOT / "configs/strategy.selected.json"))
    ap.add_argument("--leaderboard", default=str(ROOT / "results/leaderboard.md"))
    ap.add_argument("--report", default=str(ROOT / "results/report.html"))
    ap.add_argument("--split", default="test")
    ap.add_argument("--no-report", action="store_true")
    a = ap.parse_args(argv)

    runs = Path(a.runs)
    sel = json.loads(Path(a.selection).read_text(encoding="utf-8"))
    tuned = json.loads(Path(a.tuned).read_text(encoding="utf-8")) if Path(a.tuned).exists() else {}
    df = load_runs(runs, a.split)
    if df.empty:
        print("нет прогонов для выбора")
        return 1
    ms = evaluate(df, sel)
    chosen, runner_up, why = choose(df, ms, sel)
    fusion = fusion_candidate(df, ms, sel)
    Path(a.leaderboard).write_text(leaderboard_md(ms, chosen, why, fusion, sel, runs), encoding="utf-8")
    if fusion:
        members = [spec_for(m, tuned) for m in fusion["members"]]
        cand = [{"strategy": "fusion", "params": {"thr": 1, "minVotes": 2}, "members": [{"detector": m["strategy"], "params": m["params"], "weight": 1} for m in members], "fusionRule": "weighted-sum", "localization": "lsq", "signatureFilter": True, "warmupSec": 60}]
        (ROOT / "results/fusion.candidate.json").write_text(json.dumps(cand, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    if not a.no_report:
        Path(a.report).write_text(report_html(df, ms), encoding="utf-8")
    if chosen is None:
        print(f"стратегия не выбрана: {why}")
        return 2
    spec = spec_for(chosen.strategy_id, tuned)
    out = {
        "$schema": "../schemas/strategy.schema.json",
        "schemaVersion": 1,
        **{k: v for k, v in spec.items() if k not in ("$schema", "schemaVersion")},
        "selectedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "evidence": {
            "ttd_med_s": round(chosen.ttd_med, 2) if math.isfinite(chosen.ttd_med) else 9999,
            "ttd_p95_s": round(chosen.ttd_p95, 2) if math.isfinite(chosen.ttd_p95) else 9999,
            "mdl_pct": round(chosen.mdl * 100, 2) if math.isfinite(chosen.mdl) else 100,
            "far_per_day": round(chosen.far, 3) if math.isfinite(chosen.far) else 0,
            "loc_med_m": round(chosen.loc_med, 0) if math.isfinite(chosen.loc_med) else 0,
            "pod_5pct": round(chosen.pod_large, 3) if math.isfinite(chosen.pod_large) else 0,
        },
        "runnerUp": base_name(runner_up.strategy_id) if runner_up else None,
        "runsHash": hashlib.sha1(runs.read_bytes()).hexdigest(),
    }
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"выбрана: {chosen.strategy_id} — {why}")
    print(f"лидерборд: {a.leaderboard}; конфиг: {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
