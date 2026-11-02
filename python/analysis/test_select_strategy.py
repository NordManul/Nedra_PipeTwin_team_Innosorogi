"""T-B11, T-B12: селектор на подставных runs.csv с известным ответом."""
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import select_strategy as ss  # noqa: E402

SEL = json.loads((ss.ROOT / "configs/selection.json").read_text(encoding="utf-8"))
SEL["bootstrap"]["samples"] = 200


def fake_runs(spec: dict[str, dict]) -> pd.DataFrame:
    """spec: стратегия → {ttd, fa}: одинаковая сетка сценариев, детекция за ttd секунд."""
    rows = []
    for sid, p in spec.items():
        for k in range(40):
            size = [0.01, 0.02, 0.05, 0.1][k % 4]
            ttd = p["ttd"] * (1 + 0.05 * ((k * 7) % 5)) / (size * 20)
            rows.append(dict(scenario_id=f"e3-{k}", strategy_id=sid, seed=k, leak_present=1, leak_x=1000.0, leak_frac=size, t_leak=65.0,
                             t_alarm=65 + ttd, ttd=ttd, false_alarms=0, loc_est=1000.0, loc_err=p.get("loc", 100.0), rate_est=None, rate_err=None,
                             v_loss=1.0, cpu_ms_per_tick=0.2, split="test", noleak_s=5.0, ttd_min_phys=1.0))
        for k in range(5):
            rows.append(dict(scenario_id=f"e5-r{k}-noleak", strategy_id=sid, seed=k, leak_present=0, leak_x=None, leak_frac=None, t_leak=None,
                             t_alarm=None, ttd=None, false_alarms=p.get("fa", 0), loc_est=None, loc_err=None, rate_est=None, rate_err=None,
                             v_loss=None, cpu_ms_per_tick=0.2, split="test", noleak_s=36000.0, ttd_min_phys=None))
    return pd.DataFrame(rows)


def test_T_B11_known_best() -> None:
    df = fake_runs({"cusum:h=10": {"ttd": 1.0}, "threshold:k=4": {"ttd": 3.0}, "ewma:L=5": {"ttd": 6.0}})
    ms = ss.evaluate(df, SEL)
    chosen, _, why = ss.choose(df, ms, SEL)
    assert chosen.strategy_id == "cusum:h=10", why


def test_T_B12_tie_prefers_simpler() -> None:
    # одинаковые метрики → интервал разницы включает ноль → более простая (threshold проще cusum)
    df = fake_runs({"cusum:h=10": {"ttd": 2.0}, "threshold:k=4": {"ttd": 2.0}})
    ms = ss.evaluate(df, SEL)
    chosen, _, why = ss.choose(df, ms, SEL)
    assert chosen.strategy_id == "threshold:k=4", why
    assert "простая" in why


def test_hard_filter_regime_false_alarms() -> None:
    df = fake_runs({"cusum:h=10": {"ttd": 1.0, "fa": 1}, "threshold:k=4": {"ttd": 3.0}})
    ms = ss.evaluate(df, SEL)
    bad = next(m for m in ms if m.strategy_id == "cusum:h=10")
    assert not bad.passed and any("режима" in r for r in bad.reasons)
    chosen, _, _ = ss.choose(df, ms, SEL)
    assert chosen.strategy_id == "threshold:k=4"
