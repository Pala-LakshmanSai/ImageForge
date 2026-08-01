from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from conftest import TOKEN_B, auth, wait_for_batch, worker_client

from imageforge_worker.inference import FakeInferenceAdapter


@pytest.mark.anyio
@pytest.mark.endurance
async def test_450_prompt_ordered_run_pauses_survives_new_pod_and_completes(
    tmp_path: Path,
) -> None:
    volume = tmp_path / "network-volume"
    prompts = [f"Editorial realism frame {index:03d}" for index in range(1, 451)]
    first_adapter = FakeInferenceAdapter(delay_seconds=0.001)
    async with worker_client(volume, first_adapter, fsync_writes=False) as (client, _, _):
        created = await client.post(
            "/v1/batches",
            json={"prompts": prompts, "base_seed": 10_000},
            headers=auth(),
        )
        assert created.status_code == 201
        batch_id = created.json()["batch_id"]
        await wait_for_batch(client, batch_id, current_index=1, timeout=60)
        await client.post(f"/v1/batches/{batch_id}/pause", headers=auth())
        paused = await wait_for_batch(client, batch_id, state="paused", timeout=60)
        assert paused["progress"]["completed"] >= 1
        busy = await client.post(
            "/v1/batches", json={"prompts": ["no queue"]}, headers=auth(TOKEN_B)
        )
        assert busy.status_code == 423
        await client.post(f"/v1/batches/{batch_id}/resume", headers=auth())
        await wait_for_batch(client, batch_id, processed_at_least=25, timeout=60)

        first = await client.get(f"/v1/batches/{batch_id}/artifacts/1", headers=auth())
        receipt = await client.post(
            f"/v1/batches/{batch_id}/receipts",
            headers=auth(),
            json={
                "receipts": [
                    {
                        "index": 1,
                        "sha256": hashlib.sha256(first.content).hexdigest(),
                        "size_bytes": len(first.content),
                    }
                ]
            },
        )
        assert receipt.status_code == 200

    replacement_adapter = FakeInferenceAdapter()
    async with worker_client(volume, replacement_adapter, fsync_writes=False) as (client, _, _):
        interrupted = await client.get(f"/v1/batches/{batch_id}", headers=auth())
        assert interrupted.json()["state"] == "interrupted"
        assert interrupted.json()["images"][0]["status"] == "downloaded"
        await client.post(f"/v1/batches/{batch_id}/resume", headers=auth())
        final = await wait_for_batch(client, batch_id, state="completed", timeout=180)

    assert final["progress"] == {
        "total": 450,
        "completed": 450,
        "downloaded": 1,
        "failed": 0,
        "cancelled": 0,
        "processed": 450,
        "current_index": None,
    }
    assert [image["index"] for image in final["images"]] == list(range(1, 451))
    assert [image["prompt"] for image in final["images"]] == prompts
    assert [image["seed"] for image in final["images"]] == list(range(10_000, 10_450))
    assert [image["filename"] for image in final["images"]] == [
        f"artifacts/{index:06d}.jpg" for index in range(1, 451)
    ]
    assert first_adapter.generated_indices + replacement_adapter.generated_indices == list(
        range(1, 451)
    )
    for image in final["images"]:
        path = volume / "batches" / batch_id / image["filename"]
        assert path.stat().st_size == image["size_bytes"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == image["sha256"]
