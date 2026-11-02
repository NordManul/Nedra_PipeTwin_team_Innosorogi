# @pipetwin/io — импорт чужих файлов

Один код разбора для браузера (мастер в интерфейсе, отдельный воркер) и Node (CLI, стенд). ТЗ, WP-C1…C3.

```bash
npm run import -- data/scada.csv --mapping example-scada --out results/frames.csv
npm run import -- data/unknown.xlsx --config configs/pipeline.default.json      # черновик профиля + вопросы
```

## Что определяется само

- кодировка (UTF-8 / cp1251), разделитель (`,` `;` TAB пробел), десятичная запятая, кавычки;
- строка заголовка под служебными строками, строка единиц под заголовком, лист Excel с данными, объединённые ячейки;
- время: ISO (с поясом и без), `dd.mm.yyyy HH:MM:SS(.fff)`, дата и время в разных колонках, unix с/мс, дата Excel, секунды; пояс — IANA (`Europe/Moscow`);
- род величины по имени (рус/англ, тэги КИП PT/PI, FT/FI, TT/TI), единица из заголовка (`P_вх, МПа`, `[bar]`, `(°C)`) или по величине (неоднозначное — вопросом), положение из имени (`км 12,5`, `KP12`, `вход`/`out`).

## API

| Функция | Что |
| --- | --- |
| `importFile(bytes, name, { profile? })` | Файл → `NormalizedTable` + угаданные колонки |
| `draftMapping(name, guesses, timeColumns, cfg?)` | Черновик `MappingProfile` и вопросы; с конфигом — привязка к датчикам по роду и месту |
| `applyMapping(table, profile, ctx)` | Таблица → кадры `SensorFrame` в СИ (избыточное давление → абсолютное) |
| `framesFromFile(...)` | Всё вместе |
| `ReplaySource` | Запись как `DataSource` (перемотка, разметка утечек) |
| `writeFramesCsv` / `readFramesCsv` | Нормализованный CSV кадров ([contracts.md, п. 5](../../docs/contracts.md#5-sensorframe--показания-датчиков)) |
| `parsePassportText` / `parsePassportRows` | Паспорт трубы → `PipelineConfigInput` («530×8 мм» → D и стенка) |

## Тесты

`test/import.test.ts` — T-C01…T-C09 на образцах `fixtures/import/` (генератор `scripts/make-import-fixtures.ts`).
