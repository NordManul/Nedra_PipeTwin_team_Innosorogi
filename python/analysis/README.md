# python/analysis — анализ и выбор стратегии (B)

- `select_strategy.py` — читает `results/runs.csv` и `configs/selection.json`, делает калибровку порогов, жёсткие фильтры, счёт, бутстрэп (ТЗ, раздел 14) и пишет `configs/strategy.selected.json` и `results/leaderboard.md`.
- Ноутбуки с графиками «TTD от размера утечки», «TTD против FAR» → `results/report.html`.

Форматы входа и выхода — [docs/contracts.md, пп. 10, 12, 14](../../docs/contracts.md).
