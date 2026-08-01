import { createRunPodClientConfig, type RunPodClientConfigInput } from "./config.js";
import { RunPodClientError, asRunPodClientError, type RunPodOperation } from "./errors.js";
import { approveCatalogGpu, isEmergencyGpuId, staticGpuPolicy } from "./gpu-policy.js";
import { buildManagedPodName } from "./real-provider.js";
import { rankGpuOffers } from "./ranking.js";
import {
  type Clock,
  type ConfirmedStopIntent,
  type CreatePodFromTemplateRequest,
  type ForegroundStartIntent,
  type ForegroundStopIntent,
  type GpuOffer,
  type LifecyclePhase,
  type ManagedPod,
  type PodDiscoveryCriteria,
  type PodView,
  type RefreshOptions,
  type ResolveAmbiguousCreateIntent,
  type RunPodClientConfig,
  type RunPodProvider,
  type RunPodSnapshot,
  type SafeErrorSummary,
  type Sleep,
  type SnapshotWarning,
  type StartGpuResult,
  type StopConfirmation,
  type StopGpuResult,
  type TokenFactory,
  type WaitUntilReadyOptions,
  type WorkerHealth,
  type WorkerHealthProbe,
} from "./types.js";

export interface RunPodLifecycleControllerOptions {
  readonly provider: RunPodProvider;
  readonly config: RunPodClientConfig | RunPodClientConfigInput;
  readonly workerHealthProbe?: WorkerHealthProbe;
  readonly clock?: Clock;
  readonly sleep?: Sleep;
  readonly tokenFactory?: TokenFactory;
}

type SnapshotListener = (snapshot: RunPodSnapshot) => void;

interface PendingConfirmation {
  readonly podId: string;
  readonly expiresAtMs: number;
}

interface EnrichedPods {
  readonly views: readonly PodView[];
  readonly warnings: readonly SnapshotWarning[];
}

interface StartAttemptState {
  postAttempted: boolean;
  exactPodReceived: boolean;
}

interface StopAttemptState {
  deleteAttempted: boolean;
}

const ACTIVE_POD_STATUSES = new Set<ManagedPod["status"]>([
  "provisioning",
  "starting",
  "running",
  "unknown",
  "error",
]);

