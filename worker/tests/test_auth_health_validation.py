from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import auth, wait_for_health, worker_client

from imageforge_worker.config import WorkerSettings
from imageforge_worker.constants import MODEL_REVISION
from imageforge_worker.inference import FakeInferenceAdapter


@pytest.mark.anyio
async def test_health_is_available_through_boot_phases_and_auth_is_required(
    tmp_path: Path,
) -> None:
    adapter = FakeInferenceAdapter(startup_delay_seconds=0.04)
    async with worker_client(tmp_path / "volume", adapter, wait_until_ready=False) as (
        client,
        _,
        _,
    ):
        first = await client.get("/v1/health")
        assert first.status_code == 200
        assert first.json()["schema_version"] == 1
        assert first.json()["phase"] in {
            "process",
            "storage",
            "weights",
            "gpu_load",
            "warmup",
            "ready",
        }

        early_create = await client.post(
            "/v1/batches", json={"prompts": ["never logged"]}, headers=auth()
        )
        assert early_create.status_code == 503
        assert early_create.json()["error"]["code"] == "worker_not_ready"

        no_auth = await client.get("/v1/status")
        wrong_auth = await client.get("/v1/status", headers={"Authorization": "Bearer " + "z" * 32})
        assert no_auth.status_code == wrong_auth.status_code == 401
        assert no_auth.headers["www-authenticate"] == "Bearer"
        assert no_auth.json()["error"]["code"] == "authentication_required"

        health = await wait_for_health(client, "ready")
        assert health["model"]["revision"] == MODEL_REVISION
        assert health["gpu"]["device_count"] == 1
        assert health["gpu"]["total_memory_bytes"] == 24 * 1024**3
        assert adapter.phase_history == ["weights", "gpu_load", "warmup", "ready"]
        assert set(health["phase_timings_ms"]) >= {
            "process",
            "storage",
            "weights",
            "gpu_load",
            "warmup",
            "ready",
        }


def test_runtime_secret_parsing_and_repr_redaction(tmp_path: Path) -> None:
    secret = "this-is-a-runtime-only-secret-0001"
    env = {
        "IMAGEFORGE_DATA_ROOT": str(tmp_path / "volume"),
        "IMAGEFORGE_MODEL_CACHE_DIR": str(tmp_path / "models"),
        "IMAGEFORGE_INFERENCE_BACKEND": "fake",
        "IMAGEFORGE_ALLOW_FAKE_INFERENCE": "1",
        "IMAGEFORGE_AUTH_TOKENS_JSON": json.dumps(
            [{"user_id": "lakshman", "display_name": "Lakshman", "token": secret}]
        ),
    }
    settings = WorkerSettings.from_env(env)
    assert settings.credentials[0].token == secret
    assert secret not in repr(settings.credentials[0])
    assert secret not in repr(settings)


@pytest.mark.anyio
async def test_validation_is_bounded_strict_and_does_not_echo_prompts(tmp_path: Path) -> None:
    async with worker_client(tmp_path / "volume") as (client, _, _):
        sensitive_prompt = "DO-NOT-ECHO-THIS" + "x" * 4096
        response = await client.post(
            "/v1/batches",
            json={"prompts": [sensitive_prompt], "unexpected_path": "../../etc/passwd"},
            headers=auth(),
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_error"
        assert sensitive_prompt not in response.text
        assert "../../etc/passwd" not in response.text

        too_many = await client.post(
            "/v1/batches",
            json={"prompts": [f"prompt {index}" for index in range(501)]},
            headers=auth(),
        )
        assert too_many.status_code == 422
        assert "prompt 500" not in too_many.text

        wrong_type = await client.post("/v1/batches", json={"prompts": [123]}, headers=auth())
        assert wrong_type.status_code == 422


@pytest.mark.anyio
async def test_health_stays_public_but_undocumented_routes_are_disabled(tmp_path: Path) -> None:
    async with worker_client(tmp_path / "volume") as (client, _, _):
        assert (await client.get("/v1/health")).status_code == 200
        docs = await client.get("/docs")
        schema = await client.get("/openapi.json")
        assert docs.status_code == schema.status_code == 404
        assert docs.json()["schema_version"] == 1
