import { RunPodClientError, asRunPodClientError } from "./errors.js";
import type { FetchTransport } from "./http.js";
import { WORKER_PHASES, type WorkerHealth, type WorkerHealthProbe } from "./types.js";
import { asNumber, asRecord, asString } from "./validation.js";

const RUNPOD_PROXY_HOST = /^[A-Za-z0-9][A-Za-z0-9-]*-\d+\.proxy\.runpod\.net$/;

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
      endpoint.username !== "" ||
      endpoint.password !== "" ||
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
      const response = await this.#fetch(endpoint.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        ...(signal === undefined ? {} : { signal }),
      });
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
        raw = await response.json();
      } catch (error) {
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
      if (schemaVersion !== 1 || !(WORKER_PHASES as readonly string[]).includes(phase)) {
        throw new RunPodClientError({
          code: "api_response_invalid",
          message: "The ImageForge worker returned an unsupported health contract.",
          operation: "worker_health",
        });
      }
      let phaseProgress: number | null = null;
      if (health.phase_progress !== null && health.phase_progress !== undefined) {
        phaseProgress = asNumber(
          health.phase_progress,
          "worker_health",
          "response.phase_progress",
        );
        if (phaseProgress < 0 || phaseProgress > 1) {
          throw new RunPodClientError({
            code: "api_response_invalid",
            message: "The ImageForge worker returned invalid phase progress.",
            operation: "worker_health",
          });
        }
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
