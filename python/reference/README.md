# python/reference — эталонная физика (A)

Тот же API, что у TS-ядра, на SciPy (WP-A10): `steady_profile` (`solve_ivp`), `friction`, `calibrate` (`least_squares`), режим (p_вх, p_вых) через `brentq`. Скрипт `compare_ts_py.py` сравнивает профили TS и Python на наборе конфигов (тест T-A19, расхождение < 0,1%).

Входы и выходы — по контрактам: конфиг из `configs/pipeline.*.json`, единицы СИ, давление абсолютное.
