# python/

Python 3.11+: эталон физики, выбор стратегии, опциональный бэкенд.

```bash
pip install -r python/requirements.txt
```

```bash
python3 -m pytest -q
```

| Каталог | Что | Тесты |
| --- | --- | --- |
| [reference/](reference) | Эталон на SciPy с тем же API, что TS-ядро; сверка TS против Python | T-A19 |
| [analysis/](analysis) | `select_strategy.py`: фильтры, счёт, бутстрэп, лидерборд, отчёт | T-B11, T-B12 |
| [api/](api) | FastAPI (опционально): конфиги, разбор тяжёлых форматов, сводка стенда; Dockerfile | WP-C7 |

Конфиги — те же JSON, что в `configs/` (схемы в `schemas/`); единицы — СИ, давление абсолютное.
