use super::worker::{validate_checksum, validate_index};
use super::{DestinationStore, NativeError, NativeResult, WorkerApi};
use futures_util::StreamExt;
use reqwest::header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use uuid::Uuid;

const MAX_JPEG_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadRequest {
    pub batch_id: Uuid,
    pub index: u16,
    pub expected_sha256: String,
    pub expected_size_bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadReceipt {
    pub schema_version: u8,
    pub batch_id: Uuid,
    pub index: u16,
    pub filename: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub verified_at_unix_ms: u64,
}

#[derive(Clone)]
pub struct Downloader {
    worker: WorkerApi,
    destination: DestinationStore,
    io_lock: Arc<Mutex<()>>,
}

impl Downloader {
    pub fn new(worker: WorkerApi, destination: DestinationStore) -> Self {
        Self {
            worker,
            destination,
            io_lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn download_and_acknowledge(
        &self,
        request: DownloadRequest,
    ) -> NativeResult<DownloadReceipt> {
        validate_download_request(&request)?;
        let _guard = self.io_lock.lock().await;
        let filename = format!("{:06}.jpg", request.index);
        let final_path = self.destination.confine(Path::new(&filename))?;
        let part_path = self
            .destination
            .confine(Path::new(&format!("{filename}.part")))?;
        reject_symlink(&final_path)?;
        reject_symlink(&part_path)?;

        if final_path.is_file() {
            verify_file(
                &final_path,
                request.expected_size_bytes,
                &request.expected_sha256,
            )
            .await
            .map_err(|_| {
                NativeError::new(
                    "destination_conflict",
                    "A different numbered JPEG already exists in this destination.",
                )
            })?;
        } else {
            self.download_to_part(&request, &part_path).await?;
            verify_file(
                &part_path,
                request.expected_size_bytes,
                &request.expected_sha256,
            )
            .await
            .map_err(|_| {
                let _ = std::fs::OpenOptions::new()
                    .write(true)
                    .open(&part_path)
                    .and_then(|file| file.set_len(0));
                NativeError::retryable(
                    "download_checksum_mismatch",
                    "The JPEG checksum did not match; the safe retry will start from byte zero.",
                )
            })?;
            tokio::fs::rename(&part_path, &final_path)
                .await
                .map_err(|_| {
                    NativeError::new(
                        "download_finalize_failed",
                        "The verified JPEG could not be renamed into place.",
                    )
                })?;
            sync_parent(&final_path).await;
        }

        let receipt = DownloadReceipt {
            schema_version: 1,
            batch_id: request.batch_id,
            index: request.index,
            filename,
            sha256: request.expected_sha256,
            size_bytes: request.expected_size_bytes,
            verified_at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
        };
        self.persist_receipt(&receipt).await?;
        let acknowledgement = self
            .worker
            .acknowledge(
                request.batch_id,
                request.index,
                &receipt.sha256,
                receipt.size_bytes,
            )
            .await?;
        if !(200..300).contains(&acknowledgement.status) {
            return Err(worker_acknowledgement_error(&acknowledgement.body));
        }
        Ok(receipt)
    }

    async fn download_to_part(
        &self,
        request: &DownloadRequest,
        part_path: &Path,
    ) -> NativeResult<()> {
        let mut existing = file_size(part_path).await?;
        if existing > request.expected_size_bytes {
            truncate(part_path).await?;
            existing = 0;
        }
        if existing == request.expected_size_bytes {
            return Ok(());
        }

        for attempt in 0..2 {
            let url = self.worker.session().endpoint(&format!(
                "/v1/batches/{}/artifacts/{}",
                request.batch_id, request.index
            ))?;
            self.worker.session().assert_url_is_current(&url)?;
            let token = self.worker.worker_token()?;
            let mut builder = self
                .worker
                .client()
                .get(url)
                .header(AUTHORIZATION, format!("Bearer {token}"));
            drop(token);
            if existing > 0 {
                builder = builder.header(RANGE, format!("bytes={existing}-"));
            }
            let response = builder.send().await.map_err(|_| {
                NativeError::retryable(
                    "download_network_error",
                    "The JPEG download was interrupted and can be resumed.",
                )
            })?;
            let status = response.status();
            if status == StatusCode::RANGE_NOT_SATISFIABLE && attempt == 0 {
                truncate(part_path).await?;
                existing = 0;
                continue;
            }
            if status != StatusCode::OK && status != StatusCode::PARTIAL_CONTENT {
                return Err(NativeError::retryable(
                    "download_request_failed",
                    format!(
                        "The worker could not provide image {} (HTTP {}).",
                        request.index,
                        status.as_u16()
                    ),
                ));
            }

            let response_checksum = response
                .headers()
                .get("x-imageforge-sha256")
                .and_then(|value| value.to_str().ok());
            if response_checksum != Some(request.expected_sha256.as_str()) {
                return Err(NativeError::new(
                    "download_metadata_mismatch",
                    "The worker's JPEG checksum metadata changed unexpectedly.",
                ));
            }
            if response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| !value.starts_with("image/jpeg"))
            {
                return Err(NativeError::new(
                    "download_metadata_mismatch",
                    "The worker returned a non-JPEG artifact.",
                ));
            }

            if status == StatusCode::PARTIAL_CONTENT {
                validate_content_range(&response, existing, request.expected_size_bytes)?;
            }
            let append = existing > 0 && status == StatusCode::PARTIAL_CONTENT;
            let write_offset = if append { existing } else { 0 };
            let expected_response_bytes = request.expected_size_bytes - write_offset;
            if response
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                != Some(expected_response_bytes)
            {
                return Err(NativeError::retryable(
                    "download_metadata_mismatch",
                    "The worker returned an unexpected JPEG byte count.",
                ));
            }

            let mut output = tokio::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .append(append)
                .truncate(!append)
                .open(part_path)
                .await
                .map_err(|_| destination_io_error())?;
            let mut received = 0_u64;
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| {
                    NativeError::retryable(
                        "download_network_error",
                        "The JPEG download was interrupted and can be resumed.",
                    )
                })?;
                received = received.saturating_add(chunk.len() as u64);
                if received > expected_response_bytes {
                    return Err(NativeError::new(
                        "download_too_large",
                        "The worker sent more JPEG data than declared.",
                    ));
                }
                output
                    .write_all(&chunk)
                    .await
                    .map_err(|_| destination_io_error())?;
            }
            output.flush().await.map_err(|_| destination_io_error())?;
            output
                .sync_all()
                .await
                .map_err(|_| destination_io_error())?;
            if received != expected_response_bytes {
                return Err(NativeError::retryable(
                    "download_incomplete",
                    "The JPEG download ended early and can be resumed.",
                ));
            }
            return Ok(());
        }
        Err(NativeError::retryable(
            "download_resume_rejected",
            "The worker could not resume this JPEG; retrying will start it again.",
        ))
    }

    async fn persist_receipt(&self, receipt: &DownloadReceipt) -> NativeResult<()> {
        let receipt_dir_relative = PathBuf::from(".imageforge")
            .join("receipts")
            .join(receipt.batch_id.to_string());
        let receipt_dir = self.destination.confine(&receipt_dir_relative)?;
        reject_symlink_chain(&self.destination.current()?, &receipt_dir_relative)?;
        tokio::fs::create_dir_all(&receipt_dir)
            .await
            .map_err(|_| destination_io_error())?;
        let receipt_path = receipt_dir.join(format!("{:06}.json", receipt.index));
        reject_symlink(&receipt_path)?;
        if receipt_path.is_file() {
            let existing = tokio::fs::read(&receipt_path)
                .await
                .map_err(|_| destination_io_error())?;
            let stored: DownloadReceipt = serde_json::from_slice(&existing).map_err(|_| {
                NativeError::new(
                    "receipt_conflict",
                    "An existing local receipt is unreadable; no file was overwritten.",
                )
            })?;
            if stored.batch_id == receipt.batch_id
                && stored.index == receipt.index
                && stored.sha256 == receipt.sha256
                && stored.size_bytes == receipt.size_bytes
            {
                return Ok(());
            }
            return Err(NativeError::new(
                "receipt_conflict",
                "A different local receipt already occupies this numbered slot.",
            ));
        }

        let temporary = receipt_dir.join(format!(".{:06}.{}.tmp", receipt.index, Uuid::new_v4()));
        let encoded = serde_json::to_vec(receipt).map_err(|_| {
            NativeError::new(
                "receipt_write_failed",
                "The local receipt could not be encoded.",
            )
        })?;
        let result = async {
            let mut file = tokio::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)
                .await?;
            file.write_all(&encoded).await?;
            file.flush().await?;
            file.sync_all().await?;
            drop(file);
            tokio::fs::rename(&temporary, &receipt_path).await?;
            Ok::<(), std::io::Error>(())
        }
        .await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(NativeError::new(
                "receipt_write_failed",
                "The verified local receipt could not be saved.",
            ));
        }
        sync_parent(&receipt_path).await;
        Ok(())
    }
}

