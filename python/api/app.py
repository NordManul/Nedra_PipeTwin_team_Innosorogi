"""
PipeTwin API (WP-C7, опционально). Приложение работает и без него: расчёт — в браузере.

    uvicorn python.api.app:app --reload        (из корня репозитория)

Эндпоинты:
    GET  /health                 — живость
    GET  /configs                — список конфигов, сценариев, профилей маппинга
    GET  /configs/{path}         — содержимое файла из configs/
    POST /datasets               — разбор тяжёлых форматов (CSV, Excel, Parquet, HDF5) через pandas → таблица JSON
    GET  /runs                   — сводка results/runs.csv по стратегиям
    POST /runs/log               — приём журнала демо (CSV) в results/demo-logs/
"""
from __future__ import annotations

import io
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

ROOT = Path(__file__).resolve().parents[2]
CONFIGS = ROOT / "configs"

app = FastAPI(title="PipeTwin API", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat()}


@app.get("/configs")
def list_configs() -> dict:
    files = sorted(p.relative_to(CONFIGS).as_posix() for p in CONFIGS.rglob("*.json"))
    return {"files": files}


@app.get("/configs/{path:path}")
def get_config(path: str) -> dict:
    p = (CONFIGS / path).resolve()
    if CONFIGS.resolve() not in p.parents or not p.is_file():
        raise HTTPException(404, f"нет файла configs/{path}")
    return json.loads(p.read_text(encoding="utf-8"))


def read_table(name: str, data: bytes) -> pd.DataFrame:
    ext = name.lower().rsplit(".", 1)[-1]
    if ext in ("xlsx", "xls", "xlsm"):
        return pd.read_excel(io.BytesIO(data))
    if ext == "parquet":
        return pd.read_parquet(io.BytesIO(data))
    if ext in ("h5", "hdf5"):
        tmp = ROOT / "results" / f".upload-{datetime.now().timestamp()}.h5"
        tmp.write_bytes(data)
        try:
            return pd.read_hdf(tmp)
        finally:
            tmp.unlink(missing_ok=True)
    text = data.decode("utf-8", errors="strict") if _is_utf8(data) else data.decode("cp1251")
    return pd.read_csv(io.StringIO(text), sep=None, engine="python", decimal="," if text.count(",") > text.count(".") and ";" in text else ".")


def _is_utf8(b: bytes) -> bool:
    try:
        b.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


@app.post("/datasets")
async def datasets(file: UploadFile) -> dict:
    """Нормализованная таблица: имена колонок и значения (числа или строки), первые 100 000 строк."""
    df = read_table(file.filename or "data.csv", await file.read())
    df = df.head(100_000)
    return {
        "name": file.filename,
        "rows": len(df),
        "columns": [str(c) for c in df.columns],
        "data": {str(c): [None if pd.isna(v) else (v.item() if hasattr(v, "item") else str(v)) for v in df[c]] for c in df.columns},
    }


@app.get("/runs")
def runs() -> dict:
    path = ROOT / "results/runs.csv"
    if not path.exists():
        raise HTTPException(404, "нет results/runs.csv — запустите npm run bench")
    df = pd.read_csv(path)
    leaks = df[df.leak_present == 1]
    summary = []
    for sid, g in df.groupby("strategy_id"):
        lg = leaks[leaks.strategy_id == sid]
        obs = g.noleak_s.fillna(0).sum()
        summary.append({
            "strategy_id": sid,
            "runs": int(len(g)),
            "pod": float(lg.t_alarm.notna().mean()) if len(lg) else None,
            "ttd_med": float(lg.ttd.median()) if lg.ttd.notna().any() else None,
            "far_per_day": float(g.false_alarms.sum() / obs * 86400) if obs else None,
        })
    return {"runs": int(len(df)), "strategies": summary}


@app.post("/runs/log")
async def log(file: UploadFile) -> dict:
    out = ROOT / "results/demo-logs"
    out.mkdir(parents=True, exist_ok=True)
    name = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{Path(file.filename or 'log.csv').name}"
    (out / name).write_bytes(await file.read())
    return {"saved": f"results/demo-logs/{name}"}
