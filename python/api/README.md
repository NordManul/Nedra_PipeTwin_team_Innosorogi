# python/api — FastAPI, опционально (WP-C7)

Приложение работает и без бэкенда. Включаем, если условие требует Python-бэкенд или нужен разбор тяжёлых форматов.

```bash
uvicorn python.api.app:app --reload
```

```bash
docker build -f python/api/Dockerfile -t pipetwin-api .
```

| Эндпоинт | Что |
| --- | --- |
| `GET /health` | Живость |
| `GET /configs`, `GET /configs/{путь}` | Список и содержимое файлов `configs/` |
| `POST /datasets` | Разбор CSV/Excel/Parquet/HDF5 через pandas → колонки и значения JSON |
| `GET /runs` | Сводка `results/runs.csv` по стратегиям |
| `POST /runs/log` | Приём журнала демо в `results/demo-logs/` |

Тесты — `test_api.py`.