fn validate_download_request(request: &DownloadRequest) -> NativeResult<()> {
    validate_index(request.index)?;
    validate_checksum(&request.expected_sha256)?;
    if request.expected_size_bytes == 0 || request.expected_size_bytes > MAX_JPEG_BYTES {
        return Err(NativeError::new(
            "download_size_invalid",
            "The worker returned an invalid JPEG size.",
        ));
    }
    Ok(())
}

fn validate_content_range(
    response: &reqwest::Response,
    expected_start: u64,
    expected_total: u64,
) -> NativeResult<()> {
    let raw = response
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            NativeError::retryable(
                "download_resume_rejected",
                "The worker did not confirm the resumed JPEG range.",
            )
        })?;
    let (range, total) = raw
        .strip_prefix("bytes ")
        .and_then(|value| value.split_once('/'))
        .ok_or_else(|| {
            NativeError::new(
                "download_metadata_mismatch",
                "The JPEG range metadata was invalid.",
            )
        })?;
    let (start, end) = range
        .split_once('-')
        .and_then(|(start, end)| Some((start.parse::<u64>().ok()?, end.parse::<u64>().ok()?)))
        .ok_or_else(|| {
            NativeError::new(
                "download_metadata_mismatch",
                "The JPEG range metadata was invalid.",
            )
        })?;
    let total = total.parse::<u64>().map_err(|_| {
        NativeError::new(
            "download_metadata_mismatch",
            "The JPEG range metadata was invalid.",
        )
    })?;
    if start != expected_start || total != expected_total || end + 1 != total {
        return Err(NativeError::new(
            "download_metadata_mismatch",
            "The worker returned a different JPEG byte range than requested.",
        ));
    }
    Ok(())
}

