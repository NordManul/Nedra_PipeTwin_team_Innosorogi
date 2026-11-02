# @pipetwin/detect — детекция утечки

**Владелец:** B. Подробно — ТЗ, раздел 11.

Детекторы, не зависящие от единиц, частоты опроса и конкретной трубы: все параметры — в долях σ и секундах.

## Контракты

- Реализует: `Detector`, `DetectorOutput`, `DetectorRequirements` ([contracts.md, п. 9](../../docs/contracts.md#9-detector--детектор-утечки)), `EventCard` (п. 13).
- Получает: `DetectorContext`, `SensorFrame`, `TwinPrediction`.
- Читает: `configs/strategy.selected.json`, `configs/actions.json`.

**Граница честности:** пакет не импортирует `@pipetwin/core` plant и не использует `LeakEvent`, `GroundTruth`, `ControlAction`.

## Модули (план)

| Модуль | WP | Что |
| --- | --- | --- |
| `src/preprocess/` | B1 | Пересэмплирование, пропуски, фильтр Хампеля, оценка σ, z = r/σ, здоровье датчиков |
| `src/detectors/` | B2 | D1 `threshold` … D9 `pca`, реестр по имени |
| `src/signature.ts` | B3 | Классификатор событий: утечка, насос, задвижка, отказ датчика |
| `src/localize/` | B4, B5 | L1 `hgl`, L2 `lsq`, L3 `wave-timing`; оценка расхода утечки |
| `src/autotune.ts` | B9 | Порог по данным без утечки под целевой FAR |
| `src/explain.ts` | B10 | Вклад датчиков, уверенность, потери, рекомендация → `EventCard` |
