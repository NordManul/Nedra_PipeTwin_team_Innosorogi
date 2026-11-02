# python/reference — эталонная физика (WP-A10)

`pipetwin_ref.py` — тот же API, что у TS-ядра, на SciPy: `friction` (Коулбрук через `brentq`, явные формулы), `steady_profile` (непрерывная ОДУ, `solve_ivp`), `steady_from_pressures` (`brentq`), `calibrate` (`least_squares`). На вход — разрешённый конфиг в СИ (`resolveConfig`).

```bash
python3 python/reference/compare_ts_py.py
```

Сверка TS против Python на 5 конфигах (`scripts/export-steady.ts`): давление ≤ 0,09% перепада, температура < 0,001 К (T-A19, `test_reference.py`). Если условие хакатона — «только Python», эта модель становится основным ядром.
