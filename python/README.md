# python/

Python 3.11: numpy, scipy, pandas, matplotlib. Эталон физики, калибровка, анализ результатов и опциональный бэкенд.

| Каталог | Владелец | Что |
| --- | --- | --- |
| [reference/](reference) | A | Эталонная модель на SciPy с тем же API, что TS-ядро; сверка TS против Python |
| [analysis/](analysis) | B | Ноутбуки, `select_strategy.py`, отчёты |
| [api/](api) | C | FastAPI (опционально): пресеты, разбор тяжёлых форматов, приём логов |

Файлы конфигов валидируются pydantic-моделями, построенными по тем же JSON Schema из [`schemas/`](../schemas), что и zod-схемы в TS. Типы и единицы — как в [docs/contracts.md](../docs/contracts.md).
