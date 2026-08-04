import { invoke } from '@tauri-apps/api/core';
import type { NativeGpuInventorySnapshotV1 } from '@imageforge/runpod-client';
import type { ProductionDesktopPort } from '../adapters/productionImageForgeAdapter';
import { createMemoryQueueHost } from '../adapters/queueStore';
import type { NativeGpuPodObservationV1 } from './gpuPodBridge';

export type TwoClientSmokeRole = 'A' | 'B';

export type TwoClientSmokeCheckpoint =
  | 'lifecycle_loading'
  | 'lifecycle_warming'
  | 'startup'
  | 'veto_done'
  | 'release_initial_batch'
  | 'idle_after_release'
  | 'approval_request_a'
  | 'approval_response_b'
  | 'approval_delete_a'
  | 'offline_a_to_b'
  | 'reset_second_pod'
  | 'ready_second_pod'
  | 'denial_request_b'
  | 'denial_response_a'
  | 'clear_denial'
  | 'timeout_request_a'
  | 'expire_timeout'
  | 'clear_timeout'
  | 'generation_request_a'
  | 'generation_started_b'
  | 'release_generated_batch'
  | 'reverse_request_b'
  | 'reverse_response_a'
  | 'reverse_delete_b'
  | 'offline_b_to_a'
  | 'final';

type SmokeInput =
  | { operation: 'runpod_list' }
  | { operation: 'runpod_get'; pod_id: string }
  | { operation: 'runpod_delete'; pod_id: string }
  | { operation: 'worker_health' }
  | { operation: 'worker_status' }
  | { operation: 'studio_heartbeat'; session_id: string; availability: 'foreground' | 'background' }
  | { operation: 'studio_status'; session_id: string }
  | {
      operation: 'studio_create_stop';
      request_id: string;
      session_id: string;
      pod_id: string;
      gpu_display_name: string;
    }
  | { operation: 'studio_respond'; request_id: string; session_id: string; decision: 'approve' | 'deny' }
  | {
      operation: 'studio_finalize';
      request_id: string;
      session_id: string;
      pod_id: string;
      finalization_id: string;
    }
  | {
      operation: 'studio_cancel';
      request_id: string;
      session_id: string;
      pod_id: string;
      finalization_id: string | null;
    }
  | { operation: 'batch_create'; prompt_count: number; base_seed: number }
  | { operation: 'batch_get'; batch_id: string }
  | {
      operation: 'artifact_download';
      batch_id: string;
      index: number;
      expected_sha256: string;
      expected_size_bytes: number;
      expected_width: number;
      expected_height: number;
    }
  | { operation: 'checkpoint'; name: TwoClientSmokeCheckpoint }
  | { operation: 'audit' };

interface SmokeExchangeResult {
  status: number;
  body: unknown;
}

export interface TwoClientSmokeCounters {
  readOnlyReceiptReads: number;
  mutatingReceiptReconciliations: number;
  artifactDownloads: number;
}

function exchangeResult(value: unknown): SmokeExchangeResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The two-client native fixture returned an invalid envelope.');
  }
  const candidate = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(candidate.status)
    || (candidate.status as number) < 100
    || (candidate.status as number) > 599
    || !Object.prototype.hasOwnProperty.call(candidate, 'body')
    || Object.keys(candidate).some((key) => key !== 'status' && key !== 'body')
  ) {
    throw new Error('The two-client native fixture returned an invalid envelope.');
  }
  return { status: candidate.status as number, body: candidate.body };
}

async function exchange(input: SmokeInput): Promise<SmokeExchangeResult> {
  return exchangeResult(await invoke('native_two_client_smoke_exchange', { input }));
}

function response(result: SmokeExchangeResult): Response {
  return new Response(result.status === 204 ? null : JSON.stringify(result.body), {
    status: result.status,
    headers: result.status === 204 ? undefined : { 'content-type': 'application/json' },
  });
}

