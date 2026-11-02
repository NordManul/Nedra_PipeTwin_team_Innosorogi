"""WP-C7: смоук-тесты API."""
from fastapi.testclient import TestClient

from python.api.app import ROOT, app

client = TestClient(app)


def test_health():
    assert client.get("/health").json()["status"] == "ok"


def test_configs():
    files = client.get("/configs").json()["files"]
    assert "pipeline.default.json" in files
    cfg = client.get("/configs/pipeline.default.json").json()
    assert cfg["schemaVersion"] == 1
    assert client.get("/configs/../package.json").status_code == 404


def test_datasets_csv():
    r = client.post("/datasets", files={"file": ("iso_utf8.csv", (ROOT / "fixtures/import/iso_utf8.csv").read_bytes(), "text/csv")}).json()
    assert r["rows"] == 30
    assert "timestamp" in r["columns"]


def test_datasets_excel():
    r = client.post("/datasets", files={"file": ("multi_sheet.xlsx", (ROOT / "fixtures/import/multi_sheet.xlsx").read_bytes())}).json()
    assert r["rows"] > 0
