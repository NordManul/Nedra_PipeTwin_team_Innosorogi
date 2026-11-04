# configs/strategies/

Наборы кандидатов для стенда (`npm run bench -- --strategies <файл>`), когда нужен не стандартный турнир D1–D9, а отдельный эксперимент.

| Файл | Эксперимент |
| --- | --- |
| `e7-localization.json` | E7: один детектор (CUSUM) с тремя методами места L1 `hgl`, L2 `lsq`, L3 `wave-timing` |
| `fusion-threshold-ewma.json` | H-B3: слияние порога и EWMA против CUSUM, порога и EWMA по отдельности |
| `glr-aewma.json` | H-B16, H-B17: GLR (D10) и адаптивный EWMA (D11) в нескольких вариантах, свои пороги |
| `fusion-cusum-aewma.json` | H-B18: «ИЛИ» CUSUM и адаптивного EWMA |
| `sprt.json` | H-B20: SPRT на балансе расходов (D12) и «ИЛИ» EWMA и SPRT |
| `cusum-only.json` | H-B10, H-B11: CUSUM на конфигах с фильтром граничных давлений — EMA (`configs/pipeline.filter{1,2}.json`) и Калман (`configs/pipeline.kalman{1,2,5}.json`) |

```bash
npm run bench -- --no-tune --strategies configs/strategies/e7-localization.json --suite e7 --out results/runs.e7.csv
```

```bash
npm run bench -- --strategies configs/strategies/fusion-threshold-ewma.json --suite e3,e5,noleak,random --out results/runs.fusion.csv
```

```bash
npm run bench -- --config configs/pipeline.filter1.json --strategies configs/strategies/cusum-only.json --suite e3,e5,noleak --out results/runs.filter1.csv
```

Без `--reuse-tuned` стенд калибрует пороги заново и перезаписывает `results/strategies.tuned.json` — сохраните основной файл заранее.
