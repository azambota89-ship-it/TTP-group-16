import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import create_app  # noqa: E402


@pytest.fixture
def app(tmp_path):
    return create_app({
        "DATABASE": str(tmp_path / "test.db"),
        "SECRET_KEY": "test-secret",
        "ADMIN_USERNAME": "admin",
        "ADMIN_PASSWORD": "correct-horse",
        "SEED_SAMPLES": True,
    })


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def auth(client):
    token = client.post("/admin/login", json={"username": "admin", "password": "correct-horse"}).get_json()["token"]
    return {"Authorization": f"Bearer {token}"}
