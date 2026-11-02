# configs/strategies/

Наборы кандидатов для стенда (`npm run bench -- --strategies <файл>`), когда нужен не стандартный турнир D1–D9, а отдельный эксперимент.

| Файл | Эксперимент |
| --- | --- |
| `e7-localization.json` | E7: один детектор (CUSUM) с тремя методами места L1 `hgl`, L2 `lsq`, L3 `wave-timing` |

```bash
npm run bench -- --no-tune --strategies configs/strategies/e7-localization.json --suite e7 --out results/runs.e7.csv
```
