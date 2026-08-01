import { invoke } from '@tauri-apps/api/core';
import type { CredentialKind, CredentialMetadata, CredentialMetadataMap } from '../domain/types';

export const NATIVE_RUNPOD_API_KEY_SENTINEL = '__IMAGEFORGE_NATIVE_VAULT__';

export interface NativeErrorShape {
  code: string;
  message: string;
  retryable: boolean;
}

interface NativeCredentialMetadata extends CredentialMetadata {
  kind: CredentialKind;
}

export interface NativeDestinationMetadata {
  path: string;
  writable: boolean;
}

export interface NativeHttpResponse<T = unknown> {
  status: number;
  body: T;
}

interface NativeRunPodHttpResponse {
  status: number;
  body: string;
  retryAfter: string | null;
  contentType: string | null;
}

export interface NativeDownloadRequest {
  batchId: string;
  index: number;
  expectedSha256: string;
  expectedSizeBytes: number;
}

export interface NativeDownloadReceipt {
  schemaVersion: 1;
  batchId: string;
  index: number;
  filename: string;
  sha256: string;
  sizeBytes: number;
  verifiedAtUnixMs: number;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isNativeDesktop(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;
}

export function asNativeError(error: unknown): NativeErrorShape {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as Partial<NativeErrorShape>;
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return {
        code: candidate.code,
        message: candidate.message,
        retryable: candidate.retryable === true,
      };
    }
  }
  return {
    code: 'native_operation_failed',
    message: 'The native ImageForge operation could not be completed.',
    retryable: false,
  };
}

export async function nativeCredentialMetadata(): Promise<CredentialMetadataMap> {
  const entries = await invoke<NativeCredentialMetadata[]>('credential_metadata');
  const byKind = new Map(entries.map((entry) => [entry.kind, entry] as const));
  const runpodApiKey = byKind.get('runpodApiKey');
  const workerToken = byKind.get('workerToken');
  if (!runpodApiKey || !workerToken) {
    throw new Error('The native credential vault returned incomplete metadata.');
  }
  return { runpodApiKey, workerToken };
}

export function nativeReplaceCredential(
  kind: CredentialKind,
  value: string,
): Promise<CredentialMetadata> {
  return invoke<NativeCredentialMetadata>('replace_credential', { kind, value });
}

export function nativeChooseDestination(defaultPath: string): Promise<NativeDestinationMetadata | null> {
  return invoke<NativeDestinationMetadata | null>('choose_destination', { defaultPath });
}

export function nativeValidateDestination(path: string): Promise<NativeDestinationMetadata> {
  return invoke<NativeDestinationMetadata>('validate_destination', { path });
}

export function bindNativeWorkerSession(podId: string): Promise<void> {
  return invoke('bind_worker_session', { podId });
}

export function clearNativeWorkerSession(): Promise<void> {
  return invoke('clear_worker_session');
}

export function bindNativeRunPodProfile(templateId: string, networkVolumeId: string): Promise<void> {
  return invoke('bind_runpod_profile', { templateId, networkVolumeId });
}

export function nativeWorkerHealth(): Promise<NativeHttpResponse> {
  return invoke('worker_health');
}

export function nativeWorkerStatus(): Promise<NativeHttpResponse> {
  return invoke('worker_status');
}

export function nativeWorkerCreateBatch(prompts: string[], baseSeed: number): Promise<NativeHttpResponse> {
  return invoke('worker_create_batch', { input: { prompts, baseSeed } });
}

export function nativeWorkerGetBatch(batchId: string): Promise<NativeHttpResponse> {
  return invoke('worker_get_batch', { batchId });
}

export function nativeWorkerPauseBatch(batchId: string): Promise<NativeHttpResponse> {
  return invoke('worker_pause_batch', { batchId });
}

export function nativeWorkerResumeBatch(batchId: string): Promise<NativeHttpResponse> {
  return invoke('worker_resume_batch', { batchId });
}

export function nativeWorkerCancelBatch(batchId: string): Promise<NativeHttpResponse> {
  return invoke('worker_cancel_batch', { batchId });
}

export function nativeWorkerRetryFailed(batchId: string): Promise<NativeHttpResponse> {
  return invoke('worker_retry_failed', { batchId });
}

export function nativeDownloadArtifact(request: NativeDownloadRequest): Promise<NativeDownloadReceipt> {
  return invoke('download_artifact', { request });
}

function authorizationIsNativeSentinel(headers: Headers): boolean {
  return headers.get('authorization') === `Bearer ${NATIVE_RUNPOD_API_KEY_SENTINEL}`;
}

async function invokeRunPodTransport(url: URL, init: RequestInit): Promise<NativeRunPodHttpResponse> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (!authorizationIsNativeSentinel(headers)) {
    throw new Error('RunPod credentials must remain inside the native vault.');
  }

  if (url.hostname === 'api.runpod.io' && method === 'GET') {
    return invoke('runpod_inventory_http', { url: url.toString() });
  }
  if (url.hostname === 'rest.runpod.io' && url.pathname === '/v1/pods') {
    if (method === 'GET') return invoke('runpod_list_pods_http', { url: url.toString() });
    if (method === 'POST') {
      if (typeof init.body !== 'string') throw new Error('RunPod create body is missing.');
      return invoke('runpod_create_pod_http', {
        url: url.toString(),
        body: JSON.parse(init.body) as unknown,
      });
    }
  }
  if (url.hostname === 'rest.runpod.io' && url.pathname.startsWith('/v1/pods/')) {
    if (method === 'GET') return invoke('runpod_get_pod_http', { url: url.toString() });
    if (method === 'DELETE') return invoke('runpod_terminate_pod_http', { url: url.toString() });
  }
  throw new Error('RunPod request is outside the native ImageForge API surface.');
}

/** Fetch-compatible transport for the reviewed RunPod client package. It
 * carries only a sentinel through JS; the real API key is attached natively. */
export const nativeRunPodFetch: typeof fetch = async (input, init = {}) => {
  if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  const rawUrl = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
  const url = new URL(rawUrl);
  let result: NativeRunPodHttpResponse;
  try {
    result = await invokeRunPodTransport(url, init);
  } catch (error) {
    const safe = asNativeError(error);
    throw new Error(safe.message);
  }
  const headers = new Headers();
  if (result.contentType) headers.set('content-type', result.contentType);
  if (result.retryAfter) headers.set('retry-after', result.retryAfter);
  const body = [204, 205, 304].includes(result.status) ? null : result.body;
  return new Response(body, { status: result.status, headers });
};

const WORKER_PROXY_HOST = /^([A-Za-z0-9][A-Za-z0-9-]{1,62})-8000\.proxy\.runpod\.net$/;

/** Health-only fetch surface used by the RunPod readiness controller. The
 * lifecycle has already verified the managed Pod; this binds its derived ID to
 * the native worker session and performs the public health request natively. */
export const nativeWorkerHealthFetch: typeof fetch = async (input, init = {}) => {
  if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  const rawUrl = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
  const url = new URL(rawUrl);
  const match = WORKER_PROXY_HOST.exec(url.hostname);
  if (
    !match ||
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.pathname !== '/v1/health' ||
    url.search !== '' ||
    url.hash !== '' ||
    (init.method ?? 'GET').toUpperCase() !== 'GET'
  ) {
    throw new Error('Worker health is restricted to a derived RunPod proxy endpoint.');
  }
  await bindNativeWorkerSession(match[1]);
  const result = await nativeWorkerHealth();
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json' },
  });
};
