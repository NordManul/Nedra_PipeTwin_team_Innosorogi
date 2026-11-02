# @pipetwin/bench — стенд экспериментов

**Владелец:** B. Подробно — ТЗ, разделы 11, 13, 14.

Тот же код ядра и детекторов, что в браузере, но в Node: тысячи прогонов Монте-Карло за минуты.

## Контракты

- Читает: `Scenario` (`configs/scenarios/*.json`), `PipelineConfig`, `DataSource`, `Detector`.
- Пишет: `results/runs.csv` (`RunRecord`, [contracts.md, п. 12](../../docs/contracts.md#12-результат-прогона--runscsv)), опционально `results/ticks/*.parquet`.

## Модули (план)

| Модуль | WP | Что |
| --- | --- | --- |
| `src/scenarios/` | B6 | Декларативная сетка, случайные трубы, replay, наложение утечки на запись |
| `src/run.ts` | B7 | Параллельный раннер на `worker_threads`, кэш, продолжение, `--quick` |
| `src/metrics.ts` | B8 | TTD, POD, MDL, FAR, LOC, CPU, V_loss |
