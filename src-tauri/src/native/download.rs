use super::destination::{move_path_no_replace, sanitize_batch_folder_name};
use super::session::WorkerSessionPin;
use super::worker::{validate_checksum, validate_index};
use super::{DestinationStore, NativeError, NativeResult, WorkerApi};
use futures_util::StreamExt;
use reqwest::header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use uuid::Uuid;

const MAX_JPEG_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RECEIPT_BYTES: u64 = 16 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadRequest {
    pub batch_id: Uuid,
    #[serde(default)]
    pub batch_name: Option<String>,
    pub index: u64,
    pub expected_sha256: String,
    pub expected_size_bytes: u64,
    pub expected_width: u32,
    pub expected_height: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportArtifactRequest {
    pub batch_id: Uuid,
    pub index: u64,
    pub batch_name: String,
    pub checksum: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalArtifactResponse {
    pub content_type: &'static str,
    pub sha256: String,
    pub size_bytes: u64,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadReceipt {
    pub schema_version: u8,
    pub batch_id: Uuid,
    pub index: u64,
    pub filename: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub verified_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptLedger {
    pub schema_version: u8,
    pub batch_id: Uuid,
    pub receipts: Vec<DownloadReceipt>,
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
        let session = self.worker.session().pin().await?;
        let batch_folder = match request.batch_name.as_deref() {
            Some(batch_name) => self
                .destination
                .resolve_batch_folder(request.batch_id, batch_name)?,
            None => self
                .destination
                .resolve_existing_batch_folder(request.batch_id)?
                .unwrap_or_else(|| request.batch_id.to_string()),
        };
        let batch_relative = PathBuf::from("batches").join(&batch_folder);
        ensure_relative_directory(&self.destination, &batch_relative).await?;
        let filename = format!("batches/{batch_folder}/{:06}.jpg", request.index);
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
                Some((request.expected_width, request.expected_height)),
            )
            .await
            .map_err(|_| {
                NativeError::new(
                    "destination_conflict",
                    "A different numbered JPEG already exists in this destination.",
                )
            })?;
            reject_file_secret_reflection(&final_path, &self.worker.saved_secrets()?).await?;
        } else {
            self.download_to_part(&session, &request, &part_path)
                .await?;
            verify_file(
                &part_path,
                request.expected_size_bytes,
                &request.expected_sha256,
                Some((request.expected_width, request.expected_height)),
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
            if let Err(error) =
                reject_file_secret_reflection(&part_path, &self.worker.saved_secrets()?).await
            {
                truncate(&part_path).await?;
                return Err(error);
            }
            install_no_clobber(&part_path, &final_path).await?;
            sync_parent(&final_path).await?;
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
        // The verified file and receipt are durable before the worker mutation
        // on purpose. A crash or transient acknowledgement failure can then be
        // recovered by `reconcile_receipts`; the worker endpoint is idempotent
        // for an already-downloaded image. The renderer must still use the
        // worker manifest's `downloaded` state as proof of acknowledgement.
        self.persist_receipt(&receipt).await?;
        self.acknowledge_receipt(&session, &receipt).await?;
        Ok(receipt)
    }

    async fn acknowledge_receipt(
        &self,
        session: &WorkerSessionPin,
        receipt: &DownloadReceipt,
    ) -> NativeResult<()> {
        let acknowledgement = self
            .worker
            .acknowledge_with_pin(
                session,
                receipt.batch_id,
                receipt.index,
                &receipt.sha256,
                receipt.size_bytes,
            )
            .await?;
        if !(200..300).contains(&acknowledgement.status) {
            return Err(worker_acknowledgement_error(&acknowledgement.body));
        }
        Ok(())
    }

    async fn download_to_part(
        &self,
        session: &WorkerSessionPin,
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
            let url = session.endpoint(&format!(
                "/v1/batches/{}/artifacts/{}",
                request.batch_id, request.index
            ))?;
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
                != Some("image/jpeg")
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

            let mut output = secure_open_write(part_path, append).await?;
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
        ensure_relative_directory(&self.destination, &receipt_dir_relative).await?;
        let receipt_dir = self.destination.confine(&receipt_dir_relative)?;
        let receipt_path = receipt_dir.join(format!("{:06}.json", receipt.index));
        reject_symlink(&receipt_path)?;
        if receipt_path.is_file() {
            let mut existing_file = secure_open_read(&receipt_path).await?;
            let existing = read_bounded_receipt(&mut existing_file)
                .await
                .map_err(|_| receipt_conflict_error())?;
            let stored: DownloadReceipt =
                serde_json::from_slice(&existing).map_err(|_| receipt_conflict_error())?;
            let stored_filename = receipt_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            let mapped_folder = self
                .destination
                .resolve_existing_batch_folder(receipt.batch_id)?;
            if truthful_stored_receipt(
                &stored,
                receipt.batch_id,
                stored_filename,
                mapped_folder.as_deref(),
            )
            .is_ok_and(|truthful| {
                truthful.index == receipt.index
                    && truthful.filename == receipt.filename
                    && truthful.sha256 == receipt.sha256
                    && truthful.size_bytes == receipt.size_bytes
            }) {
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
            move_no_replace_async(temporary.clone(), receipt_path.clone()).await?;
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
        sync_parent(&receipt_path).await?;
        Ok(())
    }

    pub async fn read_receipt_ledger(
        &self,
        batch_id: Uuid,
        batch_name: Option<&str>,
    ) -> NativeResult<ReceiptLedger> {
        let _guard = self.io_lock.lock().await;
        if let Some(batch_name) = batch_name {
            self.destination
                .resolve_batch_folder(batch_id, batch_name)?;
        }
        self.read_verified_receipts(batch_id).await
    }

    pub async fn reconcile_receipts(&self, batch_id: Uuid) -> NativeResult<ReceiptLedger> {
        let _guard = self.io_lock.lock().await;
        let session = self.worker.session().pin().await?;
        let ledger = self.read_verified_receipts(batch_id).await?;
        for receipt in &ledger.receipts {
            self.acknowledge_receipt(&session, receipt).await?;
        }
        Ok(ledger)
    }

    pub async fn read_local_artifact(
        &self,
        batch_id: Uuid,
        index: u64,
    ) -> NativeResult<LocalArtifactResponse> {
        validate_index(index)?;
        let _guard = self.io_lock.lock().await;
        let receipt = self.read_receipt(batch_id, index).await?;
        let bytes = read_verified_destination_file(
            &self.destination,
            Path::new(&receipt.filename),
            receipt.size_bytes,
            &receipt.sha256,
            None,
        )
        .await
        .map_err(|_| receipt_ledger_invalid())?;
        Ok(LocalArtifactResponse {
            content_type: "image/jpeg",
            sha256: receipt.sha256,
            size_bytes: receipt.size_bytes,
            bytes,
        })
    }

    pub async fn read_export_artifact(
        &self,
        request: &ExportArtifactRequest,
    ) -> NativeResult<(String, LocalArtifactResponse)> {
        validate_index(request.index)?;
        validate_checksum(&request.checksum)?;
        let artifact = self
            .read_local_artifact(request.batch_id, request.index)
            .await?;
        if artifact.sha256 != request.checksum {
            return Err(NativeError::new(
                "local_artifact_mismatch",
                "The selected image no longer matches the local library entry.",
            ));
        }
        Ok((
            friendly_export_filename(&request.batch_name, request.index),
            artifact,
        ))
    }

    async fn read_receipt(&self, batch_id: Uuid, index: u64) -> NativeResult<DownloadReceipt> {
        let mapped_folder = self.destination.resolve_existing_batch_folder(batch_id)?;
        let relative = PathBuf::from(".imageforge")
            .join("receipts")
            .join(batch_id.to_string())
            .join(format!("{index:06}.json"));
        let root = self.destination.current()?;
        reject_symlink_chain(&root, &relative)?;
        let receipt_path = self.destination.confine(&relative)?;
        let mut receipt_file = secure_open_read(&receipt_path).await.map_err(|error| {
            if error.code == "destination_missing" {
                local_artifact_unavailable()
            } else {
                error
            }
        })?;
        let encoded = read_bounded_receipt(&mut receipt_file).await?;
        reject_symlink_chain(&root, &relative)?;
        let stored: DownloadReceipt =
            serde_json::from_slice(&encoded).map_err(|_| receipt_ledger_invalid())?;
        let receipt = truthful_stored_receipt(
            &stored,
            batch_id,
            &format!("{index:06}.json"),
            mapped_folder.as_deref(),
        )?;
        Ok(receipt)
    }

    async fn read_verified_receipts(&self, batch_id: Uuid) -> NativeResult<ReceiptLedger> {
        let mapped_folder = self.destination.resolve_existing_batch_folder(batch_id)?;
        let relative = PathBuf::from(".imageforge")
            .join("receipts")
            .join(batch_id.to_string());
        let directory = self.destination.confine(&relative)?;
        reject_symlink_chain(&self.destination.current()?, &relative)?;
        let mut receipts = Vec::new();
        let mut entries = match tokio::fs::read_dir(&directory).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ReceiptLedger {
                    schema_version: 1,
                    batch_id,
                    receipts,
                });
            }
            Err(_) => return Err(destination_io_error()),
        };
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|_| destination_io_error())?
        {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                return Err(receipt_ledger_invalid());
            };
            if !is_receipt_filename(name) {
                continue;
            }
            let path = entry.path();
            reject_symlink(&path)?;
            let mut receipt_file = secure_open_read(&path).await?;
            let encoded = read_bounded_receipt(&mut receipt_file).await?;
            reject_symlink_chain(&self.destination.current()?, &relative.join(name))?;
            let stored: DownloadReceipt =
                serde_json::from_slice(&encoded).map_err(|_| receipt_ledger_invalid())?;
            let receipt =
                truthful_stored_receipt(&stored, batch_id, name, mapped_folder.as_deref())?;
            read_verified_destination_file(
                &self.destination,
                Path::new(&receipt.filename),
                receipt.size_bytes,
                &receipt.sha256,
                None,
            )
            .await
            .map_err(|_| receipt_ledger_invalid())?;
            receipts.push(receipt);
        }
        receipts.sort_by_key(|receipt| receipt.index);
        Ok(ReceiptLedger {
            schema_version: 1,
            batch_id,
            receipts,
        })
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
    if !is_supported_dimensions((
        request.expected_width as u16,
        request.expected_height as u16,
    )) || request.expected_width > u16::MAX as u32
        || request.expected_height > u16::MAX as u32
    {
        return Err(NativeError::new(
            "download_dimensions_invalid",
            "The worker returned unsupported render dimensions.",
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
    validate_content_range_value(raw, expected_start, expected_total)
}

fn validate_content_range_value(
    raw: &str,
    expected_start: u64,
    expected_total: u64,
) -> NativeResult<()> {
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
    if start != expected_start
        || total != expected_total
        || end.checked_add(1) != Some(total)
        || start > end
    {
        return Err(NativeError::new(
            "download_metadata_mismatch",
            "The worker returned a different JPEG byte range than requested.",
        ));
    }
    Ok(())
}

async fn file_size(path: &Path) -> NativeResult<u64> {
    match secure_open_read(path).await {
        Ok(file) => {
            let metadata = file.metadata().await.map_err(|_| destination_io_error())?;
            if metadata.is_file() {
                Ok(metadata.len())
            } else {
                Err(NativeError::new(
                    "destination_conflict",
                    "A non-file entry occupies the JPEG download slot.",
                ))
            }
        }
        Err(error) if error.code == "destination_missing" => Ok(0),
        Err(error) if error.code == "destination_path_rejected" => Err(error),
        Err(_) => Err(NativeError::new(
            "destination_conflict",
            "A non-file entry occupies the JPEG download slot.",
        )),
    }
}

async fn truncate(path: &Path) -> NativeResult<()> {
    let file = secure_open_write(path, false).await?;
    file.sync_all().await.map_err(|_| destination_io_error())
}

async fn read_bounded_receipt(file: &mut tokio::fs::File) -> NativeResult<Vec<u8>> {
    let length = file
        .metadata()
        .await
        .map_err(|_| destination_io_error())?
        .len();
    if length == 0 || length > MAX_RECEIPT_BYTES {
        return Err(receipt_ledger_invalid());
    }
    let mut encoded = Vec::with_capacity(length as usize);
    file.take(MAX_RECEIPT_BYTES + 1)
        .read_to_end(&mut encoded)
        .await
        .map_err(|_| destination_io_error())?;
    if encoded.len() as u64 > MAX_RECEIPT_BYTES {
        return Err(receipt_ledger_invalid());
    }
    Ok(encoded)
}

async fn read_verified_destination_file(
    destination: &DestinationStore,
    relative: &Path,
    expected_size: u64,
    expected_sha256: &str,
    expected_dimensions: Option<(u32, u32)>,
) -> NativeResult<Vec<u8>> {
    if expected_size == 0 || expected_size > MAX_JPEG_BYTES {
        return Err(receipt_ledger_invalid());
    }
    let root = destination.current()?;
    reject_symlink_chain(&root, relative)?;
    let path = destination.confine(relative)?;
    let file = secure_open_read(&path).await?;
    // Recheck the full parent chain after opening. If an attacker substituted
    // a symlink/junction between preflight and open, the pinned file is never
    // returned to the renderer.
    reject_symlink_chain(&root, relative)?;
    let metadata = file.metadata().await.map_err(|_| destination_io_error())?;
    if !metadata.is_file() || metadata.len() != expected_size {
        return Err(NativeError::new(
            "download_checksum_mismatch",
            "The local JPEG byte count did not match its receipt.",
        ));
    }
    let mut bytes = Vec::with_capacity(expected_size as usize);
    file.take(expected_size + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| destination_io_error())?;
    verify_jpeg_bytes(&bytes, expected_size, expected_sha256, expected_dimensions)?;
    reject_symlink_chain(&root, relative)?;
    Ok(bytes)
}

async fn verify_file(
    path: &Path,
    expected_size: u64,
    expected_sha256: &str,
    expected_dimensions: Option<(u32, u32)>,
) -> NativeResult<()> {
    if expected_size == 0 || expected_size > MAX_JPEG_BYTES {
        return Err(NativeError::new(
            "download_checksum_mismatch",
            "The local JPEG byte count did not match its receipt.",
        ));
    }
    let file = secure_open_read(path).await?;
    let metadata = file.metadata().await.map_err(|_| destination_io_error())?;
    if !metadata.is_file() || metadata.len() != expected_size {
        return Err(NativeError::new(
            "download_checksum_mismatch",
            "The local JPEG byte count did not match its receipt.",
        ));
    }
    let mut bytes = Vec::with_capacity(expected_size as usize);
    file.take(expected_size + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| destination_io_error())?;
    verify_jpeg_bytes(&bytes, expected_size, expected_sha256, expected_dimensions)
}

fn verify_jpeg_bytes(
    bytes: &[u8],
    expected_size: u64,
    expected_sha256: &str,
    expected_dimensions: Option<(u32, u32)>,
) -> NativeResult<()> {
    if bytes.len() as u64 != expected_size {
        return Err(NativeError::new(
            "download_checksum_mismatch",
            "The local JPEG byte count did not match its receipt.",
        ));
    }
    if hex::encode(Sha256::digest(bytes)) != expected_sha256 {
        return Err(NativeError::new(
            "download_checksum_mismatch",
            "The local JPEG checksum did not match its receipt.",
        ));
    }
    let Some((width, height)) = jpeg_dimensions(bytes) else {
        return Err(NativeError::new(
            "download_jpeg_invalid",
            "The downloaded file is not a structurally valid JPEG.",
        ));
    };
    let dimensions = (width as u32, height as u32);
    if !is_supported_dimensions((width, height))
        || expected_dimensions.is_some_and(|expected| expected != dimensions)
    {
        return Err(NativeError::new(
            "download_dimensions_invalid",
            "The downloaded file does not match the selected render dimensions.",
        ));
    }
    Ok(())
}

async fn secure_open_read(path: &Path) -> NativeResult<tokio::fs::File> {
    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    apply_no_follow(&mut options);
    match options.open(path).await {
        Ok(file) => {
            reject_open_reparse(&file).await?;
            Ok(file)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(NativeError::new(
            "destination_missing",
            "The requested destination file does not exist.",
        )),
        Err(error) if is_link_error(&error) => Err(NativeError::new(
            "destination_path_rejected",
            "ImageForge will not read or write through a link.",
        )),
        Err(_) => Err(destination_io_error()),
    }
}

async fn secure_open_write(path: &Path, append: bool) -> NativeResult<tokio::fs::File> {
    let mut options = tokio::fs::OpenOptions::new();
    options
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append);
    apply_no_follow(&mut options);
    let file = options.open(path).await.map_err(|error| {
        if is_link_error(&error) {
            NativeError::new(
                "destination_path_rejected",
                "ImageForge will not read or write through a link.",
            )
        } else {
            destination_io_error()
        }
    })?;
    reject_open_reparse(&file).await?;
    Ok(file)
}

fn apply_no_follow(options: &mut tokio::fs::OpenOptions) {
    #[cfg(unix)]
    {
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
}

async fn reject_open_reparse(file: &tokio::fs::File) -> NativeResult<()> {
    let metadata = file.metadata().await.map_err(|_| destination_io_error())?;
    if !metadata.is_file() {
        return Err(NativeError::new(
            "destination_path_rejected",
            "The destination entry is not a regular file.",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(NativeError::new(
                "destination_path_rejected",
                "ImageForge will not read or write through a reparse point.",
            ));
        }
    }
    Ok(())
}

fn is_link_error(error: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(libc::ELOOP)
    }
    #[cfg(not(unix))]
    {
        let _ = error;
        false
    }
}

async fn install_no_clobber(part_path: &Path, final_path: &Path) -> NativeResult<()> {
    match move_no_replace_async(part_path.to_path_buf(), final_path.to_path_buf()).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(NativeError::new(
            "destination_conflict",
            "A numbered JPEG already exists in this destination; nothing was overwritten.",
        )),
        Err(_) => Err(NativeError::new(
            "download_finalize_failed",
            "The verified JPEG could not be atomically installed without overwriting a file.",
        )),
    }
}

async fn move_no_replace_async(source: PathBuf, destination: PathBuf) -> std::io::Result<()> {
    tokio::task::spawn_blocking(move || move_no_replace(&source, &destination))
        .await
        .map_err(|_| std::io::Error::other("native no-replace move task failed"))?
}

#[cfg(target_os = "macos")]
fn move_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // `RENAME_EXCL` is a same-volume atomic move that fails if the destination
    // exists. Unlike hard links it is supported by removable FAT/exFAT media.
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn move_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // Omitting MOVEFILE_REPLACE_EXISTING is the required atomic no-clobber
    // behavior and works on NTFS, FAT, and exFAT destinations.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn move_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn move_no_replace(_source: &Path, _destination: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "atomic no-replace move is unsupported on this development platform",
    ))
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u16, u16)> {
    if bytes.len() < 4 || !bytes.starts_with(&[0xff, 0xd8]) || !bytes.ends_with(&[0xff, 0xd9]) {
        return None;
    }
    let mut position = 2_usize;
    while position + 1 < bytes.len() {
        if bytes[position] != 0xff {
            return None;
        }
        while position < bytes.len() && bytes[position] == 0xff {
            position += 1;
        }
        let marker = *bytes.get(position)?;
        position += 1;
        if marker == 0xd9 {
            return None;
        }
        if marker == 0x01 || (0xd0..=0xd8).contains(&marker) {
            continue;
        }
        let length =
            u16::from_be_bytes([*bytes.get(position)?, *bytes.get(position + 1)?]) as usize;
        if length < 2 || position.checked_add(length)? > bytes.len() {
            return None;
        }
        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) {
            if length < 7 {
                return None;
            }
            let height = u16::from_be_bytes([bytes[position + 3], bytes[position + 4]]);
            let width = u16::from_be_bytes([bytes[position + 5], bytes[position + 6]]);
            return Some((width, height));
        }
        if marker == 0xda {
            return None;
        }
        position += length;
    }
    None
}

