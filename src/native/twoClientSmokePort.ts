import { invoke } from '@tauri-apps/api/core';
import type { ProductionDesktopPort } from '../adapters/productionImageForgeAdapter';

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
  const runPodFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const exact = url.pathname.match(/\/pods\/([^/]+)$/);
    if (init?.method === 'DELETE') {
      if (exact === null) throw new Error('The native smoke rejected a non-exact RunPod DELETE.');
      return response(await exchange({ operation: 'runpod_delete', pod_id: decodeURIComponent(exact[1]) }));
    }
    if (exact !== null) {
      return response(await exchange({ operation: 'runpod_get', pod_id: decodeURIComponent(exact[1]) }));
    }
    if (/\/pods$/.test(url.pathname)) {
      return response(await exchange({ operation: 'runpod_list' }));
    }
    throw new Error(`The native smoke rejected an unexpected RunPod path: ${url.pathname}`);
  }) as typeof fetch;
  const workerHealthFetch = (async () => response(await exchange({ operation: 'worker_health' }))) as typeof fetch;

  const port: ProductionDesktopPort = {
    runPodFetch,
    workerHealthFetch,
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
    studioFinalizeStopRequest: async (requestId, sessionId, podId, finalizationId) => exchange({
      operation: 'studio_finalize',
      request_id: requestId,
      session_id: sessionId,
      pod_id: podId,
      finalization_id: finalizationId,
    }),
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
