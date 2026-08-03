import { RunPodClientError, asRunPodClientError } from "./errors.js";
import type { FetchTransport } from "./http.js";
import { WORKER_PHASES, type WorkerHealth, type WorkerHealthProbe } from "./types.js";
import { asBoolean, asNonEmptyString, asNumber, asRecord, asString } from "./validation.js";

const RUNPOD_PROXY_HOST = /^[A-Za-z0-9][A-Za-z0-9-]{0,57}-8000\.proxy\.runpod\.net$/;
const WORKER_SERVICE = "imageforge-worker";
// Keep the desktop contract aligned with the portable worker release.
const WORKER_VERSION = "0.1.3";
const MODEL_ID = "black-forest-labs/FLUX.2-klein-4B";
const MODEL_REVISION = "e7b7dc27f91deacad38e78976d1f2b499d76a294";
const MODEL_PRECISION = "bfloat16";

function healthAborted(): RunPodClientError {
  return new RunPodClientError({
    code: "operation_aborted",
    message: "The worker health request was cancelled.",
    operation: "worker_health",
  });
}

function awaitHealthAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(healthAborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(healthAborted());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

export interface HttpWorkerHealthProbeOptions {
  readonly fetchTransport?: FetchTransport;
}

export class HttpWorkerHealthProbe implements WorkerHealthProbe {
  readonly #fetch: FetchTransport;

  constructor(options: HttpWorkerHealthProbeOptions = {}) {
    this.#fetch = options.fetchTransport ?? fetch;
  }

  async getHealth(proxyUrl: string, signal?: AbortSignal): Promise<WorkerHealth> {
    let endpoint: URL;
    try {
      endpoint = new URL(proxyUrl);
    } catch {
      throw new RunPodClientError({
        code: "api_response_invalid",
        message: "The discovered worker proxy URL is invalid.",
        operation: "worker_health",
      });
    }
    if (
      endpoint.protocol !== "https:" ||
      !RUNPOD_PROXY_HOST.test(endpoint.hostname) ||
      endpoint.port !== "" ||
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      endpoint.pathname !== "/" ||
      endpoint.search !== "" ||
      endpoint.hash !== ""
    ) {
      throw new RunPodClientError({
        code: "api_response_invalid",
        message: "The discovered worker proxy URL is not an allowed RunPod endpoint.",
        operation: "worker_health",
      });
    }

    endpoint.pathname = "/v1/health";
    try {
      const fetchPromise = this.#fetch(endpoint.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      });
      const response = await awaitHealthAbort(fetchPromise, signal);
      if (!response.ok) {
        throw new RunPodClientError({
          code: "api_request_failed",
          message: "The ImageForge worker is not ready to report health.",
          operation: "worker_health",
          retryable: response.status >= 500 || response.status === 404,
          httpStatus: response.status,
          details: { status: response.status },
        });
      }
      let raw: unknown;
      try {
        raw = await awaitHealthAbort(response.json(), signal);
      } catch (error) {
        if (error instanceof RunPodClientError && error.code === "operation_aborted") throw error;
        throw new RunPodClientError({
          code: "api_response_invalid",
          message: "The ImageForge worker returned malformed health data.",
          operation: "worker_health",
          cause: error,
        });
      }
      const health = asRecord(raw, "worker_health");
      const schemaVersion = asNumber(
        health.schema_version,
        "worker_health",
        "response.schema_version",
      );
      const phase = asString(health.phase, "worker_health", "response.phase");
      const service = asNonEmptyString(health.service, "worker_health", "response.service");
      const version = asNonEmptyString(health.version, "worker_health", "response.version");
      const process = asRecord(health.process, "worker_health", "response.process");
      const model = asRecord(health.model, "worker_health", "response.model");
      const gpu = asRecord(health.gpu, "worker_health", "response.gpu");
      if (
        schemaVersion !== 1 ||
        service !== WORKER_SERVICE ||
        version !== WORKER_VERSION ||
        !(WORKER_PHASES as readonly string[]).includes(phase) ||
        asString(process.status, "worker_health", "response.process.status") !== "ok" ||
        asNumber(process.uptime_ms, "worker_health", "response.process.uptime_ms") < 0 ||
        asString(model.id, "worker_health", "response.model.id") !== MODEL_ID ||
        asString(model.revision, "worker_health", "response.model.revision") !== MODEL_REVISION ||
        asString(model.precision, "worker_health", "response.model.precision") !== MODEL_PRECISION
      ) {
        throw new RunPodClientError({
          code: "api_response_invalid",
          message: "The ImageForge worker returned an unsupported health contract.",
          operation: "worker_health",
        });
      }
      const phaseProgress = asNumber(
        health.phase_progress,
        "worker_health",
        "response.phase_progress",
      );
      const modelStatus = asString(model.status, "worker_health", "response.model.status");
      const gpuState = asString(gpu.state, "worker_health", "response.gpu.state");
      const gpuAvailable = asBoolean(gpu.available, "worker_health", "response.gpu.available");
      const gpuApproved = asBoolean(gpu.approved, "worker_health", "response.gpu.approved");
      const deviceCount = asNumber(gpu.device_count, "worker_health", "response.gpu.device_count");
      const expectedModelStatus = phase === "ready" ? "ready" : phase === "error" ? "error" : "loading";
      const gpuReady = gpuState === "ready";
      const phaseRequiresGpu = phase === "warmup" || phase === "ready";
      const gpuMetadataConsistent = deviceCount === 0
        ? !gpuAvailable && !gpuApproved
        : gpuAvailable && gpuApproved;
      if (
        phaseProgress < 0 ||
        phaseProgress > 1 ||
        modelStatus !== expectedModelStatus ||
        !Number.isInteger(deviceCount) ||
        (deviceCount !== 0 && deviceCount !== 1) ||
        (gpuState !== "loading" && gpuState !== "ready") ||
        (gpuReady && (!gpuAvailable || !gpuApproved || deviceCount !== 1)) ||
        !gpuMetadataConsistent ||
        (phaseRequiresGpu && !gpuReady) ||
        (phase === "ready" && phaseProgress !== 1)
      ) {
        throw new RunPodClientError({
          code: "api_response_invalid",
          message: "The ImageForge worker returned inconsistent readiness data.",
          operation: "worker_health",
        });
      }
      return Object.freeze({
        schemaVersion: 1,
        phase: phase as WorkerHealth["phase"],
        phaseProgress,
      });
    } catch (error) {
      if (signal?.aborted === true) {
        throw new RunPodClientError({
          code: "operation_aborted",
          message: "The worker health request was cancelled.",
          operation: "worker_health",
        });
      }
      throw asRunPodClientError(error, {
        code: "api_network_error",
        message: "The ImageForge worker health endpoint is not reachable yet.",
        operation: "worker_health",
        retryable: true,
      });
    }
  }
}