fn is_supported_dimensions(dimensions: (u16, u16)) -> bool {
    matches!(
        dimensions,
        (1280, 720) | (1024, 1024) | (720, 1280) | (1152, 864) | (864, 1152)
    )
}

async fn reject_file_secret_reflection(path: &Path, secrets: &[String]) -> NativeResult<()> {
    let mut file = secure_open_read(path).await?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .await
        .map_err(|_| destination_io_error())?;
    if secrets.iter().any(|secret| {
        !secret.is_empty()
            && bytes
                .windows(secret.len())
                .any(|window| window == secret.as_bytes())
    }) {
        return Err(NativeError::new(
            "worker_secret_reflection",
            "The worker artifact was rejected because it exposed saved credential material.",
        ));
    }
    Ok(())
}

fn is_receipt_filename(name: &str) -> bool {
    name.len() == 11
        && name.ends_with(".json")
        && name[..6].bytes().all(|byte| byte.is_ascii_digit())
}

fn truthful_stored_receipt(
    receipt: &DownloadReceipt,
    expected_batch_id: Uuid,
    ledger_filename: &str,
    mapped_folder: Option<&str>,
) -> NativeResult<DownloadReceipt> {
    validate_index(receipt.index)?;
    validate_checksum(&receipt.sha256)?;
    let legacy_filename = format!("batches/{}/{:06}.jpg", expected_batch_id, receipt.index);
    let mapped_filename =
        mapped_folder.map(|folder| format!("batches/{folder}/{:06}.jpg", receipt.index));
    let stored_filename_is_valid = receipt.filename == legacy_filename
        || mapped_filename
            .as_ref()
            .is_some_and(|expected| receipt.filename == *expected);
    if receipt.schema_version != 1
        || receipt.batch_id != expected_batch_id
        || receipt.size_bytes == 0
        || receipt.size_bytes > MAX_JPEG_BYTES
        || !stored_filename_is_valid
        || ledger_filename != format!("{:06}.json", receipt.index)
    {
        return Err(receipt_ledger_invalid());
    }
    let mut truthful = receipt.clone();
    truthful.filename = mapped_filename.unwrap_or(legacy_filename);
    Ok(truthful)
}