function smokePodObservation(result: SmokeExchangeResult, revision: number): NativeGpuPodObservationV1 {
  if (result.status !== 200 || !Array.isArray(result.body)) {
    throw new Error('The two-client native fixture rejected the narrow Pod observation.');
  }
  const pods = result.body.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('The two-client native fixture returned an invalid Pod.');
    }
    const value = item as Record<string, unknown>;
    const gpu = value.gpu;
    if (
      typeof value.id !== 'string'
      || typeof gpu !== 'object'
      || gpu === null
      || Array.isArray(gpu)
      || typeof (gpu as Record<string, unknown>).id !== 'string'
      || typeof (gpu as Record<string, unknown>).displayName !== 'string'
      || typeof value.adjustedCostPerHr !== 'number'
    ) {
      throw new Error('The two-client native fixture returned an invalid Pod.');
    }
    return Object.freeze({
      podId: value.id,
      gpuId: (gpu as Record<string, unknown>).id as string,
      gpuDisplayName: (gpu as Record<string, unknown>).displayName as string,
      hourlyPriceMicroUsd: Math.round(value.adjustedCostPerHr * 1_000_000),
      status: value.desiredStatus === 'RUNNING' ? 'running' as const : 'unknown' as const,
    });
  }).sort((left, right) => left.podId.localeCompare(right.podId));
  return Object.freeze({
    schemaVersion: 1,
    processEpochId: '50000000-0000-4000-8000-000000000000',
    lifecycleRevision: revision,
    state: pods.length === 0 ? 'offline' : pods.length === 1 ? 'single' : 'multiple',
    observedAt: '2026-08-03T10:00:00.000Z',
    stale: false,
    pods: Object.freeze(pods),
    overflow: false,
    issue: null,
  });
}

function localWorkerError(code: string, message: string) {
  return { status: 500, body: { error: { code, message, details: null } } };
}

function successfulControlBody(result: SmokeExchangeResult, label: string): unknown {
  if (
    result.status !== 200
    || typeof result.body !== 'object'
    || result.body === null
    || Array.isArray(result.body)
    || (result.body as Record<string, unknown>).passed !== true
  ) {
    throw new Error(`The two-client native fixture rejected ${label}.`);
  }
  return result.body;
}

function artifactReceipt(result: SmokeExchangeResult): {
  schemaVersion: 1;
  batchId: string;
  index: number;
  filename: string;
  sha256: string;
  sizeBytes: number;
  verifiedAtUnixMs: number;
} {
  if (result.status !== 200 || typeof result.body !== 'object' || result.body === null || Array.isArray(result.body)) {
    throw new Error('The two-client native fixture rejected an owner artifact download.');
  }
  const value = result.body as Record<string, unknown>;
  if (
    value.schemaVersion !== 1
    || typeof value.batchId !== 'string'
    || !Number.isSafeInteger(value.index)
    || typeof value.filename !== 'string'
    || typeof value.sha256 !== 'string'
    || !Number.isSafeInteger(value.sizeBytes)
    || !Number.isSafeInteger(value.verifiedAtUnixMs)
    || Object.keys(value).some((key) => ![
      'schemaVersion', 'batchId', 'index', 'filename', 'sha256', 'sizeBytes', 'verifiedAtUnixMs',
    ].includes(key))
  ) {
    throw new Error('The two-client native fixture returned an invalid owner artifact receipt.');
  }
  return {
    schemaVersion: 1,
    batchId: value.batchId as string,
    index: value.index as number,
    filename: value.filename as string,
    sha256: value.sha256 as string,
    sizeBytes: value.sizeBytes as number,
    verifiedAtUnixMs: value.verifiedAtUnixMs as number,
  };
}

