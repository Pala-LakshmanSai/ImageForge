from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from conftest import auth, wait_for_batch, worker_client

from imageforge_worker.cleanup_retention import cleanup_retained_artifacts
from imageforge_worker.inference import FakeInferenceAdapter
from imageforge_worker.persistence import FileManifestStore


@pytest.mark.anyio
async def test_new_pod_recovers_interrupted_batch_without_regenerating_ready_images(
    tmp_path: Path,
) -> None:
    volume = tmp_path / "network-volume"
    first_adapter = FakeInferenceAdapter(delay_seconds=0.06)
    async with worker_client(
        volume,
        first_adapter,
        runtime_metadata={"RUNPOD_POD_ID": "old-pod"},
    ) as (client, _, _):
        created = await client.post(
            "/v1/batches",
            json={"prompts": [f"recover {index}" for index in range(6)]},
            headers=auth(),
        )
        batch_id = created.json()["batch_id"]
        await wait_for_batch(client, batch_id, processed_at_least=1, current_index=2)
        before_restart = await client.get(f"/v1/batches/{batch_id}", headers=auth())
        first_checksum = before_restart.json()["images"][0]["sha256"]

    second_adapter = FakeInferenceAdapter()
    async with worker_client(
        volume,
        second_adapter,
        runtime_metadata={"RUNPOD_POD_ID": "replacement-pod"},
    ) as (client, _, _):
        status = await client.get("/v1/status", headers=auth())
        assert status.json()["active_batch"]["batch_id"] == batch_id
        assert status.json()["active_batch"]["state"] == "interrupted"
        interrupted = await client.get(f"/v1/batches/{batch_id}", headers=auth())
        assert interrupted.json()["images"][0]["sha256"] == first_checksum
        assert interrupted.json()["images"][0]["status"] == "ready"
        assert interrupted.json()["images"][1]["status"] == "pending"

        resumed = await client.post(f"/v1/batches/{batch_id}/resume", headers=auth())
        assert resumed.status_code == 200
        completed = await wait_for_batch(client, batch_id, state="completed")
        assert completed["progress"]["completed"] == 6
        assert 1 not in second_adapter.generated_indices
        assert second_adapter.generated_indices == [2, 3, 4, 5, 6]


@pytest.mark.anyio
async def test_corrupt_ready_artifact_is_quarantined_and_regenerated(tmp_path: Path) -> None:
    volume = tmp_path / "network-volume"
    async with worker_client(volume) as (client, _, _):
        created = await client.post(
            "/v1/batches", json={"prompts": ["replace me", "keep me"]}, headers=auth()
        )
        batch_id = created.json()["batch_id"]
        completed = await wait_for_batch(client, batch_id, state="completed")
        second_checksum = completed["images"][1]["sha256"]

    damaged = volume / "batches" / batch_id / "artifacts" / "000001.jpg"
    damaged.write_bytes(b"damaged")

    replacement = FakeInferenceAdapter()
    async with worker_client(volume, replacement) as (client, _, _):
        recovered = await client.get(f"/v1/batches/{batch_id}", headers=auth())
        assert recovered.json()["state"] == "interrupted"
        assert recovered.json()["images"][0]["status"] == "pending"
        assert recovered.json()["images"][1]["sha256"] == second_checksum
        quarantine = volume / "batches" / batch_id / "quarantine"
        assert any(path.name.startswith("000001.jpg") for path in quarantine.iterdir())

        await client.post(f"/v1/batches/{batch_id}/resume", headers=auth())
        final = await wait_for_batch(client, batch_id, state="completed")
        assert replacement.generated_indices == [1]
        assert final["images"][1]["sha256"] == second_checksum