fn receipt_ledger_invalid() -> NativeError {
    NativeError::new(
        "receipt_ledger_invalid",
        "A local receipt or its final JPEG is missing, invalid, or inconsistent.",
    )
}

fn destination_durability_error() -> NativeError {
    NativeError::retryable(
        "destination_durability_failed",
        "The downloads folder could not confirm durable storage; no receipt was acknowledged.",
    )
}

fn reject_symlink(path: &Path) -> NativeResult<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(NativeError::new(
                    "destination_path_rejected",
                    "ImageForge will not write through a symbolic link.",
                ));
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
                if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    return Err(NativeError::new(
                        "destination_path_rejected",
                        "ImageForge will not use a filesystem reparse point.",
                    ));
                }
            }
            Ok(())
        }
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

async fn sync_parent(path: &Path) -> NativeResult<()> {
    if let Some(parent) = path.parent() {
        let parent = parent.to_path_buf();
        tokio::task::spawn_blocking(move || sync_directory_blocking(&parent))
            .await
            .map_err(|_| destination_durability_error())?
            .map_err(|_| destination_durability_error())?;
    }
    Ok(())
}

fn sync_directory_blocking(directory: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        // Windows has no portable directory fsync. Receipt files are synced
        // individually, and callers use write-through atomic replacement.
        let _ = directory;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::fs::File::open(directory)?.sync_all()
    }
}

