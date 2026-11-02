# python/api — FastAPI, опционально (C)

Приложение работает и без бэкенда. Включаем, если условие требует Python-бэкенд или нужен разбор тяжёлых форматов (WP-C7).

Эндпоинты (план): `/health`, `/configs` (пресеты из `configs/`), `/datasets` (разбор .mat, .h5, .parquet через pandas/h5py → нормализованная таблица), `/runs` (приём логов). Dockerfile, CORS.

Ответы — в форматах контрактов: `PipelineConfigInput`, нормализованный CSV кадров, `RunRecord`.