const REUSABLE_POD_STATUSES = new Set<ManagedPod["status"]>([
  "provisioning",
  "starting",
  "running",
]);

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(
        new RunPodClientError({
          code: "operation_aborted",
          message: "The RunPod wait was cancelled.",
          operation: "wait_for_ready",
        }),
      );
      return;
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(
        new RunPodClientError({
          code: "operation_aborted",
          message: "The RunPod wait was cancelled.",
          operation: "wait_for_ready",
        }),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function operationAborted(operation: RunPodOperation): RunPodClientError {
  return new RunPodClientError({
    code: "operation_aborted",
    message: "The RunPod operation was cancelled.",
    operation,
  });
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  operation: RunPodOperation,
): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(operationAborted(operation));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(operationAborted(operation));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

interface OperationDeadline {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
}

function createOperationDeadline(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): OperationDeadline {
  const controller = new AbortController();
  let didTimeOut = false;
  const onExternalAbort = (): void => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  if (externalSignal?.aborted === true) controller.abort();
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

function safeErrorSummary(error: RunPodClientError): SafeErrorSummary {
  return Object.freeze({
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  });
}

function isActivePod(pod: ManagedPod): boolean {
  return ACTIVE_POD_STATUSES.has(pod.status);
}

function isReusablePod(pod: ManagedPod): boolean {
  return REUSABLE_POD_STATUSES.has(pod.status);
}

function workerPhaseToLifecycle(health: WorkerHealth): LifecyclePhase {
  switch (health.phase) {
    case "process":
    case "storage":
      return "booting";
    case "weights":
    case "gpu_load":
      return "loading";
    case "warmup":
      return "warming";
    case "ready":
      return "ready";
    case "error":
      return "error";
  }
}

function validateExpectedImageCount(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new RunPodClientError({
      code: "configuration_invalid",
      message: "Expected image count must be an integer from 1 to 500.",
      operation: "configuration",
      details: { field: "expectedImageCount" },
    });
  }
  return value;
}

export class RunPodLifecycleController {
  readonly #provider: RunPodProvider;
  readonly #config: RunPodClientConfig;
  readonly #workerHealthProbe: WorkerHealthProbe | null;
  readonly #clock: Clock;
  readonly #sleep: Sleep;
  readonly #tokenFactory: TokenFactory;
  readonly #listeners = new Set<SnapshotListener>();
  readonly #confirmations = new Map<string, PendingConfirmation>();
  readonly #knownCreatedPods = new Map<string, ManagedPod>();
  #snapshot: RunPodSnapshot;
  #startPromise: Promise<StartGpuResult> | null = null;
  #unresolvedStartRequestId: string | null = null;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: RunPodLifecycleControllerOptions) {
    this.#provider = options.provider;
    this.#config = createRunPodClientConfig(options.config);
    if (options.provider.requiresWorkerHealthProbe === true && options.workerHealthProbe === undefined) {
      throw new RunPodClientError({
        code: "configuration_invalid",
        message: "The real RunPod provider requires a worker health probe.",
        operation: "configuration",
        details: { field: "workerHealthProbe" },
      });
    }
    this.#workerHealthProbe = options.workerHealthProbe ?? null;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#sleep = options.sleep ?? defaultSleep;
    this.#tokenFactory = options.tokenFactory ?? (() => crypto.randomUUID());
    this.#snapshot = Object.freeze({
      revision: 0,
      phase: "offline",
      inventory: Object.freeze([]),
      rankedCandidates: Object.freeze([]),
      pods: Object.freeze([]),
      selectedPodId: null,
      proxyUrl: null,
      expectedImageCount: this.#config.defaultImageCount,
      refreshedAt: null,
      warnings: Object.freeze([]),
      error: null,
    });
  }

  get config(): RunPodClientConfig {
    return this.#config;
  }

  getSnapshot(): RunPodSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  resolveAmbiguousCreate(intent: ResolveAmbiguousCreateIntent): RunPodSnapshot {
    if (
      intent.intent !== "resolve_ambiguous_create" ||
      intent.source !== "foreground_user" ||
      this.#unresolvedStartRequestId === null ||
      intent.requestId !== this.#unresolvedStartRequestId
    ) {
      throw new RunPodClientError({
        code: "pod_create_ambiguous",
        message: "The unresolved create marker does not match this explicit resolution.",
        operation: "create_pod",
        retryable: true,
        mayHaveSucceeded: true,
      });
    }
    this.#unresolvedStartRequestId = null;
    const selected = this.#snapshot.selectedPodId === null
      ? undefined
      : this.#snapshot.pods.find((pod) => pod.id === this.#snapshot.selectedPodId);
    this.#publish({
      ...this.#snapshot,
      phase: selected?.lifecyclePhase ?? "offline",
      warnings: Object.freeze(
        this.#snapshot.warnings.filter((warning) => warning.code !== "ambiguous_create_unresolved"),
      ),
      error: null,
    });
    return this.#snapshot;
  }

  refresh(options: RefreshOptions = {}): Promise<RunPodSnapshot> {
    const deadline = createOperationDeadline(options.signal, this.#config.operationTimeoutMs);
    const boundedOptions: RefreshOptions = {
      ...(options.expectedImageCount === undefined
        ? {}
        : { expectedImageCount: options.expectedImageCount }),
      signal: deadline.signal,
    };
    const queued = this.#enqueueMutation(() => this.#refresh(boundedOptions));
    return awaitWithAbort(queued, deadline.signal, "list_pods").catch((error: unknown) => {
      if (!deadline.timedOut()) throw error;
      const timeoutError = new RunPodClientError({
        code: "api_request_failed",
        message: "RunPod refresh exceeded the operation timeout.",
        operation: "list_pods",
        retryable: true,
        details: { timeoutMs: this.#config.operationTimeoutMs },
      });
      this.#publish({ ...this.#snapshot, phase: "error", error: safeErrorSummary(timeoutError) });
      throw timeoutError;
    }).finally(deadline.dispose);
  }

  async #refresh(options: RefreshOptions = {}): Promise<RunPodSnapshot> {
    if (isSignalAborted(options.signal)) throw operationAborted("list_pods");
    const expectedImageCount = validateExpectedImageCount(
      options.expectedImageCount ?? this.#snapshot.expectedImageCount,
    );
    this.#publish({
      ...this.#snapshot,
      phase: "selecting",
      expectedImageCount,
      error: null,
    });

    const inventoryRequest = {
      gpuIds: this.#enabledGpuIds(),
      includeEmergencyTier: this.#config.allowEmergencyGpuTier,
      cloudLanes: this.#config.cloudLanes,
      gpuCount: this.#config.gpuCount,
      dataCenterId: this.#config.networkVolumeDataCenterId,
    };
    const [inventoryResult] = await Promise.allSettled([
      awaitWithAbort(
        this.#provider.listGpuInventory(inventoryRequest, options.signal),
        options.signal,
        "list_pods",
      ),
    ]);
    if (isSignalAborted(options.signal)) throw operationAborted("list_pods");
    const [podsResult] = await Promise.allSettled([
      awaitWithAbort(
        this.#provider.listImageForgePods(this.#discoveryCriteria(), options.signal),
        options.signal,
        "list_pods",
      ),
    ]);

    try {
      if (podsResult.status === "rejected") {
        throw asRunPodClientError(podsResult.reason, {
          code: "pod_discovery_failed",
          message: "Existing ImageForge Pods could not be discovered.",
          operation: "list_pods",
          retryable: true,
        });
      }

      let inventory: readonly GpuOffer[];
      const warnings: SnapshotWarning[] = [];
      this.#observeUnresolvedCreate(podsResult.value);
      if (this.#unresolvedStartRequestId !== null) {
        warnings.push(this.#unresolvedCreateWarning());
      }
      if (inventoryResult.status === "fulfilled") {
        inventory = this.#validatedInventory(inventoryResult.value);
      } else {
        const inventoryError = asRunPodClientError(inventoryResult.reason, {
          code: "inventory_unavailable",
          message: "Live RunPod GPU inventory could not be loaded.",
          operation: "inventory",
          retryable: true,
        });
        if (inventoryError.code === "operation_aborted") {
          throw inventoryError;
        }
        inventory = this.#staticFallbackInventory();
        warnings.push(
          Object.freeze({
            code: "inventory_fallback",
            message:
              "Live GPU inventory is unavailable. RunPod will apply the reviewed one-GPU fallback order during creation.",
            podIds: Object.freeze([]),
          }),
        );
      }

      const rankedCandidates = rankGpuOffers({
        offers: inventory,
        benchmarkProfiles: this.#config.benchmarkProfiles,
        benchmarkContract: this.#config.benchmarkContract,
        expectedImageCount,
      });
      const retained = await this.#mergeKnownCreatedPods(podsResult.value, options.signal);
      warnings.push(...retained.warnings);
      const enriched = await this.#enrichPods(retained.pods, options.signal);
      warnings.push(...enriched.warnings);
      const snapshot = this.#snapshotForViews(
        inventory,
        rankedCandidates,
        enriched.views,
        expectedImageCount,
        warnings,
        new Date(this.#clock.now()).toISOString(),
      );
      this.#publish(snapshot);
      return this.#snapshot;
    } catch (error) {
      const runPodError = asRunPodClientError(error, {
        code: "api_request_failed",
        message: "RunPod state could not be refreshed.",
        operation: "list_pods",
        retryable: true,
      });
      if (runPodError.code === "operation_aborted") throw runPodError;
      this.#publish({
        ...this.#snapshot,
        phase: "error",
        error: safeErrorSummary(runPodError),
      });
      throw runPodError;
    }
  }

  startGpu(intent: ForegroundStartIntent): Promise<StartGpuResult> {
    if (intent.intent !== "start_gpu" || intent.source !== "foreground_user") {
      return Promise.reject(
        new RunPodClientError({
          code: "operation_in_progress",
          message: "Starting a GPU requires an explicit foreground Start GPU action.",
          operation: "create_pod",
        }),
      );
    }
    if (this.#startPromise !== null) {
      return this.#startPromise;
    }

    const controller = new AbortController();
    const startRequestId = intent.requestId ?? this.#tokenFactory();
    const attempt: StartAttemptState = { postAttempted: false, exactPodReceived: false };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#config.provisioningTimeoutMs);
    const queued = this.#enqueueMutation(() =>
      this.#startGpu(intent, controller.signal, startRequestId, attempt));
    const promise = awaitWithAbort(queued, controller.signal, "create_pod").catch((error: unknown) => {
      if (!timedOut) throw error;
      const ambiguous = attempt.postAttempted && !attempt.exactPodReceived;
      if (ambiguous) this.#unresolvedStartRequestId = startRequestId;
      const timeoutError = new RunPodClientError({
        code: "provisioning_timeout",
        message: "The GPU start operation exceeded the provisioning timeout.",
        operation: "create_pod",
        retryable: true,
        mayHaveSucceeded: attempt.postAttempted,
        details: { timeoutMs: this.#config.provisioningTimeoutMs },
      });
      this.#publish({
        ...this.#snapshot,
        phase: "error",
        warnings: ambiguous
          ? Object.freeze([
              ...this.#snapshot.warnings.filter(
                (warning) => warning.code !== "ambiguous_create_unresolved",
              ),
              this.#unresolvedCreateWarning(),
            ])
          : this.#snapshot.warnings,
        error: safeErrorSummary(timeoutError),
      });
      throw timeoutError;
    }).finally(() => {
      clearTimeout(timer);
      if (this.#startPromise === promise) {
        this.#startPromise = null;
      }
    });
    this.#startPromise = promise;
    return promise;
  }

  async waitUntilReady(options: WaitUntilReadyOptions = {}): Promise<RunPodSnapshot> {
    const timeoutMs = options.timeoutMs ?? this.#config.provisioningTimeoutMs;
    const pollIntervalMs = options.pollIntervalMs ?? this.#config.refreshIntervalMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new RunPodClientError({
        code: "configuration_invalid",
        message: "Provisioning timeout must be a positive integer.",
        operation: "configuration",
        details: { field: "timeoutMs" },
      });
    }
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
      throw new RunPodClientError({
        code: "configuration_invalid",
        message: "Poll interval must be a positive integer.",
        operation: "configuration",
        details: { field: "pollIntervalMs" },
      });
    }

    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (options.signal?.aborted === true) controller.abort();
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      while (true) {
        const snapshot = await awaitWithAbort(
          this.refresh({
            ...(options.expectedImageCount === undefined
              ? {}
              : { expectedImageCount: options.expectedImageCount }),
            signal: controller.signal,
          }),
          controller.signal,
          "wait_for_ready",
        );
        options.onSnapshot?.(snapshot);
        if (snapshot.phase === "ready") {
          return snapshot;
        }
        if (snapshot.selectedPodId === null) {
          throw new RunPodClientError({
            code: "pod_not_found",
            message: "No active ImageForge Pod was found while waiting for readiness.",
            operation: "wait_for_ready",
            retryable: true,
          });
        }
        if (snapshot.phase === "error") {
          throw new RunPodClientError({
            code: "provisioning_failed",
            message: "The ImageForge Pod entered an error state while provisioning.",
            operation: "wait_for_ready",
            details: { podId: snapshot.selectedPodId },
          });
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new RunPodClientError({
            code: "provisioning_timeout",
            message: "The GPU did not become ready before the provisioning timeout.",
            operation: "wait_for_ready",
            retryable: true,
            details: { podId: snapshot.selectedPodId, timeoutMs },
          });
        }
        await awaitWithAbort(
          this.#sleep(Math.min(pollIntervalMs, remaining), controller.signal),
          controller.signal,
          "wait_for_ready",
        );
      }
    } catch (error) {
      if (!timedOut) throw error;
      const timeoutError = new RunPodClientError({
        code: "provisioning_timeout",
        message: "The GPU did not become ready before the provisioning timeout.",
        operation: "wait_for_ready",
        retryable: true,
        details: {
          timeoutMs,
          ...(this.#snapshot.selectedPodId === null ? {} : { podId: this.#snapshot.selectedPodId }),
        },
      });
      this.#publish({ ...this.#snapshot, phase: "error", error: safeErrorSummary(timeoutError) });
      throw timeoutError;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  requestStopConfirmation(intent: ForegroundStopIntent): StopConfirmation {
    if (intent.intent !== "stop_gpu" || intent.source !== "foreground_user") {
      throw new RunPodClientError({
        code: "termination_confirmation_required",
        message: "Stopping a GPU requires an explicit foreground Stop GPU action.",
        operation: "terminate_pod",
      });
    }
    const pod = this.#snapshot.pods.find(
      (candidate) => candidate.id === intent.podId && isActivePod(candidate),
    );
    if (pod === undefined) {
      throw new RunPodClientError({
        code: "pod_not_found",
        message: "The selected ImageForge Pod is no longer active. Refresh before stopping.",
        operation: "terminate_pod",
        details: { podId: intent.podId },
      });
    }

    const token = this.#tokenFactory();
    if (typeof token !== "string" || token.length < 4) {
      throw new RunPodClientError({
        code: "configuration_invalid",
        message: "The confirmation token source returned an invalid token.",
        operation: "configuration",
      });
    }
    const expiresAtMs = this.#clock.now() + this.#config.stopConfirmationTtlMs;
    this.#confirmations.set(token, { podId: intent.podId, expiresAtMs });
    return Object.freeze({
      intent: "confirm_stop_gpu",
      podId: intent.podId,
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      message:
        "Terminate GPU compute and ephemeral container data. ImageForge files and model weights on the network volume will remain.",
    });
  }

  stopGpu(intent: ConfirmedStopIntent, signal?: AbortSignal): Promise<StopGpuResult> {
    const deadline = createOperationDeadline(signal, this.#config.operationTimeoutMs);
    const attempt: StopAttemptState = { deleteAttempted: false };
    const queued = this.#enqueueMutation(() => this.#stopGpu(intent, deadline.signal, attempt));
    return awaitWithAbort(queued, deadline.signal, "terminate_pod").catch((error: unknown) => {
      if (!deadline.timedOut()) {
        const stoppedError = asRunPodClientError(error, {
          code: "operation_aborted",
          message: "The Pod termination request was cancelled.",
          operation: "terminate_pod",
        });
        if (stoppedError.code === "operation_aborted") {
          const surfacedAbort = attempt.deleteAttempted
            ? new RunPodClientError({
                code: "operation_aborted",
                message: "The Pod termination request was cancelled; refresh to verify its outcome.",
                operation: "terminate_pod",
                retryable: true,
                mayHaveSucceeded: true,
                details: { podId: intent.podId },
              })
            : stoppedError;
          this.#publish({ ...this.#snapshot, phase: "error", error: safeErrorSummary(surfacedAbort) });
          throw surfacedAbort;
        }
        throw stoppedError;
      }
      const timeoutError = new RunPodClientError({
        code: attempt.deleteAttempted ? "pod_termination_failed" : "pod_discovery_failed",
        message: attempt.deleteAttempted
          ? "Pod termination timed out; refresh to verify whether DELETE succeeded."
          : "Pod revalidation timed out before DELETE was attempted.",
        operation: attempt.deleteAttempted ? "terminate_pod" : "get_pod",
        retryable: true,
        mayHaveSucceeded: attempt.deleteAttempted,
        details: { podId: intent.podId, timeoutMs: this.#config.operationTimeoutMs },
      });
      this.#publish({ ...this.#snapshot, phase: "error", error: safeErrorSummary(timeoutError) });
      throw timeoutError;
    }).finally(deadline.dispose);
  }

  async #stopGpu(
    intent: ConfirmedStopIntent,
    signal: AbortSignal | undefined,
    attempt: StopAttemptState,
  ): Promise<StopGpuResult> {
    if (isSignalAborted(signal)) throw operationAborted("terminate_pod");
    if (intent.intent !== "confirm_stop_gpu" || intent.source !== "foreground_user") {
      throw new RunPodClientError({
        code: "termination_confirmation_required",
        message: "GPU termination requires an explicit foreground confirmation.",
        operation: "terminate_pod",
      });
    }
    const confirmation = this.#confirmations.get(intent.confirmationToken);
    if (confirmation === undefined) {
      throw new RunPodClientError({
        code: "termination_confirmation_required",
        message: "A valid Stop GPU confirmation is required.",
        operation: "terminate_pod",
      });
    }
    this.#confirmations.delete(intent.confirmationToken);
    if (confirmation.podId !== intent.podId) {
      throw new RunPodClientError({
        code: "termination_target_mismatch",
        message: "The confirmation belongs to a different Pod. Refresh and confirm again.",
        operation: "terminate_pod",
        details: { podId: intent.podId },
      });
    }
    if (this.#clock.now() >= confirmation.expiresAtMs) {
      throw new RunPodClientError({
        code: "termination_confirmation_expired",
        message: "The Stop GPU confirmation expired. Confirm the current Pod again.",
        operation: "terminate_pod",
        details: { podId: intent.podId },
      });
    }
    if (!this.#snapshot.pods.some((pod) => pod.id === intent.podId && isActivePod(pod))) {
      throw new RunPodClientError({
        code: "pod_not_found",
        message: "The confirmed Pod is no longer active. Refresh before stopping.",
        operation: "terminate_pod",
        details: { podId: intent.podId },
      });
    }

    let currentPod: ManagedPod | null;
    try {
      currentPod = await awaitWithAbort(
        this.#provider.getPod(intent.podId, this.#discoveryCriteria(), signal),
        signal,
        "get_pod",
      );
    } catch (error) {
      const discoveryError = asRunPodClientError(error, {
        code: "pod_discovery_failed",
        message: "The selected Pod could not be revalidated before termination.",
        operation: "get_pod",
        retryable: true,
      });
      if (discoveryError.code === "operation_aborted") throw discoveryError;
      this.#publish({
        ...this.#snapshot,
        phase: "error",
        error: safeErrorSummary(discoveryError),
      });
      throw discoveryError;
    }
    if (currentPod === null || !isActivePod(currentPod)) {
      throw new RunPodClientError({
        code: "pod_not_found",
        message:
          "The confirmed Pod no longer matches the managed ImageForge profile. Refresh before stopping.",
        operation: "terminate_pod",
        details: { podId: intent.podId },
      });
    }

    this.#publish({
      ...this.#snapshot,
      phase: "stopping",
      selectedPodId: intent.podId,
      proxyUrl: currentPod.proxyUrl,
      error: null,
    });
    try {
      attempt.deleteAttempted = true;
      await awaitWithAbort(
        this.#provider.terminatePod(intent.podId, signal),
        signal,
        "terminate_pod",
      );
    } catch (error) {
      const sourceError = asRunPodClientError(error, {
        code: "pod_termination_failed",
        message: "RunPod could not terminate the selected Pod.",
        operation: "terminate_pod",
        retryable: true,
      });
      if (sourceError.code === "operation_aborted") {
        const aborted = new RunPodClientError({
          code: "operation_aborted",
          message: "The Pod termination request was cancelled; refresh to verify its outcome.",
          operation: "terminate_pod",
          retryable: true,
          mayHaveSucceeded: true,
          details: { podId: intent.podId },
        });
        throw aborted;
      }
      const terminationError = new RunPodClientError({
        code: "pod_termination_failed",
        message:
          "RunPod could not confirm GPU termination. Refresh Pod status before trying again.",
        operation: "terminate_pod",
        retryable: sourceError.retryable,
        mayHaveSucceeded: sourceError.mayHaveSucceeded,
        ...(sourceError.httpStatus === null ? {} : { httpStatus: sourceError.httpStatus }),
        details: { podId: intent.podId },
        cause: sourceError,
      });
      this.#publish({
        ...this.#snapshot,
        phase: "error",
        error: safeErrorSummary(terminationError),
      });
      throw terminationError;
    }

    for (const [token, pending] of this.#confirmations) {
      if (pending.podId === intent.podId) {
        this.#confirmations.delete(token);
      }
    }
    this.#knownCreatedPods.delete(intent.podId);
    const remainingPods = this.#snapshot.pods.filter((pod) => pod.id !== intent.podId);
    const snapshot = this.#snapshotForViews(
      this.#snapshot.inventory,
      this.#snapshot.rankedCandidates,
      remainingPods,
      this.#snapshot.expectedImageCount,
      this.#snapshot.warnings.filter((warning) => warning.code !== "duplicate_pods"),
      new Date(this.#clock.now()).toISOString(),
    );
    this.#publish(snapshot);
    return Object.freeze({ terminatedPodId: intent.podId, snapshot: this.#snapshot });
  }

  async #startGpu(
    intent: ForegroundStartIntent,
    signal: AbortSignal,
    startRequestId: string,
    attempt: StartAttemptState,
  ): Promise<StartGpuResult> {
    const unresolvedAtStart = this.#unresolvedStartRequestId;
    const expectedImageCount = validateExpectedImageCount(
      intent.expectedImageCount ?? this.#config.defaultImageCount,
    );
    const podName = buildManagedPodName(this.#config.podNamePrefix, startRequestId);

    try {
      const refreshed = await this.#refresh({
        expectedImageCount,
        signal,
      });
      if (unresolvedAtStart !== null) {
        if (this.#unresolvedStartRequestId !== null) {
          throw new RunPodClientError({
            code: "pod_create_ambiguous",
            message:
              "A prior Pod create remains unresolved. No additional Pod will be created until its request marker is resolved.",
            operation: "create_pod",
            retryable: true,
            mayHaveSucceeded: true,
            details: { requestId: unresolvedAtStart },
          });
        }
        const resolvedActive = refreshed.pods.filter(
          (pod) => pod.startRequestId === unresolvedAtStart && isActivePod(pod),
        );
        const resolvedReusable = resolvedActive.length === 1 && resolvedActive[0] !== undefined &&
          this.#selectedReusablePod(resolvedActive) !== null
          ? resolvedActive[0]
          : null;
        if (resolvedReusable !== null) {
          return Object.freeze({
            outcome: "connected_existing",
            pod: resolvedReusable,
            snapshot: refreshed,
          });
        }
        if (resolvedActive.length > 0) {
          throw new RunPodClientError({
            code: "operation_in_progress",
            message: "The previously ambiguous Pod is active but cannot safely be reused.",
            operation: "create_pod",
            retryable: true,
            details: { requestId: unresolvedAtStart },
          });
        }
      }
      const existing = this.#selectedReusablePod(refreshed.pods);
      if (existing !== null) {
        return Object.freeze({
          outcome: "connected_existing",
          pod: existing,
          snapshot: refreshed,
        });
      }
      const nonReusableActive = refreshed.pods.find(isActivePod);
      if (nonReusableActive !== undefined) {
        throw new RunPodClientError({
          code: "operation_in_progress",
          message:
            "An existing ImageForge Pod is not healthy enough to reuse. Refresh or explicitly stop that Pod before starting another.",
          operation: "create_pod",
          retryable: true,
          details: { podId: nonReusableActive.id, status: nonReusableActive.status },
        });
      }
      if (refreshed.rankedCandidates.length === 0) {
        throw new RunPodClientError({
          code: "no_gpu_available",
          message: "No approved one-GPU RunPod offer is currently available.",
          operation: "create_pod",
          retryable: true,
        });
      }

      const gpuTypeIds = Array.from(
        new Set(refreshed.rankedCandidates.map((candidate) => candidate.gpuId)),
      );
      const request: CreatePodFromTemplateRequest = Object.freeze({
        name: podName,
        startRequestId,
        templateId: this.#config.templateId,
        networkVolumeId: this.#config.networkVolumeId,
        networkVolumeDataCenterId: this.#config.networkVolumeDataCenterId,
        networkVolumeMountPath: this.#config.networkVolumeMountPath,
        workerPort: this.#config.workerPort,
        cloud: "secure",
        gpuTypeIds: Object.freeze(gpuTypeIds),
        gpuCount: this.#config.gpuCount,
        gpuTypePriority: "custom",
        interruptible: false,
        allowEmergencyGpuTier: this.#config.allowEmergencyGpuTier,
        constraints: this.#config.constraints,
      });

      let exactCreatedPod: ManagedPod | null = null;
      try {
        attempt.postAttempted = true;
        const created = await awaitWithAbort(
          this.#provider.createPodFromTemplate(request, signal),
          signal,
          "create_pod",
        );
        attempt.exactPodReceived = true;
        exactCreatedPod = created;
        return await this.#finishSuccessfulCreate(
          created,
          expectedImageCount,
          "created",
          signal,
        );
      } catch (error) {
        const createError = asRunPodClientError(error, {
          code: "api_request_failed",
          message: "RunPod could not create the ImageForge Pod.",
          operation: "create_pod",
          retryable: true,
          mayHaveSucceeded: true,
        });
        if (createError.code === "operation_aborted") {
          if (exactCreatedPod === null) this.#unresolvedStartRequestId = startRequestId;
          throw createError;
        }
        if (createError.mayHaveSucceeded) {
          this.#unresolvedStartRequestId = startRequestId;
          const reconciled = await this.#reconcileAmbiguousCreate(
            startRequestId,
            expectedImageCount,
            signal,
          );
          if (reconciled !== null) {
            this.#unresolvedStartRequestId = null;
            return reconciled;
          }
          throw new RunPodClientError({
            code: "pod_create_ambiguous",
            message:
              "RunPod may have created a Pod, but the result could not be confirmed. Refresh before starting again.",
            operation: "create_pod",
            retryable: true,
            mayHaveSucceeded: true,
            details: { requestId: startRequestId },
          });
        }
        if (createError.code === "gpu_unavailable") {
          throw new RunPodClientError({
            code: "no_gpu_available",
            message: "Approved RunPod GPU capacity changed before the Pod could be created.",
            operation: "create_pod",
            retryable: true,
          });
        }
        throw createError;
      }
    } catch (error) {
      const runPodError = asRunPodClientError(error, {
        code: "api_request_failed",
        message: "The ImageForge GPU could not be started.",
        operation: "create_pod",
        retryable: true,
      });
      if (runPodError.code === "operation_aborted") throw runPodError;
      this.#publish({
        ...this.#snapshot,
        phase: "error",
        warnings: this.#unresolvedStartRequestId === null
          ? this.#snapshot.warnings
          : Object.freeze([
              ...this.#snapshot.warnings.filter(
                (warning) => warning.code !== "ambiguous_create_unresolved",
              ),
              this.#unresolvedCreateWarning(),
            ]),
        error: safeErrorSummary(runPodError),
      });
      throw runPodError;
    }
  }

  async #finishSuccessfulCreate(
    created: ManagedPod,
    expectedImageCount: number,
    outcome: StartGpuResult["outcome"],
    signal?: AbortSignal,
  ): Promise<StartGpuResult> {
    this.#knownCreatedPods.set(created.id, created);
    try {
      const pods = await awaitWithAbort(
        this.#provider.listImageForgePods(this.#discoveryCriteria(), signal),
        signal,
        "list_pods",
      );
      const enriched = await this.#enrichPods(pods, signal);
      const discoveredCreated = enriched.views.find((pod) => pod.id === created.id);
      const createdView = this.#podView(created, null, null);
      const discoveryWarnings = discoveredCreated === undefined
        ? [
            Object.freeze({
              code: "post_create_discovery_failed" as const,
              message:
                "The Pod was created, but its exact ID was not present in immediate discovery. Refresh before another Start GPU action.",
              podIds: Object.freeze([created.id]),
            }),
          ]
        : [];
      const views = discoveredCreated !== undefined
        ? enriched.views
        : Object.freeze([
            ...enriched.views,
            createdView,
          ]);
      const snapshot = this.#snapshotForViews(
        this.#snapshot.inventory,
        this.#snapshot.rankedCandidates,
        views,
        expectedImageCount,
        [...this.#snapshot.warnings, ...enriched.warnings, ...discoveryWarnings],
        new Date(this.#clock.now()).toISOString(),
      );
      this.#publish(snapshot);
      const current =
        discoveredCreated ??
        this.#snapshot.pods.find((pod) => pod.id === created.id) ??
        createdView;
      return Object.freeze({ outcome, pod: current, snapshot: this.#snapshot });
    } catch (error) {
      const discoveryError = asRunPodClientError(error, {
        code: "pod_discovery_failed",
        message: "Post-create Pod discovery failed.",
        operation: "list_pods",
        retryable: true,
      });
      if (discoveryError.code === "operation_aborted") throw discoveryError;
      const createdView = this.#podView(created, null, null);
      const existingViews = this.#snapshot.pods.filter((pod) => pod.id !== created.id);
      const warning: SnapshotWarning = Object.freeze({
        code: "post_create_discovery_failed",
        message:
          "The Pod was created, but duplicate discovery failed. Refresh before another Start GPU action.",
        podIds: Object.freeze([created.id]),
      });
      const snapshot = this.#snapshotForViews(
        this.#snapshot.inventory,
        this.#snapshot.rankedCandidates,
        [...existingViews, createdView],
        expectedImageCount,
        [...this.#snapshot.warnings, warning],
        new Date(this.#clock.now()).toISOString(),
      );
      this.#publish(snapshot);
      return Object.freeze({ outcome, pod: createdView, snapshot: this.#snapshot });
    }
  }

  async #reconcileAmbiguousCreate(
    startRequestId: string,
    expectedImageCount: number,
    signal?: AbortSignal,
  ): Promise<StartGpuResult | null> {
    try {
      const pods = await awaitWithAbort(
        this.#provider.listImageForgePods(this.#discoveryCriteria(), signal),
        signal,
        "list_pods",
      );
      const matching = pods.filter(
        (pod) => pod.startRequestId === startRequestId && isActivePod(pod),
      );
      if (matching.length !== 1 || matching[0] === undefined) {
        return null;
      }
      return this.#finishSuccessfulCreate(
        matching[0],
        expectedImageCount,
        "reconciled_ambiguous_create",
        signal,
      );
    } catch (error) {
      const discoveryError = asRunPodClientError(error, {
        code: "pod_discovery_failed",
        message: "Ambiguous create reconciliation failed.",
        operation: "list_pods",
        retryable: true,
      });
      if (discoveryError.code === "operation_aborted") throw discoveryError;
      return null;
    }
  }

  async #enrichPods(
    pods: readonly ManagedPod[],
    signal?: AbortSignal,
  ): Promise<EnrichedPods> {
    const warnings: SnapshotWarning[] = [];
    const views = await Promise.all(
      pods.map(async (pod): Promise<PodView> => {
        if (pod.status !== "running" || this.#workerHealthProbe === null) {
          return this.#podView(pod, null, null);
        }
        try {
          const health = await awaitWithAbort(
            this.#workerHealthProbe.getHealth(pod.proxyUrl, signal),
            signal,
            "worker_health",
          );
          return this.#podView(pod, health, null);
        } catch (error) {
          const healthErrorValue = asRunPodClientError(error, {
            code: "api_network_error",
            message: "Worker health is not reachable yet.",
            operation: "worker_health",
            retryable: true,
          });
          if (healthErrorValue.code === "operation_aborted") throw healthErrorValue;
          const healthError = "Worker health is not reachable yet.";
          warnings.push(
            Object.freeze({
              code: "worker_health_unreachable",
              message: `Worker health is not reachable yet for Pod ${pod.id}.`,
              podIds: Object.freeze([pod.id]),
            }),
          );
          return this.#podView(pod, null, healthError);
        }
      }),
    );
    return Object.freeze({
      views: Object.freeze(views),
      warnings: Object.freeze(warnings),
    });
  }

  #observeUnresolvedCreate(pods: readonly ManagedPod[]): void {
    const requestId = this.#unresolvedStartRequestId;
    if (requestId === null) return;
    const matching = pods.filter((pod) => pod.startRequestId === requestId);
    const active = matching.filter(isActivePod);
    // A terminal Pod can predate this create attempt while reusing the same
    // deterministic marker. It is not evidence that an ambiguous POST did or
    // did not create a new Pod, so only one exact active match can reconcile
    // automatically. Every other outcome remains latched until the operator
    // explicitly resolves the exact request marker.
    if (active.length === 1) {
      this.#unresolvedStartRequestId = null;
    }
  }

  #unresolvedCreateWarning(): SnapshotWarning {
    return Object.freeze({
      code: "ambiguous_create_unresolved",
      message:
        "A prior create request has no confirmed Pod identity. Further creates are blocked until its request marker is resolved.",
      podIds: Object.freeze([]),
    });
  }

  async #mergeKnownCreatedPods(
    discovered: readonly ManagedPod[],
    signal?: AbortSignal,
  ): Promise<{ readonly pods: readonly ManagedPod[]; readonly warnings: readonly SnapshotWarning[] }> {
    const merged = new Map(discovered.map((pod) => [pod.id, pod] as const));
    for (const pod of discovered) {
      if (this.#knownCreatedPods.has(pod.id)) this.#knownCreatedPods.set(pod.id, pod);
    }
    const warnings: SnapshotWarning[] = [];
    for (const [podId, retained] of this.#knownCreatedPods) {
      if (merged.has(podId)) continue;
      let verified: ManagedPod | null = null;
      try {
        verified = await awaitWithAbort(
          this.#provider.getPod(podId, this.#discoveryCriteria(), signal),
          signal,
          "list_pods",
        );
      } catch (error) {
        const knownError = asRunPodClientError(error, {
          code: "pod_discovery_failed",
          message: "The created Pod could not be revalidated.",
          operation: "get_pod",
          retryable: true,
        });
        if (knownError.code === "operation_aborted") throw knownError;
      }
      const surfaced = verified ?? retained;
      if (verified !== null) this.#knownCreatedPods.set(podId, verified);
      merged.set(podId, surfaced);
      warnings.push(Object.freeze({
        code: "post_create_discovery_failed",
        message: "A previously created Pod is not present in list discovery and remains bound by its exact ID.",
        podIds: Object.freeze([podId]),
      }));
    }
    return Object.freeze({
      pods: Object.freeze([...merged.values()]),
      warnings: Object.freeze(warnings),
    });
  }

  #podView(
    pod: ManagedPod,
    workerHealth: WorkerHealth | null,
    healthError: string | null,
    phaseOverride?: LifecyclePhase,
  ): PodView {
    let lifecyclePhase: LifecyclePhase;
    if (phaseOverride !== undefined) {
      lifecyclePhase = phaseOverride;
    } else if (pod.status === "provisioning") {
      lifecyclePhase = "provisioning";
    } else if (pod.status === "starting" || pod.status === "unknown") {
      lifecyclePhase = "booting";
    } else if (pod.status === "running" && workerHealth !== null) {
      lifecyclePhase = workerPhaseToLifecycle(workerHealth);
    } else if (pod.status === "running" && healthError !== null) {
      lifecyclePhase =
        this.#snapshot.selectedPodId === pod.id &&
        (this.#snapshot.phase === "ready" || this.#snapshot.phase === "reconnecting")
          ? "reconnecting"
          : "booting";
    } else if (pod.status === "running") {
      lifecyclePhase = "booting";
    } else if (pod.status === "error") {
      lifecyclePhase = "error";
    } else {
      lifecyclePhase = "offline";
    }
    return Object.freeze({
      ...pod,
      lifecyclePhase,
      workerHealth,
      healthError,
    });
  }

  #snapshotForViews(
    inventory: readonly GpuOffer[],
    rankedCandidates: RunPodSnapshot["rankedCandidates"],
    pods: readonly PodView[],
    expectedImageCount: number,
    suppliedWarnings: readonly SnapshotWarning[],
    refreshedAt: string,
  ): Omit<RunPodSnapshot, "revision"> {
    const active = pods.filter(isActivePod);
    const selected = this.#selectedActivePod(active);
    const warnings = suppliedWarnings.filter((warning) => warning.code !== "duplicate_pods");
    if (active.length > 1) {
      warnings.push(
        Object.freeze({
          code: "duplicate_pods",
          message:
            "Multiple ImageForge Pods are active and may incur duplicate hourly spend. Choose one for manual cleanup.",
          podIds: Object.freeze(active.map((pod) => pod.id)),
        }),
      );
    }
    return {
      phase: selected?.lifecyclePhase ?? "offline",
      inventory: Object.freeze([...inventory]),
      rankedCandidates: Object.freeze([...rankedCandidates]),
      pods: Object.freeze([...pods]),
      selectedPodId: selected?.id ?? null,
      proxyUrl: selected?.proxyUrl ?? null,
      expectedImageCount,
      refreshedAt,
      warnings: Object.freeze(warnings),
      error:
        selected?.workerHealth?.phase === "error"
          ? Object.freeze({
              code: "worker_boot_failed",
              message: "The ImageForge worker could not become ready.",
              retryable: false,
            })
          : null,
    };
  }

  #selectedActivePod(pods: readonly PodView[]): PodView | null {
    const active = pods.filter(isActivePod);
    if (active.length === 0) {
      return null;
    }
    const phasePriority: Record<LifecyclePhase, number> = {
      ready: 0,
      warming: 1,
      loading: 2,
      booting: 3,
      reconnecting: 4,
      provisioning: 5,
      selecting: 6,
      stopping: 7,
      offline: 8,
      error: 9,
    };
    return [...active].sort((left, right) => {
      const phaseDifference = phasePriority[left.lifecyclePhase] - phasePriority[right.lifecyclePhase];
      if (phaseDifference !== 0) {
        return phaseDifference;
      }
      const parsedLeftTime = left.createdAt === null ? Number.NaN : Date.parse(left.createdAt);
      const parsedRightTime = right.createdAt === null ? Number.NaN : Date.parse(right.createdAt);
      const leftTime = Number.isFinite(parsedLeftTime)
        ? parsedLeftTime
        : Number.POSITIVE_INFINITY;
      const rightTime = Number.isFinite(parsedRightTime)
        ? parsedRightTime
        : Number.POSITIVE_INFINITY;
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.id.localeCompare(right.id);
    })[0] ?? null;
  }

  #selectedReusablePod(pods: readonly PodView[]): PodView | null {
    return this.#selectedActivePod(
      pods.filter(
        (pod) =>
          isReusablePod(pod) &&
          pod.lifecyclePhase !== "error" &&
          pod.gpuId !== null &&
          (this.#config.allowEmergencyGpuTier || !isEmergencyGpuId(pod.gpuId)),
      ),
    );
  }

  #discoveryCriteria(): PodDiscoveryCriteria {
    return Object.freeze({
      podNamePrefix: this.#config.podNamePrefix,
      templateId: this.#config.templateId,
      networkVolumeId: this.#config.networkVolumeId,
      networkVolumeMountPath: this.#config.networkVolumeMountPath,
      workerPort: this.#config.workerPort,
      dataCenterId: this.#config.networkVolumeDataCenterId,
      cloud: "secure",
      gpuCount: this.#config.gpuCount,
      interruptible: false,
      includeEmergencyGpuTier: this.#config.allowEmergencyGpuTier,
    });
  }

  #validatedInventory(inventory: readonly GpuOffer[]): readonly GpuOffer[] {
    return Object.freeze(
      inventory.flatMap((offer) => {
        if (
          offer.cloud !== "secure" ||
          offer.dataCenterId !== this.#config.networkVolumeDataCenterId
        ) {
          return [];
        }
        const approved = approveCatalogGpu(
          {
            id: offer.gpuId,
            name: offer.displayName,
            manufacturer: offer.manufacturer,
            memoryGb: offer.memoryGb,
          },
          this.#config.allowEmergencyGpuTier,
        );
        if (
          approved === null ||
          (approved.emergency && !this.#config.allowEmergencyGpuTier)
        ) {
          return [];
        }
        return [
          Object.freeze({
            ...offer,
            gpuId: approved.gpuId,
            policyKey: approved.policyKey,
            coldPriority: approved.coldPriority,
            emergency: approved.emergency,
            cloud: "secure" as const,
            dataCenterId: this.#config.networkVolumeDataCenterId,
          }),
        ];
      }),
    );
  }

  #enabledGpuIds(): readonly string[] {
    return Object.freeze(
      staticGpuPolicy(this.#config.allowEmergencyGpuTier).map((entry) => entry.gpuId),
    );
  }

  #staticFallbackInventory(): readonly GpuOffer[] {
    const observedAt = new Date(this.#clock.now()).toISOString();
    return Object.freeze(
      this.#config.cloudLanes.flatMap((cloud) =>
        staticGpuPolicy(this.#config.allowEmergencyGpuTier).map((policy) =>
          Object.freeze({
            gpuId: policy.gpuId,
            policyKey: policy.key,
            coldPriority: policy.coldPriority,
            emergency: policy.emergency,
            displayName: policy.catalogNames[0] ?? policy.gpuId,
            manufacturer: "NVIDIA",
            memoryGb: policy.expectedMemoryGb,
            cloud,
            hourlyPriceUsd: null,
            availability: "unknown" as const,
            dataCenterId: this.#config.networkVolumeDataCenterId,
            volumeCompatible: true,
            observedAt,
          }),
        ),
      ),
    );
  }

  #publish(snapshot: Omit<RunPodSnapshot, "revision"> | RunPodSnapshot): void {
    this.#snapshot = Object.freeze({
      ...snapshot,
      revision: this.#snapshot.revision + 1,
    });
    for (const listener of this.#listeners) {
      try {
        listener(this.#snapshot);
      } catch {
        // Presentation listeners cannot invalidate a completed infrastructure mutation.
      }
    }
  }

  #enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