async fn sync_directory_chain(root: &Path, relative: &Path) -> NativeResult<()> {
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
        sync_parent(&current).await?;
    }
    Ok(())
}

async fn ensure_relative_directory(
    destination: &DestinationStore,
    relative: &Path,
) -> NativeResult<PathBuf> {
    let root = destination.current()?;
    reject_symlink_chain(&root, relative)?;
    let directory = destination.confine(relative)?;
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|_| destination_io_error())?;
    // Recheck after creation so a concurrently substituted link is never
    // accepted as a destination or receipt directory.
    reject_symlink_chain(&root, relative)?;
    sync_directory_chain(&root, relative).await?;
    Ok(directory)
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

fn friendly_export_filename(batch_name: &str, index: u64) -> String {
    let batch_name = sanitize_batch_folder_name(batch_name);
    format!("{batch_name} - {index:03}.jpg")
}

pub(crate) fn write_export_file(path: &Path, bytes: &[u8]) -> NativeResult<()> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_JPEG_BYTES || jpeg_dimensions(bytes).is_none() {
        return Err(NativeError::new(
            "export_artifact_invalid",
            "The selected ImageForge image is not a valid exportable JPEG.",
        ));
    }
    let parent = path.parent().ok_or_else(export_write_error)?;
    if !parent.is_dir() || path.file_name().is_none() {
        return Err(export_write_error());
    }
    reject_symlink(parent)?;
    reject_symlink(path)?;
    let temporary = parent.join(format!(".imageforge-export-{}.part", Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        move_path_no_replace(&temporary, path)?;
        sync_directory_blocking(parent)?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            return Err(export_collision_error());
        }
        return Err(export_write_error());
    }
    Ok(())
}