async fn file_size(path: &Path) -> NativeResult<u64> {
    match tokio::fs::metadata(path).await {
        Ok(metadata) if metadata.is_file() => Ok(metadata.len()),
        Ok(_) => Err(NativeError::new(
            "destination_conflict",
            "A non-file entry occupies the JPEG download slot.",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(_) => Err(destination_io_error()),
    }
}

async fn truncate(path: &Path) -> NativeResult<()> {
    let file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .await
        .map_err(|_| destination_io_error())?;
    file.sync_all().await.map_err(|_| destination_io_error())
}

async fn verify_file(path: &Path, expected_size: u64, expected_sha256: &str) -> NativeResult<()> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|_| destination_io_error())?;
    if !metadata.is_file() || metadata.len() != expected_size {
        return Err(NativeError::new(
            "download_checksum_mismatch",
            "The local JPEG byte count did not match its receipt.",
        ));
    }
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| destination_io_error())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .await
            .map_err(|_| destination_io_error())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    if hex::encode(hasher.finalize()) != expected_sha256 {
        return Err(NativeError::new(
            "download_checksum_mismatch",
            "The local JPEG checksum did not match its receipt.",
        ));
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> NativeResult<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(NativeError::new(
            "destination_path_rejected",
            "ImageForge will not write through a symbolic link.",
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(destination_io_error()),
    }
}

fn reject_symlink_chain(root: &Path, relative: &Path) -> NativeResult<()> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return Err(NativeError::new(
                "destination_path_rejected",
                "The local receipt path is invalid.",
            ));
        };
        current.push(component);
        reject_symlink(&current)?;
    }
    Ok(())
}

async fn sync_parent(path: &Path) {
    if let Some(parent) = path.parent() {
        let parent = parent.to_path_buf();
        let _ = tokio::task::spawn_blocking(move || {
            std::fs::File::open(parent).and_then(|directory| directory.sync_all())
        })
        .await;
    }
}

fn worker_acknowledgement_error(body: &serde_json::Value) -> NativeError {
    let message = body
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(serde_json::Value::as_str)
        .filter(|message| message.len() <= 300)
        .unwrap_or("The worker did not accept the verified local receipt.");
    NativeError::retryable("receipt_acknowledgement_failed", message)
}

fn destination_io_error() -> NativeError {
    NativeError::new(
        "destination_write_failed",
        "ImageForge could not safely update the selected downloads folder.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn verifies_exact_size_and_sha256() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("000001.jpg.part");
        tokio::fs::write(&path, b"verified-jpeg").await.unwrap();
        let checksum = hex::encode(Sha256::digest(b"verified-jpeg"));
        verify_file(&path, 13, &checksum).await.unwrap();
        assert_eq!(
            verify_file(&path, 12, &checksum).await.unwrap_err().code,
            "download_checksum_mismatch"
        );
        assert_eq!(
            verify_file(&path, 13, &"0".repeat(64))
                .await
                .unwrap_err()
                .code,
            "download_checksum_mismatch"
        );
    }

    #[test]
    fn download_contract_rejects_oversized_or_malformed_artifacts() {
        let batch_id = Uuid::new_v4();
        let valid = DownloadRequest {
            batch_id,
            index: 1,
            expected_sha256: "a".repeat(64),
            expected_size_bytes: 1024,
        };
        assert!(validate_download_request(&valid).is_ok());
        assert_eq!(
            validate_download_request(&DownloadRequest {
                expected_size_bytes: MAX_JPEG_BYTES + 1,
                ..valid.clone()
            })
            .unwrap_err()
            .code,
            "download_size_invalid"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_targets_are_never_followed() {
        use std::os::unix::fs::symlink;
        let temporary = tempfile::tempdir().unwrap();
        let outside = temporary.path().join("outside");
        std::fs::write(&outside, b"do not overwrite").unwrap();
        let link = temporary.path().join("000001.jpg.part");
        symlink(&outside, &link).unwrap();
        assert_eq!(
            reject_symlink(&link).unwrap_err().code,
            "destination_path_rejected"
        );
        assert_eq!(std::fs::read(&outside).unwrap(), b"do not overwrite");
    }
}
