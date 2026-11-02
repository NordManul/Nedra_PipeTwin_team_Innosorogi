# schemas/

JSON Schema (draft 2020-12) для файлов на диске. Общий источник для валидации в TypeScript (zod) и Python (pydantic) и для подсказок редактора через поле `$schema` в самих файлах.

| Схема | Файлы | Тип в `contracts.ts` |
| --- | --- | --- |
| `pipeline.schema.json` | `configs/pipeline.*.json` | `PipelineConfigInput` |
| `scenario.schema.json` | `configs/scenarios/*.json` | `Scenario` |
| `strategy.schema.json` | `configs/strategy.selected.json` | `SelectedStrategyFile` |
| `selection.schema.json` | `configs/selection.json` | `SelectionFile` |
| `actions.schema.json` | `configs/actions.json` | `ActionsFile` |
| `mapping.schema.json` | `configs/mappings/*.json` | `MappingProfile` |
| `leak-labels.schema.json` | файлы разметки утечек к записям | `LeakLabelsFile` |

Схема описывает **форму** файла. Смысловые проверки (x датчика в пределах длины трубы, точки профиля по возрастанию, известная единица в строке) делает загрузчик и сообщает поле и причину.

Тип в `contracts.ts` и схема меняются в одном коммите с префиксом `contracts:`.
