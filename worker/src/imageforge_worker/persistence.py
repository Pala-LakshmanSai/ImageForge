from __future__ import annotations

import errno
import hashlib
import json
import os
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Protocol

from .domain import BatchManifest, ImageRecord


class ManifestStore(Protocol):
    def initialize(self) -> None: ...

    def list_batch_ids(self) -> list[str]: ...

    def create(self, manifest: BatchManifest) -> None: ...

    def load(self, batch_id: str) -> BatchManifest: ...

    def save(self, manifest: BatchManifest) -> None: ...

    def write_artifacts(
        self, batch_id: str, index: int, jpeg: bytes, preview: bytes
    ) -> tuple[str, str]: ...

    def artifact_path(self, batch_id: str, relative_name: str) -> Path: ...

    def verify_record_artifacts(self, batch_id: str, record: ImageRecord) -> bool: ...

    def quarantine_artifacts(self, batch_id: str, index: int) -> None: ...


class FileManifestStore:
    """Crash-safe JSON manifests and server-named immutable artifacts."""

    def __init__(self, root: Path, *, fsync_writes: bool = True) -> None:
        self.root = root
        self.batches_root = root / "batches"
        self.fsync_writes = fsync_writes

    def initialize(self) -> None:
        self.batches_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        probe = self.root / ".write-probe"
        self._atomic_write(probe, b"imageforge-storage-probe\n")
        probe.unlink(missing_ok=True)
        self._fsync_directory(self.root)

    def list_batch_ids(self) -> list[str]:
        if not self.batches_root.exists():
            return []
        result: list[str] = []
        for child in self.batches_root.iterdir():
            if not child.is_dir() or not (child / "manifest.json").is_file():
                continue
            try:
                result.append(str(uuid.UUID(child.name)))
            except ValueError:
                continue
        return sorted(result)

    def create(self, manifest: BatchManifest) -> None:
        batch_dir = self._batch_dir(manifest.batch_id)
        batch_dir.mkdir(mode=0o700, parents=False, exist_ok=False)
        (batch_dir / "artifacts").mkdir(mode=0o700)
        (batch_dir / "previews").mkdir(mode=0o700)
        (batch_dir / "quarantine").mkdir(mode=0o700)
        self._fsync_directory(self.batches_root)
        self.save(manifest)

    def load(self, batch_id: str) -> BatchManifest:
        path = self._batch_dir(batch_id) / "manifest.json"
        try:
            payload = path.read_bytes()
        except FileNotFoundError:
            raise
        return BatchManifest.model_validate_json(payload)

    def save(self, manifest: BatchManifest) -> None:
        manifest.recalculate_progress()
        payload = json.dumps(
            manifest.model_dump(mode="json"),
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        path = self._batch_dir(manifest.batch_id) / "manifest.json"
        if not path.parent.is_dir():
            raise FileNotFoundError(path.parent)
        self._atomic_write(path, payload)

    def write_artifacts(
        self, batch_id: str, index: int, jpeg: bytes, preview: bytes
    ) -> tuple[str, str]:
        full_name = f"artifacts/{index:06d}.jpg"
        preview_name = f"previews/{index:06d}.webp"
        self._write_immutable(self.artifact_path(batch_id, full_name), jpeg)
        self._write_immutable(self.artifact_path(batch_id, preview_name), preview)
        return full_name, preview_name

    def artifact_path(self, batch_id: str, relative_name: str) -> Path:
        batch_dir = self._batch_dir(batch_id).resolve()
        candidate = (batch_dir / relative_name).resolve()
        if not candidate.is_relative_to(batch_dir):
            raise ValueError("artifact path escaped its batch directory")
        return candidate

    def verify_record_artifacts(self, batch_id: str, record: ImageRecord) -> bool:
        if not all(
            (
                record.filename,
                record.preview_filename,
                record.sha256,
                record.preview_sha256,
                record.size_bytes,
                record.preview_size_bytes,
            )
        ):
            return False
        full = self.artifact_path(batch_id, record.filename)
        preview = self.artifact_path(batch_id, record.preview_filename)
        return self._matches(full, record.size_bytes, record.sha256) and self._matches(
            preview, record.preview_size_bytes, record.preview_sha256
        )

    def quarantine_artifacts(self, batch_id: str, index: int) -> None:
        batch_dir = self._batch_dir(batch_id)
        quarantine_dir = batch_dir / "quarantine"
        quarantine_dir.mkdir(mode=0o700, exist_ok=True)
        nonce = uuid.uuid4().hex
        for source in (
            batch_dir / "artifacts" / f"{index:06d}.jpg",
            batch_dir / "previews" / f"{index:06d}.webp",
        ):
            if source.exists():
                target = quarantine_dir / f"{source.name}.{nonce}.corrupt-or-orphan"
                os.replace(source, target)
        self._fsync_directory(quarantine_dir)
        self._fsync_directory(batch_dir / "artifacts")
        self._fsync_directory(batch_dir / "previews")

    def _batch_dir(self, batch_id: str) -> Path:
        normalized = str(uuid.UUID(str(batch_id)))
        return self.batches_root / normalized

    def _write_immutable(self, path: Path, payload: bytes) -> None:
        if path.exists():
            if self._matches(path, len(payload), hashlib.sha256(payload).hexdigest()):
                return
            raise FileExistsError(f"immutable artifact already exists: {path.name}")
        self._atomic_write(path, payload)

    def _atomic_write(self, path: Path, payload: bytes) -> None:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
        )
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(payload)
                handle.flush()
                if self.fsync_writes:
                    os.fsync(handle.fileno())
            os.replace(temporary_path, path)
            if self.fsync_writes:
                self._fsync_directory(path.parent)
        except BaseException:
            temporary_path.unlink(missing_ok=True)
            raise

    def _fsync_directory(self, path: Path) -> None:
        if not self.fsync_writes or not path.exists():
            return
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        except OSError as exc:
            if exc.errno not in {errno.EINVAL, errno.ENOTSUP}:
                raise
        finally:
            os.close(descriptor)

    @staticmethod
    def _matches(path: Path, expected_size: int, expected_sha256: str) -> bool:
        try:
            if path.stat().st_size != expected_size:
                return False
            digest = hashlib.sha256()
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            return digest.hexdigest() == expected_sha256
        except FileNotFoundError:
            return False


def clone_store(source: Path, target: Path) -> None:
    """Test helper for simulating a persistent volume attached to a new Pod."""
    shutil.copytree(source, target, dirs_exist_ok=True)
