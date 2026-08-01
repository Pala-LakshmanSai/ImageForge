# API contract

All worker responses include `schema_version: 1`. Errors use a stable `code`, a
safe user `message`, and optional structured `details`.

## Worker endpoints

- `GET /v1/health` -> process, model, GPU, version, phase, phase progress.
- `GET /v1/status` -> active batch summary and requesting user's permissions.
- `POST /v1/batches` -> create one batch or return HTTP 423 `batch_busy`.
- `GET /v1/batches/{id}` -> durable manifest and progress.
- `POST /v1/batches/{id}/pause` -> stop after current image; keep lock.
- `POST /v1/batches/{id}/resume` -> resume owner batch.
- `POST /v1/batches/{id}/cancel` -> cancel remaining images and release lock.
- `POST /v1/batches/{id}/retry-failed` -> retry only terminal failures.
- `GET /v1/batches/{id}/artifacts/{index}` -> full JPEG with checksum headers.
- `GET /v1/batches/{id}/previews/{index}` -> WebP preview.
- `POST /v1/batches/{id}/receipts` -> acknowledge verified local downloads.

The first implementation may use one-second status polling. Transport can move
to signed WebSocket events without changing domain types.

## RunPod client operations

- List approved GPU inventory and current prices.
- List Pods tagged `imageforge`.
- Create one Pod from configured template, GPU type and network volume.
- Read runtime/provisioning state and derive the HTTPS proxy endpoint.
- Terminate a selected Pod only from a confirmed user action.

## Busy response

```json
{
  "schema_version": 1,
  "error": {
    "code": "batch_busy",
    "message": "Lakshman is generating 138 of 420 images.",
    "details": {"owner":"Lakshman","completed":138,"total":420}
  }
}
```