fn destination_io_error() -> NativeError {
    NativeError::new(
        "destination_write_failed",
        "ImageForge could not safely update the selected downloads folder.",
    )
}

fn local_artifact_unavailable() -> NativeError {
    NativeError::new(
        "local_artifact_unavailable",
        "This image is not available in the verified local library yet.",
    )
}

fn export_write_error() -> NativeError {
    NativeError::new(
        "export_write_failed",
        "The image copy could not be saved to the selected location.",
    )
}

fn export_collision_error() -> NativeError {
    NativeError::new(
        "export_collision",
        "A file already exists at the selected export location. Choose another name.",
    )
}

fn receipt_conflict_error() -> NativeError {
    NativeError::new(
        "receipt_conflict",
        "An existing local receipt is unreadable; no file was overwritten.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::vault::MemoryVault;
    use crate::native::{CredentialVault, WorkerSession};

    fn test_downloader(destination: DestinationStore) -> Downloader {
        let vault: Arc<dyn CredentialVault> = Arc::new(MemoryVault::default());
        let worker = WorkerApi::new(vault, WorkerSession::default()).unwrap();
        Downloader::new(worker, destination)
    }

    #[tokio::test]
    async fn verifies_size_sha256_and_every_approved_render_dimension() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("000001.jpg.part");
        for dimensions in [
            (1280, 720),
            (1024, 1024),
            (720, 1280),
            (1152, 864),
            (864, 1152),
        ] {
            let jpeg = structural_jpeg(dimensions.0, dimensions.1);
            tokio::fs::write(&path, &jpeg).await.unwrap();
            let checksum = hex::encode(Sha256::digest(&jpeg));
            verify_file(
                &path,
                jpeg.len() as u64,
                &checksum,
                Some((dimensions.0 as u32, dimensions.1 as u32)),
            )
            .await
            .unwrap();
            if dimensions != (1280, 720) {
                assert_eq!(
                    verify_file(&path, jpeg.len() as u64, &checksum, Some((1280, 720)))
                        .await
                        .unwrap_err()
                        .code,
                    "download_dimensions_invalid"
                );
            }
        }
        let jpeg = structural_jpeg(1280, 720);
        tokio::fs::write(&path, &jpeg).await.unwrap();
        let checksum = hex::encode(Sha256::digest(&jpeg));
        assert_eq!(
            verify_file(&path, (jpeg.len() - 1) as u64, &checksum, Some((1280, 720)))
                .await
                .unwrap_err()
                .code,
            "download_checksum_mismatch"
        );
        assert_eq!(
            verify_file(&path, jpeg.len() as u64, &"0".repeat(64), Some((1280, 720)))
                .await
                .unwrap_err()
                .code,
            "download_checksum_mismatch"
        );
    }

    #[tokio::test]
    async fn artifact_secret_reflection_is_rejected_even_when_wrapped_in_binary_data() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("artifact.jpg.part");
        let secret = "worker-secret-exact".to_owned();
        tokio::fs::write(&path, format!("binary-prefix-{secret}-binary-suffix"))
            .await
            .unwrap();
        assert_eq!(
            reject_file_secret_reflection(&path, &[secret])
                .await
                .unwrap_err()
                .code,
            "worker_secret_reflection"
        );
    }

    #[test]
    fn jpeg_structure_requires_exact_magic_and_dimensions() {
        assert_eq!(
            jpeg_dimensions(&structural_jpeg(1280, 720)),
            Some((1280, 720))
        );
        assert_eq!(
            jpeg_dimensions(&structural_jpeg(1279, 720)),
            Some((1279, 720))
        );
        assert!(is_supported_dimensions((1024, 1024)));
        assert!(is_supported_dimensions((720, 1280)));
        assert!(is_supported_dimensions((1152, 864)));
        assert!(is_supported_dimensions((864, 1152)));
        assert!(!is_supported_dimensions((1279, 720)));
        let mut missing_eoi = structural_jpeg(1280, 720);
        missing_eoi.pop();
        assert_eq!(jpeg_dimensions(&missing_eoi), None);
    }

    fn structural_jpeg(width: u16, height: u16) -> Vec<u8> {
        let [height_high, height_low] = height.to_be_bytes();
        let [width_high, width_low] = width.to_be_bytes();
        vec![
            0xff,
            0xd8,
            0xff,
            0xc0,
            0x00,
            0x07,
            0x08,
            height_high,
            height_low,
            width_high,
            width_low,
            0xff,
            0xd9,
        ]
    }

    #[test]
    fn download_contract_rejects_oversized_or_malformed_artifacts() {
        let batch_id = Uuid::new_v4();
        let valid = DownloadRequest {
            batch_id,
            batch_name: Some("Atlas of Quiet Work".into()),
            index: 1,
            expected_sha256: "a".repeat(64),
            expected_size_bytes: 1024,
            expected_width: 1280,
            expected_height: 720,
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
        assert_eq!(
            validate_download_request(&DownloadRequest {
                expected_width: 123,
                ..valid
            })
            .unwrap_err()
            .code,
            "download_dimensions_invalid"
        );
    }

    #[test]
    fn content_range_overflow_is_rejected_without_panicking() {
        assert_eq!(
            validate_content_range_value(
                "bytes 1-18446744073709551615/18446744073709551615",
                1,
                u64::MAX,
            )
            .unwrap_err()
            .code,
            "download_metadata_mismatch"
        );
    }

    #[tokio::test]
    async fn final_install_never_clobbers_an_existing_file() {
        let temporary = tempfile::tempdir().unwrap();
        let part = temporary.path().join("part");
        let final_path = temporary.path().join("final");
        tokio::fs::write(&part, b"new").await.unwrap();
        tokio::fs::write(&final_path, b"existing").await.unwrap();
        assert_eq!(
            install_no_clobber(&part, &final_path)
                .await
                .unwrap_err()
                .code,
            "destination_conflict"
        );
        assert_eq!(tokio::fs::read(final_path).await.unwrap(), b"existing");
        assert_eq!(tokio::fs::read(part).await.unwrap(), b"new");
    }

    #[tokio::test]
    async fn removable_volume_uses_atomic_no_replace_move_when_requested() {
        let Some(root) = std::env::var_os("IMAGEFORGE_REMOVABLE_TEST_ROOT") else {
            return;
        };
        let directory =
            PathBuf::from(root).join(format!(".imageforge-no-replace-test-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let downloads = directory.join("downloads");
        std::fs::create_dir(&downloads).unwrap();
        let destination_store =
            DestinationStore::new_for_test(directory.join("state").join("destination.json"));
        destination_store.validate_and_bind(&downloads).unwrap();
        let batch_id = Uuid::new_v4();
        let batch_directory = ensure_relative_directory(
            &destination_store,
            &PathBuf::from("batches").join(batch_id.to_string()),
        )
        .await
        .unwrap();
        let source = batch_directory.join("source.part");
        let destination = batch_directory.join("destination.jpg");
        tokio::fs::write(&source, b"first").await.unwrap();
        install_no_clobber(&source, &destination).await.unwrap();
        assert!(!source.exists());
        assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"first");

        tokio::fs::write(&source, b"second").await.unwrap();
        assert_eq!(
            install_no_clobber(&source, &destination)
                .await
                .unwrap_err()
                .code,
            "destination_conflict"
        );
        assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"first");
        assert_eq!(tokio::fs::read(&source).await.unwrap(), b"second");
        std::fs::remove_file(source).unwrap();
        std::fs::remove_file(destination).unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn batch_scoped_receipt_ledger_survives_restart_without_filename_collisions() {
        let temporary = tempfile::tempdir().unwrap();
        let destination_path = temporary.path().join("downloads");
        let record_path = temporary.path().join("state").join("destination.json");
        std::fs::create_dir(&destination_path).unwrap();
        let destination = DestinationStore::new_for_test(record_path.clone());
        destination.validate_and_bind(&destination_path).unwrap();
        let downloader = test_downloader(destination);
        let batch_id = Uuid::new_v4();
        let batch_relative = PathBuf::from("batches").join(batch_id.to_string());
        let batch_directory = ensure_relative_directory(&downloader.destination, &batch_relative)
            .await
            .unwrap();
        let jpeg = structural_jpeg(1280, 720);
        let sha256 = hex::encode(Sha256::digest(&jpeg));
        tokio::fs::write(batch_directory.join("000001.jpg"), &jpeg)
            .await
            .unwrap();
        let receipt = DownloadReceipt {
            schema_version: 1,
            batch_id,
            index: 1,
            filename: format!("batches/{batch_id}/000001.jpg"),
            sha256,
            size_bytes: jpeg.len() as u64,
            verified_at_unix_ms: 1,
        };
        downloader.persist_receipt(&receipt).await.unwrap();
        assert_eq!(
            downloader
                .read_receipt_ledger(batch_id, None)
                .await
                .unwrap()
                .receipts,
            vec![receipt.clone()]
        );

        let restored_destination = DestinationStore::new_for_test(record_path);
        restored_destination.restore().unwrap().unwrap();
        let restarted = test_downloader(restored_destination);
        assert_eq!(
            restarted
                .read_receipt_ledger(batch_id, None)
                .await
                .unwrap()
                .receipts,
            vec![receipt]
        );
    }

    #[tokio::test]
    async fn legacy_receipts_follow_the_named_mapping_without_rewriting_the_ledger() {
        let temporary = tempfile::tempdir().unwrap();
        let destination_path = temporary.path().join("downloads");
        let record_path = temporary.path().join("state").join("destination.json");
        std::fs::create_dir(&destination_path).unwrap();
        let destination = DestinationStore::new_for_test(record_path.clone());
        destination.validate_and_bind(&destination_path).unwrap();
        let downloader = test_downloader(destination);
        let batch_id = Uuid::new_v4();
        let legacy_relative = PathBuf::from("batches").join(batch_id.to_string());
        let legacy_directory = ensure_relative_directory(&downloader.destination, &legacy_relative)
            .await
            .unwrap();
        let jpeg = structural_jpeg(1280, 720);
        let sha256 = hex::encode(Sha256::digest(&jpeg));
        tokio::fs::write(legacy_directory.join("000001.jpg"), &jpeg)
            .await
            .unwrap();
        let legacy_receipt = DownloadReceipt {
            schema_version: 1,
            batch_id,
            index: 1,
            filename: format!("batches/{batch_id}/000001.jpg"),
            sha256: sha256.clone(),
            size_bytes: jpeg.len() as u64,
            verified_at_unix_ms: 1,
        };
        downloader.persist_receipt(&legacy_receipt).await.unwrap();

        let prepared = downloader
            .read_receipt_ledger(batch_id, Some("Atlas of Quiet Work"))
            .await
            .unwrap();
        assert_eq!(prepared.receipts.len(), 1);
        let named_directory = destination_path.join("batches").join("Atlas of Quiet Work");
        assert!(named_directory.join("000001.jpg").is_file());
        assert!(!legacy_directory.exists());

        tokio::fs::write(named_directory.join("000002.jpg"), &jpeg)
            .await
            .unwrap();
        let named_receipt = DownloadReceipt {
            schema_version: 1,
            batch_id,
            index: 2,
            filename: "batches/Atlas of Quiet Work/000002.jpg".into(),
            sha256,
            size_bytes: jpeg.len() as u64,
            verified_at_unix_ms: 2,
        };
        downloader.persist_receipt(&named_receipt).await.unwrap();

        let ledger = downloader
            .read_receipt_ledger(batch_id, None)
            .await
            .unwrap();
        assert_eq!(
            ledger
                .receipts
                .iter()
                .map(|receipt| receipt.filename.as_str())
                .collect::<Vec<_>>(),
            vec![
                "batches/Atlas of Quiet Work/000001.jpg",
                "batches/Atlas of Quiet Work/000002.jpg"
            ]
        );
        let stored_legacy: DownloadReceipt = serde_json::from_slice(
            &tokio::fs::read(
                destination_path
                    .join(".imageforge")
                    .join("receipts")
                    .join(batch_id.to_string())
                    .join("000001.json"),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(stored_legacy.filename, legacy_receipt.filename);

        let restored_destination = DestinationStore::new_for_test(record_path);
        restored_destination.restore().unwrap().unwrap();
        let restarted = test_downloader(restored_destination);
        assert_eq!(
            restarted
                .read_receipt_ledger(batch_id, None)
                .await
                .unwrap()
                .receipts
                .iter()
                .map(|receipt| receipt.filename.as_str())
                .collect::<Vec<_>>(),
            vec![
                "batches/Atlas of Quiet Work/000001.jpg",
                "batches/Atlas of Quiet Work/000002.jpg"
            ]
        );
    }

    #[tokio::test]
    async fn local_artifact_read_and_export_are_bound_to_the_verified_receipt() {
        let temporary = tempfile::tempdir().unwrap();
        let destination_path = temporary.path().join("downloads");
        std::fs::create_dir(&destination_path).unwrap();
        let destination =
            DestinationStore::new_for_test(temporary.path().join("state").join("destination.json"));
        destination.validate_and_bind(&destination_path).unwrap();
        let downloader = test_downloader(destination);
        let batch_id = Uuid::new_v4();
        let folder = downloader
            .destination
            .resolve_batch_folder(batch_id, "Atlas of Quiet Work")
            .unwrap();
        let jpeg = structural_jpeg(1024, 1024);
        let sha256 = hex::encode(Sha256::digest(&jpeg));
        let filename = format!("batches/{folder}/000013.jpg");
        tokio::fs::write(
            downloader
                .destination
                .confine(Path::new(&filename))
                .unwrap(),
            &jpeg,
        )
        .await
        .unwrap();
        downloader
            .persist_receipt(&DownloadReceipt {
                schema_version: 1,
                batch_id,
                index: 13,
                filename: filename.clone(),
                sha256: sha256.clone(),
                size_bytes: jpeg.len() as u64,
                verified_at_unix_ms: 1,
            })
            .await
            .unwrap();

        let local = downloader.read_local_artifact(batch_id, 13).await.unwrap();
        assert_eq!(local.content_type, "image/jpeg");
        assert_eq!(local.sha256, sha256);
        assert_eq!(local.bytes, jpeg);

        let (suggested, export) = downloader
            .read_export_artifact(&ExportArtifactRequest {
                batch_id,
                index: 13,
                batch_name: "Atlas of Quiet Work".into(),
                checksum: sha256.clone(),
            })
            .await
            .unwrap();
        assert_eq!(suggested, "Atlas of Quiet Work - 013.jpg");
        let exported_path = temporary.path().join(&suggested);
        write_export_file(&exported_path, &export.bytes).unwrap();
        assert_eq!(std::fs::read(&exported_path).unwrap(), jpeg);
        assert_eq!(
            write_export_file(&exported_path, &export.bytes)
                .unwrap_err()
                .code,
            "export_collision"
        );
        assert_eq!(std::fs::read(&exported_path).unwrap(), jpeg);

        assert_eq!(
            downloader
                .read_export_artifact(&ExportArtifactRequest {
                    batch_id,
                    index: 13,
                    batch_name: "Atlas of Quiet Work".into(),
                    checksum: "f".repeat(64),
                })
                .await
                .unwrap_err()
                .code,
            "local_artifact_mismatch"
        );

        let mut tampered = jpeg.clone();
        tampered[8] ^= 1;
        assert_eq!(tampered.len(), jpeg.len());
        tokio::fs::write(
            downloader
                .destination
                .confine(Path::new(&filename))
                .unwrap(),
            tampered,
        )
        .await
        .unwrap();
        assert_eq!(
            downloader
                .read_local_artifact(batch_id, 13)
                .await
                .unwrap_err()
                .code,
            "receipt_ledger_invalid"
        );
    }

    #[tokio::test]
    async fn oversized_receipt_is_rejected_before_json_parsing() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("receipt.json");
        tokio::fs::write(&path, vec![b' '; MAX_RECEIPT_BYTES as usize + 1])
            .await
            .unwrap();
        let mut file = tokio::fs::File::open(path).await.unwrap();
        assert_eq!(
            read_bounded_receipt(&mut file).await.unwrap_err().code,
            "receipt_ledger_invalid"
        );
    }

    #[tokio::test]
    async fn oversized_existing_receipt_slot_is_rejected_without_rewrite() {
        let temporary = tempfile::tempdir().unwrap();
        let destination_path = temporary.path().join("downloads");
        std::fs::create_dir(&destination_path).unwrap();
        let destination =
            DestinationStore::new_for_test(temporary.path().join("state").join("destination.json"));
        destination.validate_and_bind(&destination_path).unwrap();
        let downloader = test_downloader(destination);
        let batch_id = Uuid::new_v4();
        let receipt_dir = ensure_relative_directory(
            &downloader.destination,
            &PathBuf::from(".imageforge")
                .join("receipts")
                .join(batch_id.to_string()),
        )
        .await
        .unwrap();
        let receipt_path = receipt_dir.join("000001.json");
        let oversized = vec![b' '; MAX_RECEIPT_BYTES as usize + 1];
        tokio::fs::write(&receipt_path, &oversized).await.unwrap();
        let jpeg = structural_jpeg(1024, 1024);
        let receipt = DownloadReceipt {
            schema_version: 1,
            batch_id,
            index: 1,
            filename: format!("batches/{batch_id}/000001.jpg"),
            sha256: hex::encode(Sha256::digest(&jpeg)),
            size_bytes: jpeg.len() as u64,
            verified_at_unix_ms: 1,
        };

        assert_eq!(
            downloader.persist_receipt(&receipt).await.unwrap_err().code,
            "receipt_conflict"
        );
        assert_eq!(tokio::fs::read(receipt_path).await.unwrap(), oversized);
    }

    #[tokio::test]
    async fn existing_receipt_slot_requires_valid_schema_and_filename() {
        let temporary = tempfile::tempdir().unwrap();
        let destination_path = temporary.path().join("downloads");
        let record_path = temporary.path().join("state").join("destination.json");
        std::fs::create_dir(&destination_path).unwrap();
        let destination = DestinationStore::new_for_test(record_path);
        destination.validate_and_bind(&destination_path).unwrap();
        let downloader = test_downloader(destination);
        let batch_id = Uuid::new_v4();
        let receipt_dir = ensure_relative_directory(
            &downloader.destination,
            &PathBuf::from(".imageforge")
                .join("receipts")
                .join(batch_id.to_string()),
        )
        .await
        .unwrap();
        let jpeg = structural_jpeg(1280, 720);
        let receipt = DownloadReceipt {
            schema_version: 1,
            batch_id,
            index: 1,
            filename: format!("batches/{batch_id}/000001.jpg"),
            sha256: hex::encode(Sha256::digest(&jpeg)),
            size_bytes: jpeg.len() as u64,
            verified_at_unix_ms: 1,
        };
        let corrupt = DownloadReceipt {
            schema_version: 2,
            filename: "batches/not-the-bound-batch/000001.jpg".into(),
            ..receipt.clone()
        };
        tokio::fs::write(
            receipt_dir.join("000001.json"),
            serde_json::to_vec(&corrupt).unwrap(),
        )
        .await
        .unwrap();

        assert_eq!(
            downloader.persist_receipt(&receipt).await.unwrap_err().code,
            "receipt_conflict"
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

    #[cfg(unix)]
    #[tokio::test]
    async fn batch_directory_links_are_rejected_before_any_artifact_write() {
        use std::os::unix::fs::symlink;
        let temporary = tempfile::tempdir().unwrap();
        let destination_path = temporary.path().join("downloads");
        let outside = temporary.path().join("outside");
        std::fs::create_dir(&destination_path).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::create_dir(destination_path.join("batches")).unwrap();
        let batch_id = Uuid::new_v4();
        symlink(
            &outside,
            destination_path.join("batches").join(batch_id.to_string()),
        )
        .unwrap();
        let destination = DestinationStore::new_for_test(temporary.path().join("record.json"));
        destination.validate_and_bind(&destination_path).unwrap();
        assert_eq!(
            ensure_relative_directory(
                &destination,
                &PathBuf::from("batches").join(batch_id.to_string()),
            )
            .await
            .unwrap_err()
            .code,
            "destination_path_rejected"
        );
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_artifact_reads_reject_a_symlinked_parent_directory() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let destination_path = temporary.path().join("downloads");
        let outside = temporary.path().join("outside");
        std::fs::create_dir(&destination_path).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::create_dir(destination_path.join("batches")).unwrap();
        let batch_id = Uuid::new_v4();
        let jpeg = structural_jpeg(1024, 1024);
        std::fs::write(outside.join("000001.jpg"), &jpeg).unwrap();
        symlink(
            &outside,
            destination_path.join("batches").join(batch_id.to_string()),
        )
        .unwrap();
        let receipt_directory = destination_path
            .join(".imageforge")
            .join("receipts")
            .join(batch_id.to_string());
        std::fs::create_dir_all(&receipt_directory).unwrap();
        std::fs::write(
            receipt_directory.join("000001.json"),
            serde_json::to_vec(&DownloadReceipt {
                schema_version: 1,
                batch_id,
                index: 1,
                filename: format!("batches/{batch_id}/000001.jpg"),
                sha256: hex::encode(Sha256::digest(&jpeg)),
                size_bytes: jpeg.len() as u64,
                verified_at_unix_ms: 1,
            })
            .unwrap(),
        )
        .unwrap();
        let destination = DestinationStore::new_for_test(temporary.path().join("record.json"));
        destination.validate_and_bind(&destination_path).unwrap();
        let downloader = test_downloader(destination);

        assert_eq!(
            downloader
                .read_local_artifact(batch_id, 1)
                .await
                .unwrap_err()
                .code,
            "receipt_ledger_invalid"
        );
        assert_eq!(std::fs::read(outside.join("000001.jpg")).unwrap(), jpeg);
    }
}