def test_manifest_replacement_and_artifacts_are_atomic_and_immutable(tmp_path: Path) -> None:
    store = FileManifestStore(tmp_path / "volume")
    store.initialize()
    assert store.try_acquire_active_lease()
    from imageforge_worker.domain import (
        BatchManifest,
        BatchOwner,
        BatchProgress,
        BatchState,
        ImageRecord,
        utc_now,
    )

    now = utc_now()
    manifest = BatchManifest(
        batch_id="00000000-0000-4000-8000-000000000001",
        owner=BatchOwner(user_id="lakshman", display_name="Lakshman"),
        state=BatchState.PAUSED,
        created_at=now,
        updated_at=now,
        images=[ImageRecord(index=1, prompt="durable", seed=0)],
        progress=BatchProgress(total=1),
    )
    store.create(manifest)
    for _ in range(10):
        store.save(manifest)
        payload = json.loads(
            (tmp_path / "volume" / "batches" / manifest.batch_id / "manifest.json").read_text()
        )
        assert payload["schema_version"] == 1
    assert not list((tmp_path / "volume").rglob("*.tmp"))

    jpeg = b"jpeg-payload"
    preview = b"preview-payload"
    names = store.write_artifacts(manifest.batch_id, 1, jpeg, preview)
    assert names == ("artifacts/000001.jpg", "previews/000001.webp")
    store.write_artifacts(manifest.batch_id, 1, jpeg, preview)
    with pytest.raises(FileExistsError):
        store.write_artifacts(manifest.batch_id, 1, b"different", preview)
    with pytest.raises(ValueError):
        store.artifact_path(manifest.batch_id, "../../outside")
    assert (
        hashlib.sha256(store.artifact_path(manifest.batch_id, names[0]).read_bytes()).hexdigest()
        == hashlib.sha256(jpeg).hexdigest()
    )
    store.release_active_lease()
    mutation_guard = "mutations require the active-volume lease"
    with pytest.raises(RuntimeError, match=mutation_guard):
        store.create(manifest)
    with pytest.raises(RuntimeError, match=mutation_guard):
        store.save(manifest)
    with pytest.raises(RuntimeError, match=mutation_guard):
        store.write_artifacts(manifest.batch_id, 1, jpeg, preview)
    with pytest.raises(RuntimeError, match=mutation_guard):
        store.quarantine_artifacts(manifest.batch_id, 1)
    with pytest.raises(RuntimeError, match=mutation_guard):
        store.cleanup_acknowledged_artifacts(now=datetime.now(UTC))
    with pytest.raises(RuntimeError, match="active batch"):
        cleanup_retained_artifacts(tmp_path / "volume")


@pytest.mark.anyio
async def test_explicit_retention_cleanup_is_24h_receipt_gated_and_restart_safe(
    tmp_path: Path,
) -> None:
    volume = tmp_path / "network-volume"
    async with worker_client(volume) as (client, _, _):
        created = await client.post(
            "/v1/batches",
            json={"prompts": ["old receipt", "recent receipt", "not acknowledged"]},
            headers=auth(),
        )
        batch_id = created.json()["batch_id"]
        completed = await wait_for_batch(client, batch_id, state="completed")
        receipts = [
            {
                "index": index,
                "sha256": completed["images"][index - 1]["sha256"],
                "size_bytes": completed["images"][index - 1]["size_bytes"],
            }
            for index in (1, 2)
        ]
        response = await client.post(
            f"/v1/batches/{batch_id}/receipts",
            json={"receipts": receipts},
            headers=auth(),
        )
        assert response.status_code == 200

    now = datetime(2026, 8, 1, 12, tzinfo=UTC)
    store = FileManifestStore(volume)
    store.initialize()
    assert store.try_acquire_active_lease()
    manifest = store.load(batch_id)
    assert manifest.images[0].receipt is not None
    assert manifest.images[1].receipt is not None
    manifest.images[0].receipt.acknowledged_at = (now - timedelta(hours=25)).isoformat()
    manifest.images[1].receipt.acknowledged_at = (now - timedelta(hours=23)).isoformat()
    store.save(manifest)
    old_full = store.artifact_path(batch_id, manifest.images[0].filename or "")
    recent_full = store.artifact_path(batch_id, manifest.images[1].filename or "")
    unacknowledged_full = store.artifact_path(batch_id, manifest.images[2].filename or "")
    store.release_active_lease()

    result = cleanup_retained_artifacts(volume, now=now)
    assert result.images_deleted == 1
    assert result.files_deleted == 2
    assert result.bytes_deleted > 0
    assert not old_full.exists()
    assert recent_full.is_file()
    assert unacknowledged_full.is_file()
    assert cleanup_retained_artifacts(volume, now=now).images_deleted == 0

    with pytest.raises(ValueError, match="at least 24 hours"):
        cleanup_retained_artifacts(volume, now=now, minimum_age=timedelta(hours=23))

    async with worker_client(volume) as (client, _, _):
        recovered = await client.get(f"/v1/batches/{batch_id}", headers=auth())
        assert recovered.json()["state"] == "completed"
        assert recovered.json()["images"][0]["status"] == "downloaded"
        assert recovered.json()["images"][0]["artifacts_deleted_at"] is not None
        expired = await client.get(f"/v1/batches/{batch_id}/artifacts/1", headers=auth())
        retained = await client.get(f"/v1/batches/{batch_id}/artifacts/2", headers=auth())
        assert expired.status_code == 410
        assert expired.json()["error"]["code"] == "artifact_expired"
        assert retained.status_code == 200