/** Maps production runtime operations to one strict smoke-only native command. */
export function createTwoClientSmokePort(role: TwoClientSmokeRole): {
  port: ProductionDesktopPort;
  counters: TwoClientSmokeCounters;
  checkpoint(name: TwoClientSmokeCheckpoint): Promise<unknown>;
  audit(): Promise<unknown>;
} {
  const counters: TwoClientSmokeCounters = {
    readOnlyReceiptReads: 0,
    mutatingReceiptReconciliations: 0,
    artifactDownloads: 0,
  };
  let podRevision = 0;
  let finalizationCounter = 0;
  const workerHealthFetch = (async () => response(await exchange({ operation: 'worker_health' }))) as typeof fetch;
  const unsupportedSwitch = async (): Promise<never> => {
    throw new Error('The two-client Task 012 smoke cannot authorize a Task 014 GPU Switch.');
  };
  const inventoryUnavailable: NativeGpuInventorySnapshotV1 = Object.freeze({
    schemaVersion: 1,
    observationId: '40000000-0000-4000-8000-000000000000',
    processEpochId: '50000000-0000-4000-8000-000000000000',
    includeEmergencyTier: false,
    state: 'error',
    observedAt: null,
    receipt: null,
    offers: Object.freeze([]),
    currentPod: null,
    currentPodObservedAt: null,
    currentPodStale: false,
    issue: Object.freeze({ code: 'gpu_inventory_response_invalid', retryable: false }),
  });

  const port: ProductionDesktopPort = {
    ...createMemoryQueueHost(),
    workerHealthFetch,
    gpuInventory: {
      load: async () => inventoryUnavailable,
      beginRefresh: async () => inventoryUnavailable,
      listen: async () => () => undefined,
    },
    gpuStart: {
      load: async () => null,
      startAuto: async () => { throw new Error('The two-client smoke has no Start inventory authority.'); },
      startSelected: async () => { throw new Error('The two-client smoke has no Start inventory authority.'); },
      confirmActualPrice: async () => { throw new Error('The two-client smoke has no Start price authority.'); },
    },
    gpuPod: {
      observe: async () => {
        podRevision += 1;
        return smokePodObservation(await exchange({ operation: 'runpod_list' }), podRevision);
      },
      loadNormalStop: async () => null,
      normalStop: async (input) => {
        const current = await exchange({ operation: 'runpod_get', pod_id: input.podId });
        if (current.status !== 200 && current.status !== 404) {
          throw new Error('The two-client native fixture rejected the exact Pod preflight.');
        }
        finalizationCounter += 1;
        // The two installed clients share one worker authority. Keep the
        // deterministic smoke IDs unique across clients as well as across
        // repeated Stop calls within one client.
        const clientNamespace = role === 'A' ? '1' : '2';
        const finalizationId = `70000000-0000-4000-8000-${clientNamespace}${String(finalizationCounter).padStart(11, '0')}`;
        const finalized = await exchange({
          operation: 'studio_finalize',
          request_id: input.stopRequestId,
          session_id: input.sessionId,
          pod_id: input.podId,
          finalization_id: finalizationId,
        });
        if (finalized.status !== 200) {
          throw new Error('The two-client native fixture rejected the worker finalization.');
        }
        const deleted = await exchange({ operation: 'runpod_delete', pod_id: input.podId });
        if (deleted.status !== 204 && deleted.status !== 404) {
          throw new Error('The two-client native fixture rejected the exact normal Stop.');
        }
        podRevision += 1;
        return {
          schemaVersion: 1,
          operationId: '60000000-0000-4000-8000-000000000000',
          podId: input.podId,
          disposition: deleted.status === 404 ? 'already_stopped' : 'stopped',
          observation: smokePodObservation(await exchange({ operation: 'runpod_list' }), podRevision),
          issue: null,
        };
      },
    },
    gpuSwitch: {
      load: unsupportedSwitch,
      authorizeForeground: unsupportedSwitch,
      begin: unsupportedSwitch,
      acquire: unsupportedSwitch,
      release: unsupportedSwitch,
      syncWorker: unsupportedSwitch,
      finalize: unsupportedSwitch,
      confirmTarget: unsupportedSwitch,
      deleteOld: unsupportedSwitch,
      prepareAttempt: unsupportedSwitch,
      confirmAttempt: unsupportedSwitch,
      createReplacement: unsupportedSwitch,
      confirmActualPrice: unsupportedSwitch,
      deleteReplacement: unsupportedSwitch,
      reconcileProvider: unsupportedSwitch,
      verifyReplacement: unsupportedSwitch,
      complete: unsupportedSwitch,
      cancel: unsupportedSwitch,
    },
    bindProfile: async () => undefined,
    authorizeStart: async () => undefined,
    clearStartAuthorization: async () => undefined,
    clearWorkerSession: async () => undefined,
    createMarkerMetadata: async () => ({
      pending: false,
      attemptId: null,
      podName: null,
      gpuId: null,
      podId: null,
    }),
    resolveCreateMarker: async () => undefined,
    chooseDestination: async (path) => ({ path, writable: true }),
    validateDestination: async (path) => ({ path, writable: true }),
    credentialMetadata: async () => ({
      runpodApiKey: { configured: true, suffix: 'K7P9', provider: 'Native smoke vault' },
      workerToken: { configured: true, suffix: 'F2M4', provider: 'Native smoke vault' },
    }),
    replaceCredential: async (_kind, value) => ({
      configured: true,
      suffix: value.slice(-4),
      provider: 'Native smoke vault',
    }),
    reconcileReceipts: async () => {
      counters.mutatingReceiptReconciliations += 1;
      throw new Error('The stale local receipt folder is unavailable on this installed client.');
    },
    readReceipts: async () => {
      counters.readOnlyReceiptReads += 1;
      if (role === 'B') {
        throw new Error('The stale local receipt folder is unavailable on this installed client.');
      }
      return [];
    },
    revealDestination: async () => undefined,
    writeManifest: async (batchId) => `${batchId}/manifest.csv`,
    fetchPreview: async () => ({
      contentType: 'image/webp',
      sha256: 'a'.repeat(64),
      sizeBytes: 12,
      bytes: [],
    }),
    downloadAsset: async () => null,
    downloadArtifact: async (input) => {
      if (role !== 'A') {
        throw new Error('The locked remote client must never download owner artifacts.');
      }
      counters.artifactDownloads += 1;
      return artifactReceipt(await exchange({
        operation: 'artifact_download',
        batch_id: input.batchId,
        index: input.index,
        expected_sha256: input.expectedSha256,
        expected_size_bytes: input.expectedSizeBytes,
        expected_width: input.expectedWidth,
        expected_height: input.expectedHeight,
      }));
    },
    status: async () => exchange({ operation: 'worker_status' }),
    createBatch: async (prompts, baseSeed) => exchange({
      operation: 'batch_create',
      prompt_count: prompts.length,
      base_seed: baseSeed,
    }),
    getBatch: async (batchId) => exchange({ operation: 'batch_get', batch_id: batchId }),
    pauseBatch: async () => localWorkerError('native_smoke_unused', 'Pause is not used by this smoke.'),
    resumeBatch: async () => localWorkerError('native_smoke_unused', 'Resume is not used by this smoke.'),
    cancelBatch: async () => localWorkerError('native_smoke_unused', 'Cancel is not used by this smoke.'),
    retryFailed: async () => localWorkerError('native_smoke_unused', 'Retry is not used by this smoke.'),
    studioHeartbeat: async (sessionId, availability) => exchange({
      operation: 'studio_heartbeat',
      session_id: sessionId,
      availability,
    }),
    studioStatus: async (sessionId) => exchange({
      operation: 'studio_status',
      session_id: sessionId,
    }),
    studioCreateStopRequest: async (requestId, sessionId, podId, gpuDisplayName) => exchange({
      operation: 'studio_create_stop',
      request_id: requestId,
      session_id: sessionId,
      pod_id: podId,
      gpu_display_name: gpuDisplayName,
    }),
    studioRespondToStopRequest: async (requestId, sessionId, decision) => exchange({
      operation: 'studio_respond',
      request_id: requestId,
      session_id: sessionId,
      decision,
    }),
    studioRespondToGpuSwitch: async () => localWorkerError(
      'native_smoke_unused',
      'GPU Switch consent is not used by the Task 012 two-client smoke.',
    ),
    studioCancelStopRequest: async (requestId, sessionId, podId, finalizationId) => exchange({
      operation: 'studio_cancel',
      request_id: requestId,
      session_id: sessionId,
      pod_id: podId,
      finalization_id: finalizationId,
    }),
  };

  return {
    port,
    counters,
    checkpoint: async (name) => successfulControlBody(
      await exchange({ operation: 'checkpoint', name }),
      `checkpoint ${name}`,
    ),
    audit: async () => successfulControlBody(await exchange({ operation: 'audit' }), 'the final audit'),
  };
}
