# configs/

Все параметры системы. В коде нет ни одной физической константы трубы: новая труба, новые веса выбора или новые правила рекомендаций подключаются правкой файлов здесь.

| Файл | Контракт | Схема | Кто пишет |
| --- | --- | --- | --- |
| `pipeline.default.json` | `PipelineConfigInput` | [pipeline.schema.json](../schemas/pipeline.schema.json) | A |
| `pipeline.example.json` | `PipelineConfigInput` — пример с единицами и статусами | то же | A, C |
| `scenarios/*.json` | `Scenario` | [scenario.schema.json](../schemas/scenario.schema.json) | B, C (экспорт демо) |
| `mappings/*.json` | `MappingProfile` | [mapping.schema.json](../schemas/mapping.schema.json) | C |
| `actions.json` | `ActionsFile` | [actions.schema.json](../schemas/actions.schema.json) | B |
| `selection.json` | `SelectionFile` | [selection.schema.json](../schemas/selection.schema.json) | B |
| `strategy.selected.json` | `SelectedStrategyFile` | [strategy.schema.json](../schemas/strategy.schema.json) | `select_strategy.py` |

Каждый файл содержит `schemaVersion` и `$schema` — редактор подсвечивает ошибки и подсказывает поля. Описание полей — в [docs/contracts.md](../docs/contracts.md).

Значения в `pipeline.default.json` — наши допущения (ТЗ, разделы 2 и 6), не норматив. `strategy.selected.json` сейчас содержит стратегию по умолчанию (D1, порог 3σ, `selectedAt: null`) — её перезапишет первый выбор на стенде.
