# python/analysis — выбор стратегии (ТЗ, раздел 14)

```bash
python3 python/analysis/select_strategy.py [--runs results/runs.csv] [--split test]
```

1. Пороги уже откалиброваны стендом на валидационных seed (`results/strategies.tuned.json`).
2. Берутся прогоны тестовых seed.
3. Жёсткие фильтры: FAR ≤ 2/сут, POD ≥ 90% для утечек от 5%, ноль ложных тревог на режимных событиях E5, CPU ≤ 2 мс.
4. Счёт S = 0,35·N(TTD_мед) + 0,15·N(TTD_p95) + 0,25·N(MDL) + 0,15·N(LOC) + 0,10·N(FAR) — веса и фильтры в `configs/selection.json`.
5. Бутстрэп по сценариям: 95% интервал разницы счёта первого и второго места; включает ноль → более простая стратегия.
6. Разные победители на малых и крупных утечках → кандидат слияния D7 в `results/fusion.candidate.json`.

Выход: `configs/strategy.selected.json` (интерфейс берёт стратегию отсюда), `results/leaderboard.md`, `results/report.html` (графики «TTD от размера утечки», «TTD против FAR»). Тесты — `test_select_strategy.py` (T-B11, T-B12, жёсткий фильтр режима).
