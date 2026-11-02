# @pipetwin/io — импорт чужих файлов

**Владелец:** C. Подробно — ТЗ, раздел 12, WP-C1 и WP-C2.

Один код разбора для браузера (мастер маппинга) и Node (CLI импорта, стенд B).

## Контракты

- Пишет: `NormalizedTable`, кадры `SensorFrame` и нормализованный CSV ([contracts.md, п. 5](../../docs/contracts.md#5-sensorframe--показания-датчиков)), `PipelineConfigInput` из паспорта.
- Читает: `MappingProfile` (`configs/mappings/*.json`), `LeakLabelsFile`.
- Реализует: `ReplaySource`, `StreamSource` (`DataSource`, п. 8).

Перевод единиц и избыточного давления в абсолютное делается **здесь**, на границе.

## Модули (план)

| Модуль | WP | Что |
| --- | --- | --- |
| `src/parse/` | C1 | CSV/TSV/TXT, Excel, JSON; кодировки, десятичная запятая, форматы времени; потоковый разбор |
| `src/mapping/` | C2 | Автоугадывание колонок по именам и тэгам КИП, единицы из заголовка, применение профиля |
| `src/passport/` | C3 | Паспорт «ключ — значение» и разбор текста → `PipelineConfigInput` |
| `src/sources/` | C1, C5 | `ReplaySource`, `StreamSource` |
